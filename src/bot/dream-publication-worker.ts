import type { JsonEventLogger } from "../observability/contracts.js";
import type { StoredDreamPublication } from "../store.js";
import type { DreamPublicationsApi } from "../storage/dream-publications.js";
import { TELEGRAM_TEXT_LIMIT_UTF16 } from "./telegram-publication.js";
import type { TelegramBotApiPort } from "./runtime/grammy-adapters.js";
import {
  positiveSafeInteger,
  safeErrorCode,
  telegramErrorCode,
  telegramRetryAfterMs,
} from "./runtime/helpers.js";

export const DEFAULT_DREAM_PUBLICATION_SEND_TIMEOUT_MS = 30_000;
export const DREAM_PUBLICATION_IDLE_RETRY_MS = 30_000;
const DREAM_PUBLICATION_RETRY_INITIAL_MS = 5_000;
const DREAM_PUBLICATION_RETRY_MAX_MS = 15 * 60_000;

export type DreamPublicationWorkerResult =
  | { status: "idle"; retryAfterMs: number }
  | { status: "sent"; publicationId: string; telegramMessageId: number }
  | { status: "retryable"; publicationId: string; retryAfterMs: number }
  | { status: "failed"; publicationId: string }
  | { status: "lost_ack"; publicationId: string }
  | { status: "lease_lost"; publicationId: string };

export interface DreamPublicationWorkerOptions {
  store: DreamPublicationsApi;
  telegram: Pick<TelegramBotApiPort, "sendMessage">;
  workerId: string;
  allowedChatId: string;
  sendTimeoutMs?: number;
  logger?: JsonEventLogger;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/**
 * Bot-token owner for the one unthreaded Dream digest. The maintenance
 * process only creates rows; this worker takes the sole irreversible network
 * action. Any state ambiguity after send begins is fenced as lost_ack.
 */
export class DreamPublicationWorker {
  readonly #store: DreamPublicationsApi;
  readonly #telegram: Pick<TelegramBotApiPort, "sendMessage">;
  readonly #workerId: string;
  readonly #allowedChatId: string;
  readonly #sendTimeoutMs: number;
  readonly #logger: JsonEventLogger | undefined;
  readonly #now: () => number;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;

  constructor(options: DreamPublicationWorkerOptions) {
    if (!options.workerId.trim()) throw new TypeError("workerId must not be empty.");
    if (!options.allowedChatId.trim()) throw new TypeError("allowedChatId must not be empty.");
    const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_DREAM_PUBLICATION_SEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 5 * 60_000) {
      throw new RangeError("sendTimeoutMs must be an integer between 1 and 300000.");
    }
    this.#store = options.store;
    this.#telegram = options.telegram;
    this.#workerId = options.workerId.trim();
    this.#allowedChatId = options.allowedChatId.trim();
    this.#sendTimeoutMs = sendTimeoutMs;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
  }

