import type { JsonEventLogger } from "../worker.js";
import type { BotUpdateProcessor } from "./update-processor.js";
import { abortableSleep, assertBotIdentity, boundedInteger, BotRuntimeProtocolError, BotRuntimeStopError, compact, isFatalPollingError, normalizeExpectedUsername, positiveTelegramId, safeErrorCode, telegramErrorCode, telegramRetryAfterMs, updateBatch, updateIdentifier } from "./helpers.js";

const OFFSET_CONFIRMATION_TIMEOUT_MS = 5_000;
const ALLOWED_UPDATES = ["message", "edited_message"] as const;
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export interface TelegramLongPollingApiPort {
  getMe(signal: AbortSignal): Promise<unknown>;
  deleteWebhook(
    options: { drop_pending_updates: false },
    signal: AbortSignal,
  ): Promise<unknown>;
  getUpdates(
    options: {
      offset?: number;
      limit: number;
      timeout: number;
      allowed_updates: readonly ("message" | "edited_message")[];
    },
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface BotApiLongPollerOptions {
  api: TelegramLongPollingApiPort;
  processor: BotUpdateProcessor;
  expectedBotId: string;
  expectedBotUsername: string;
  initialOffset?: number;
  pollTimeoutSec?: number;
  pollLimit?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  logger?: JsonEventLogger;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Small, sequential long poller with explicit offset ownership. Merely
 * receiving a batch never advances the offset; only a processor result backed
 * by committed SQLite state can do that.
 */
export class BotApiLongPoller {
  readonly #api: TelegramLongPollingApiPort;
  readonly #processor: BotUpdateProcessor;
  readonly #expectedBotId: string;
  readonly #expectedBotUsername: string;
  readonly #pollTimeoutSec: number;
  readonly #pollLimit: number;
  readonly #backoffInitialMs: number;
  readonly #backoffMaxMs: number;
  readonly #logger: JsonEventLogger | undefined;
  readonly #sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  #controller: AbortController | undefined;
  #running = false;
  #stopRequested = false;
  #nextOffset: number | undefined;

  constructor(options: BotApiLongPollerOptions) {
    this.#api = options.api;
    this.#processor = options.processor;
    this.#expectedBotId = positiveTelegramId(
      options.expectedBotId,
      "expectedBotId",
    );
    this.#expectedBotUsername = normalizeExpectedUsername(
      options.expectedBotUsername,
    );
    this.#nextOffset =
      options.initialOffset === undefined
        ? undefined
        : boundedInteger(
            options.initialOffset,
            0,
            Number.MAX_SAFE_INTEGER - 1,
            "initialOffset",
          );
    this.#pollTimeoutSec = boundedInteger(
      options.pollTimeoutSec ?? 30,
      1,
      50,
      "pollTimeoutSec",
    );
    this.#pollLimit = boundedInteger(
      options.pollLimit ?? 100,
      1,
      100,
      "pollLimit",
    );
    this.#backoffInitialMs = boundedInteger(
      options.backoffInitialMs ?? 1_000,
      10,
      60_000,
      "backoffInitialMs",
    );
    this.#backoffMaxMs = boundedInteger(
      options.backoffMaxMs ?? 30_000,
      this.#backoffInitialMs,
      5 * 60_000,
      "backoffMaxMs",
    );
    this.#logger = options.logger;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  get running(): boolean {
    return this.#running;
  }

  get nextOffset(): number | undefined {
    return this.#nextOffset;
  }

  async run(
    signal?: AbortSignal,
    onReady?: () => void,
  ): Promise<void> {
    if (this.#running) {
      throw new Error("BotApiLongPoller is already running.");
    }
    if (signal?.aborted) {
      return;
    }
    this.#running = true;
    this.#stopRequested = false;
    const controller = new AbortController();
    this.#controller = controller;
    const forwardAbort = (): void => this.requestStop();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    let initialized = false;
    let lastHeartbeatMs = Date.now();
    try {
      await this.#initialize(controller.signal);
      initialized = true;
      let ready = false;
      let backoffMs = this.#backoffInitialMs;
      while (!this.#stopRequested) {
        let batch: unknown;
        try {
          batch = await this.#api.getUpdates(
            {
              ...(this.#nextOffset === undefined
                ? {}
                : { offset: this.#nextOffset }),
              limit: this.#pollLimit,
              timeout: this.#pollTimeoutSec,
              allowed_updates: ALLOWED_UPDATES,
            },
            controller.signal,
          );
        } catch (error) {
          if (this.#stopRequested || controller.signal.aborted) {
            break;
          }
          if (isFatalPollingError(error)) {
            throw new BotRuntimeProtocolError(
              `POLL_FATAL_${telegramErrorCode(error) ?? "UNKNOWN"}`,
            );
          }
          const retryAfterMs =
            telegramRetryAfterMs(error) ??
            backoffMs;
          this.#log("warn", "bot.poll.retry", {
            code: safeErrorCode(error),
            retryAfterMs,
          });
          await this.#sleep(retryAfterMs, controller.signal);
          backoffMs = Math.min(
            this.#backoffMaxMs,
            Math.max(this.#backoffInitialMs, backoffMs * 2),
          );
          continue;
        }

        backoffMs = this.#backoffInitialMs;
        if (!ready && !this.#stopRequested) {
          onReady?.();
          ready = true;
        }
        const updates = updateBatch(batch);
        let retryCurrentUpdate = false;
        for (const update of updates) {
          if (this.#stopRequested) {
            break;
          }
          const updateId = updateIdentifier(update);
          if (updateId === undefined) {
            throw new BotRuntimeProtocolError("POLL_BATCH_UPDATE_ID_MISSING");
          }
          if (
            this.#nextOffset !== undefined &&
            updateId < this.#nextOffset
          ) {
            throw new BotRuntimeProtocolError("POLL_BATCH_OFFSET_REGRESSION");
          }

          try {
            const processed = this.#processor.process(update);
            if (!processed.acknowledged) {
              retryCurrentUpdate = true;
              break;
            }
            if (processed.ackUpdateId !== updateId) {
              throw new BotRuntimeProtocolError("ACK_UPDATE_ID_MISMATCH");
            }
            if (updateId === Number.MAX_SAFE_INTEGER) {
              throw new BotRuntimeProtocolError("UPDATE_ID_OVERFLOW");
            }
            this.#nextOffset = updateId + 1;
          } catch (error) {
            if (error instanceof BotRuntimeProtocolError) {
              throw error;
            }
            this.#log("error", "bot.update.retry", {
              updateId,
              code: safeErrorCode(error),
            });
            retryCurrentUpdate = true;
            break;
          }
        }
        if (retryCurrentUpdate && !this.#stopRequested) {
          await this.#sleep(backoffMs, controller.signal);
          backoffMs = Math.min(this.#backoffMaxMs, backoffMs * 2);
        }
        const heartbeatNow = Date.now();
        if (heartbeatNow - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
          lastHeartbeatMs = heartbeatNow;
          this.#log("info", "bot.heartbeat", {
            nextOffset: this.#nextOffset,
          });
        }
      }
    } catch (error) {
      if (!this.#stopRequested) {
        throw error;
      }
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      if (initialized && this.#stopRequested) {
        await this.#confirmCommittedOffset();
      }
      this.#running = false;
      this.#controller = undefined;
    }
  }

  requestStop(): void {
    this.#stopRequested = true;
    this.#controller?.abort(new BotRuntimeStopError());
  }

  async #initialize(signal: AbortSignal): Promise<void> {
    const identity = await this.#api.getMe(signal);
    assertBotIdentity(
      identity,
      this.#expectedBotId,
      this.#expectedBotUsername,
    );
    const deleted = await this.#api.deleteWebhook(
      { drop_pending_updates: false },
      signal,
    );
    if (deleted !== true) {
      throw new BotRuntimeProtocolError("DELETE_WEBHOOK_NOT_CONFIRMED");
    }
    this.#log("info", "bot.poll.started", {
      botId: this.#expectedBotId,
      botUsername: this.#expectedBotUsername,
      ...(this.#nextOffset === undefined
        ? {}
        : { initialOffset: this.#nextOffset }),
    });
  }

  async #confirmCommittedOffset(): Promise<void> {
    if (this.#nextOffset === undefined) {
      return;
    }
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(
        new BotRuntimeProtocolError("OFFSET_CONFIRMATION_TIMEOUT"),
      );
    }, OFFSET_CONFIRMATION_TIMEOUT_MS);
    try {
      await this.#api.getUpdates(
        {
          offset: this.#nextOffset,
          limit: 1,
          timeout: 0,
          allowed_updates: ALLOWED_UPDATES,
        },
        controller.signal,
      );
      this.#log("info", "bot.poll.offset_confirmed", {
        nextOffset: this.#nextOffset,
      });
    } catch (error) {
      this.#log("warn", "bot.poll.offset_confirmation_failed", {
        nextOffset: this.#nextOffset,
        code: safeErrorCode(error),
      });
      // Redelivery is safe because update ingestion is idempotent.
    } finally {
      clearTimeout(timeoutHandle);
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
      // Logging cannot alter polling or ACK state.
    }
  }
}
