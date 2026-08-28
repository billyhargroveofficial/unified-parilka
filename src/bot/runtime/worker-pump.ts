import type { BotTurnWorker, BotTurnWorkerResult, JsonEventLogger } from "../worker.js";
import type { BotWorkNotifier } from "./contracts.js";
import { MAX_BOT_WORKER_CONCURRENCY } from "./contracts.js";
import { boundedInteger, compact, safeErrorCode } from "./helpers.js";

export interface BotWorkerPort {
  runOnce(): Promise<BotTurnWorkerResult>;
}

export interface BotWorkerPumpOptions {
  workers: readonly BotWorkerPort[];
  logger?: JsonEventLogger;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface BotWorkerDrainResult {
  drained: boolean;
  activeWorkers: number;
}

/**
 * Event-driven worker pump. It performs no idle polling and never invokes one
 * worker instance concurrently with itself. A successful/terminal turn causes
 * one extra probe round so a durable FIFO backlog is drained.
 */
export class BotWorkerPump implements BotWorkNotifier {
  readonly #slots: Array<{ worker: BotWorkerPort; busy: boolean }>;
  readonly #logger: JsonEventLogger | undefined;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;
  readonly #idleWaiters = new Set<() => void>();
  #state: "stopped" | "running" | "draining" = "stopped";
  #workHint = false;
  #unhandledFailures = 0;
  #retryWakeup: ReturnType<typeof setTimeout> | undefined;
  #retryWakeAtMs: number | undefined;

  constructor(options: BotWorkerPumpOptions) {
    if (
      options.workers.length < 1 ||
      options.workers.length > MAX_BOT_WORKER_CONCURRENCY
    ) {
      throw new RangeError(
        `workers must contain between 1 and ${MAX_BOT_WORKER_CONCURRENCY} instances.`,
      );
    }
    this.#slots = options.workers.map((worker) => ({
      worker,
      busy: false,
    }));
    this.#logger = options.logger;
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
  }

  get activeWorkers(): number {
    return this.#slots.filter((slot) => slot.busy).length;
  }

  start(): void {
    if (this.#state !== "stopped") {
      return;
    }
    this.#state = "running";
    this.#unhandledFailures = 0;
    this.#clearRetryWakeup();
    this.#workHint = true;
    this.#kick();
  }

  notify(): void {
    if (this.#state === "stopped") {
      this.#workHint = true;
      return;
    }
    this.#workHint = true;
    this.#kick();
  }

  async drain(timeoutMs: number): Promise<BotWorkerDrainResult> {
    boundedInteger(timeoutMs, 1, 15 * 60_000, "timeoutMs");
    if (this.#state === "stopped") {
      return { drained: true, activeWorkers: 0 };
    }
    this.#state = "draining";
    this.#workHint = true;
    this.#kick();
    const becameIdle = await this.#waitUntilIdle(timeoutMs);
    const drained = becameIdle && this.#unhandledFailures === 0;
    this.#state = "stopped";
    this.#workHint = false;
    this.#clearRetryWakeup();
    return {
      drained,
      activeWorkers: this.activeWorkers,
    };
  }

  async stop(timeoutMs: number): Promise<BotWorkerDrainResult> {
    boundedInteger(timeoutMs, 1, 15 * 60_000, "timeoutMs");
    this.#state = "stopped";
    this.#workHint = false;
    this.#clearRetryWakeup();
    return {
      drained:
        (await this.#waitUntilIdle(timeoutMs)) &&
        this.#unhandledFailures === 0,
      activeWorkers: this.activeWorkers,
    };
  }

  #kick(): void {
    if (this.#state === "stopped" || !this.#workHint) {
      this.#settleIdleWaiters();
      return;
    }
    this.#workHint = false;
    for (const slot of this.#slots) {
      if (!slot.busy) {
        this.#runSlot(slot);
      }
    }
  }

  #runSlot(slot: { worker: BotWorkerPort; busy: boolean }): void {
    slot.busy = true;
    void Promise.resolve()
      .then(() => slot.worker.runOnce())
      .then((result) => {
        if (
          result.status === "idle" &&
          result.retryAfterMs != null
        ) {
          this.#scheduleRetryWakeup(result.retryAfterMs);
        }
        if (
          result.status !== "idle" &&
          result.status !== "capacity"
        ) {
          this.#workHint = true;
        }
      })
      .catch((error: unknown) => {
        this.#unhandledFailures += 1;
        this.#log("error", "bot.worker.unhandled", {
          code: safeErrorCode(error),
        });
      })
      .finally(() => {
        slot.busy = false;
        this.#kick();
        this.#settleIdleWaiters();
      });
  }

  #scheduleRetryWakeup(delayMs: number): void {
    if (
      this.#state !== "running" ||
      !Number.isSafeInteger(delayMs) ||
      delayMs < 1
    ) {
      return;
    }
    const boundedDelayMs = Math.min(delayMs, 15 * 60_000);
    const wakeAtMs = Date.now() + boundedDelayMs;
    if (
      this.#retryWakeAtMs != null &&
      this.#retryWakeAtMs <= wakeAtMs
    ) {
      return;
    }
    this.#clearRetryWakeup();
    this.#retryWakeAtMs = wakeAtMs;
    this.#retryWakeup = this.#setTimeout(() => {
      this.#retryWakeup = undefined;
      this.#retryWakeAtMs = undefined;
      if (this.#state === "running") {
        this.notify();
      }
    }, boundedDelayMs);
  }

  #clearRetryWakeup(): void {
    if (this.#retryWakeup !== undefined) {
      this.#clearTimeout(this.#retryWakeup);
    }
    this.#retryWakeup = undefined;
    this.#retryWakeAtMs = undefined;
  }

  async #waitUntilIdle(timeoutMs: number): Promise<boolean> {
    if (this.activeWorkers === 0 && !this.#workHint) {
      return true;
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let waiter: (() => void) | undefined;
    const idle = new Promise<true>((resolve) => {
      waiter = () => resolve(true);
      this.#idleWaiters.add(waiter);
    });
    const timeout = new Promise<false>((resolve) => {
      timeoutHandle = this.#setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([idle, timeout]);
    if (waiter) {
      this.#idleWaiters.delete(waiter);
    }
    if (timeoutHandle !== undefined) {
      this.#clearTimeout(timeoutHandle);
    }
    return result;
  }

  #settleIdleWaiters(): void {
    if (this.activeWorkers !== 0 || this.#workHint) {
      return;
    }
    for (const waiter of [...this.#idleWaiters]) {
      this.#idleWaiters.delete(waiter);
      waiter();
    }
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...compact(fields) });
    } catch {
      // Observability never controls worker admission.
    }
  }
}

export type BotWorkerFactory = (
  workerId: string,
) => Pick<BotTurnWorker, "runOnce">;

export function createBotWorkerPump(
  concurrency: number,
  factory: BotWorkerFactory,
  logger?: JsonEventLogger,
): BotWorkerPump {
  boundedInteger(
    concurrency,
    1,
    MAX_BOT_WORKER_CONCURRENCY,
    "concurrency",
  );
  return new BotWorkerPump({
    workers: Array.from({ length: concurrency }, (_unused, index) =>
      factory(`bot-worker-${index + 1}`),
    ),
    ...(logger === undefined ? {} : { logger }),
  });
}
