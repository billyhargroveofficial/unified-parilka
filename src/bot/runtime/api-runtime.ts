import type { JsonEventLogger } from "../worker.js";
import type { BotApiLongPoller } from "./long-poller.js";
import type { BotWorkerDrainResult, BotWorkerPump } from "./worker-pump.js";
import type { TypingLeaseManager } from "../typing.js";
import { boundedInteger, compact } from "./helpers.js";

export interface BotApiRuntimeOptions {
  poller: BotApiLongPoller;
  workers: BotWorkerPump;
  /** Independent low-volume sender; it must never occupy a user-turn slot. */
  maintenanceWorkers?: BotWorkerPump;
  /** Stops queue-held chat-action timers after active workers drain. */
  typingLeases?: Pick<TypingLeaseManager, "stopAll">;
  shutdownTimeoutMs?: number;
  logger?: JsonEventLogger;
}

export class BotApiRuntime {
  readonly #poller: BotApiLongPoller;
  readonly #workers: BotWorkerPump;
  readonly #maintenanceWorkers: BotWorkerPump | undefined;
  readonly #typingLeases: Pick<TypingLeaseManager, "stopAll"> | undefined;
  readonly #shutdownTimeoutMs: number;
  readonly #logger: JsonEventLogger | undefined;

  constructor(options: BotApiRuntimeOptions) {
    this.#poller = options.poller;
    this.#workers = options.workers;
    this.#maintenanceWorkers = options.maintenanceWorkers;
    this.#typingLeases = options.typingLeases;
    this.#shutdownTimeoutMs = boundedInteger(
      options.shutdownTimeoutMs ?? 180_000,
      1_000,
      15 * 60_000,
      "shutdownTimeoutMs",
    );
    this.#logger = options.logger;
  }

  async run(signal?: AbortSignal): Promise<BotWorkerDrainResult> {
    let pollError: unknown;
    try {
      await this.#poller.run(signal, () => {
        this.#workers.start();
        this.#maintenanceWorkers?.start();
      });
    } catch (error) {
      pollError = error;
    } finally {
      this.#poller.requestStop();
    }
    // Queued turns are already durable. Graceful shutdown stops admission and
    // waits only for in-flight workers; it does not begin fresh model calls
    // while systemd is counting down the termination deadline.
    let drained: BotWorkerDrainResult;
    try {
      const [turns, maintenance] = await Promise.all([
        this.#workers.stop(this.#shutdownTimeoutMs),
        this.#maintenanceWorkers?.stop(this.#shutdownTimeoutMs) ??
          Promise.resolve({ drained: true, activeWorkers: 0 }),
      ]);
      drained = {
        drained: turns.drained && maintenance.drained,
        activeWorkers: turns.activeWorkers + maintenance.activeWorkers,
      };
    } finally {
      this.#typingLeases?.stopAll();
    }
    this.#log(
      drained.drained ? "info" : "error",
      drained.drained ? "bot.runtime.stopped" : "bot.runtime.drain_timeout",
      { activeWorkers: drained.activeWorkers },
    );
    if (pollError !== undefined) {
      throw pollError;
    }
    return drained;
  }

  requestStop(): void {
    this.#poller.requestStop();
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...compact(fields) });
    } catch {
      // Logging is best-effort during shutdown.
    }
  }
}