  async runOnce(): Promise<DreamPublicationWorkerResult> {
    const nowMs = this.#now();
    const publication = this.#store.claimNextDreamPublication({
      chatId: this.#allowedChatId,
      workerId: this.#workerId,
      nowMs,
    });
    if (!publication) {
      return {
        status: "idle",
        retryAfterMs: idleRetryAfter(
          this.#store.getNextDreamPublicationDueAt(this.#allowedChatId),
          nowMs,
        ),
      };
    }

    if (publication.chatId !== this.#allowedChatId) {
      return this.#definitiveFailure(publication, "chat_scope_violation");
    }
    if (!isValidTelegramText(publication.plainText)) {
      return this.#definitiveFailure(publication, "invalid_plain_text");
    }

    const controller = new AbortController();
    const timedOut = Symbol("dream_publication_timeout");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timeoutHandle = this.#setTimeout(() => {
          controller.abort();
          resolve(timedOut);
        }, this.#sendTimeoutMs);
      });
      const outcome = await Promise.race([
        this.#telegram.sendMessage(
          publication.chatId,
          publication.plainText,
          undefined,
          controller.signal,
        ),
        timeout,
      ]);
      if (outcome === timedOut) {
        return this.#lostAck(publication, "send_timeout");
      }
      const rejection = telegramRejection(outcome);
      if (rejection !== undefined) {
        return rejection.retryable
          ? this.#retryableFailure(publication, rejection.code, rejection.retryAfterMs)
          : this.#definitiveFailure(publication, rejection.code);
      }
      const telegramMessageId = positiveSafeInteger(
        isRecord(outcome) ? outcome.message_id : undefined,
      );
      if (telegramMessageId === undefined) {
        return this.#lostAck(publication, "malformed_success_ack");
      }
      try {
        if (!this.#store.markDreamPublicationSent({
          id: publication.id,
          workerId: this.#workerId,
          telegramMessageId,
          nowMs: this.#now(),
        })) {
          return this.#lostAck(publication, "sent_transition_refused");
        }
      } catch {
        return this.#lostAck(publication, "sent_transition_failed");
      }
      this.#log("info", "bot.dream_publication.sent", {
        publicationId: publication.id,
        attempts: publication.attempts,
        telegramMessageId,
      });
      return { status: "sent", publicationId: publication.id, telegramMessageId };
    } catch (error) {
      const rejection = telegramRejection(error);
      if (rejection !== undefined) {
        return rejection.retryable
          ? this.#retryableFailure(publication, rejection.code, rejection.retryAfterMs)
          : this.#definitiveFailure(publication, rejection.code);
      }
      return this.#lostAck(publication, `send_ambiguous:${safeErrorCode(error)}`);
    } finally {
      if (timeoutHandle !== undefined) this.#clearTimeout(timeoutHandle);
    }
  }

  #retryableFailure(
    publication: StoredDreamPublication,
    code: string,
    retryAfterMs: number | undefined,
  ): DreamPublicationWorkerResult {
    const nowMs = this.#now();
    const delayMs = retryAfterMs ?? retryBackoffMs(publication.attempts);
    try {
      const stored = this.#store.markDreamPublicationRetryableFailure({
        id: publication.id,
        workerId: this.#workerId,
        error: code,
        retryNotBeforeMs: nowMs + delayMs,
        nowMs,
      });
      if (!stored) return this.#leaseLost(publication, "retry_transition_refused");
      if (stored.status === "failed") {
        this.#log("warn", "bot.dream_publication.failed", {
          publicationId: publication.id,
          attempts: publication.attempts,
          code,
        });
        return { status: "failed", publicationId: publication.id };
      }
      this.#log("warn", "bot.dream_publication.retry_scheduled", {
        publicationId: publication.id,
        attempts: publication.attempts,
        code,
        retryAfterMs: delayMs,
      });
      return { status: "retryable", publicationId: publication.id, retryAfterMs: delayMs };
    } catch {
      return this.#lostAck(publication, "retry_transition_failed");
    }
  }

  #definitiveFailure(
    publication: StoredDreamPublication,
    code: string,
  ): DreamPublicationWorkerResult {
    try {
      if (!this.#store.markDreamPublicationDefinitiveFailure({
        id: publication.id,
        workerId: this.#workerId,
        error: code,
        nowMs: this.#now(),
      })) {
        return this.#leaseLost(publication, "failure_transition_refused");
      }
    } catch {
      return this.#lostAck(publication, "failure_transition_failed");
    }
    this.#log("warn", "bot.dream_publication.failed", {
      publicationId: publication.id,
      attempts: publication.attempts,
      code,
    });
    return { status: "failed", publicationId: publication.id };
  }

  #lostAck(
    publication: StoredDreamPublication,
    code: string,
  ): DreamPublicationWorkerResult {
    try {
      const changed = this.#store.markDreamPublicationLostAck({
        id: publication.id,
        workerId: this.#workerId,
        error: code,
        nowMs: this.#now(),
      });
      if (!changed) return this.#leaseLost(publication, "lost_ack_transition_refused");
    } catch {
      this.#log("error", "bot.dream_publication.lost_ack_transition_failed", {
        publicationId: publication.id,
        attempts: publication.attempts,
      });
      return { status: "lost_ack", publicationId: publication.id };
    }
    this.#log("warn", "bot.dream_publication.lost_ack", {
      publicationId: publication.id,
      attempts: publication.attempts,
      code,
    });
    return { status: "lost_ack", publicationId: publication.id };
  }

  #leaseLost(
    publication: StoredDreamPublication,
    code: string,
  ): DreamPublicationWorkerResult {
    this.#log("warn", "bot.dream_publication.lease_lost", {
      publicationId: publication.id,
      attempts: publication.attempts,
      code,
    });
    return { status: "lease_lost", publicationId: publication.id };
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    this.#logger?.[level]({ event, ...fields });
  }
}

function isValidTelegramText(value: string): boolean {
  return value.trim().length > 0 && value.length <= TELEGRAM_TEXT_LIMIT_UTF16;
}

function idleRetryAfter(dueAtMs: number | undefined, nowMs: number): number {
  if (dueAtMs === undefined) return DREAM_PUBLICATION_IDLE_RETRY_MS;
  return Math.min(
    DREAM_PUBLICATION_IDLE_RETRY_MS,
    Math.max(1, dueAtMs - nowMs),
  );
}

function retryBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(16, attempts - 1));
  return Math.min(
    DREAM_PUBLICATION_RETRY_MAX_MS,
    DREAM_PUBLICATION_RETRY_INITIAL_MS * 2 ** exponent,
  );
}

function telegramRejection(value: unknown): {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
} | undefined {
  const errorCode = telegramErrorCode(value);
  if (errorCode === undefined) return undefined;
  const retryable = errorCode === 429 || (errorCode >= 500 && errorCode <= 599);
  return {
    code: `TELEGRAM_${String(errorCode)}`,
    retryable,
    ...(retryable && telegramRetryAfterMs(value) !== undefined
      ? { retryAfterMs: telegramRetryAfterMs(value) }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
