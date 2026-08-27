import {
  DEFAULT_DREAM_PUBLICATION_MAX_ATTEMPTS,
  DREAM_PUBLICATION_RESTART_LOST_ACK_ERROR,
  MAX_DREAM_PUBLICATION_ATTEMPTS,
} from "./constants.js";
import { rowToStoredDreamPublication } from "./mappers.js";
import { StoreCore } from "./core.js";
import type { StoredDreamPublication } from "./types.js";
import {
  assertNonEmptyBounded,
  assertPositiveSafeInteger,
  assertTimestamp,
} from "./validation.js";

export const MAX_DREAM_PUBLICATION_MARKDOWN_BYTES = 32_768;
export const MAX_DREAM_PUBLICATION_PLAIN_BYTES = 32_768;
const MAX_DREAM_PUBLICATION_ID_CHARS = 128;
const MAX_DREAM_PUBLICATION_DEDUPE_KEY_CHARS = 256;
const MAX_DREAM_PUBLICATION_ERROR_CHARS = 512;
const MAX_DREAM_PUBLICATION_WORKER_ID_CHARS = 128;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const WORKER_ID = /^[A-Za-z0-9_.:-]+$/u;

export type EnqueueDreamPublicationInput = {
  id: string;
  dedupeKey: string;
  payloadHash: string;
  chatId: string;
  markdown: string;
  plainText: string;
  maxAttempts?: number;
  nowMs?: number;
};

/**
 * SQLite-only owner for unthreaded Dream publication. It deliberately knows
 * neither the Bot API nor a model: maintenance can enqueue with no bot token,
 * and the bot later claims it through a strict delivery fence.
 */
export abstract class DreamPublicationsMethods extends StoreCore {
  enqueueDreamPublication(input: EnqueueDreamPublicationInput): StoredDreamPublication {
    return this.immediateTransaction("enqueueDreamPublication", () =>
      this.enqueueDreamPublicationLocked(input),
    );
  }

  protected enqueueDreamPublicationLocked(
    input: EnqueueDreamPublicationInput,
  ): StoredDreamPublication {
    const validated = validateEnqueue(input);
    const existing = this.getDreamPublicationByDedupeKeyLocked(
      validated.dedupeKey,
    );
    if (existing) {
      if (
        existing.payloadHash !== validated.payloadHash ||
        existing.chatId !== validated.chatId ||
        existing.markdown !== validated.markdown ||
        existing.plainText !== validated.plainText
      ) {
        throw new Error(
          "Dream publication dedupeKey is already bound to a different immutable payload.",
        );
      }
      return existing;
    }
    this.db
      .prepare(
        `INSERT INTO bot_dream_publications (
           id, dedupe_key, payload_hash, chat_id, markdown, plain_text,
           status, attempts, max_attempts, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(
        validated.id,
        validated.dedupeKey,
        validated.payloadHash,
        validated.chatId,
        validated.markdown,
        validated.plainText,
        validated.maxAttempts,
        validated.nowMs,
        validated.nowMs,
      );
    const created = this.getDreamPublicationLocked(validated.id);
    if (!created) throw new Error("Dream publication disappeared after enqueue.");
    return created;
  }

  getDreamPublication(id: string): StoredDreamPublication | undefined {
    assertPublicationId(id);
    return this.getDreamPublicationLocked(id);
  }

  getDreamPublicationByDedupeKey(
    dedupeKey: string,
  ): StoredDreamPublication | undefined {
    assertDedupeKey(dedupeKey);
    return this.getDreamPublicationByDedupeKeyLocked(dedupeKey.trim());
  }

  /** Atomically assigns one due item to the bot sender. */
  claimNextDreamPublication(input: {
    chatId: string;
    workerId: string;
    nowMs?: number;
  }): StoredDreamPublication | undefined {
    const chatId = normalizedChatId(input.chatId);
    const workerId = normalizedWorkerId(input.workerId);
    const nowMs = input.nowMs ?? Date.now();
    assertTimestamp(nowMs, "nowMs");
    return this.immediateTransaction("claimNextDreamPublication", () => {
      const candidate = this.db
        .prepare(
          `SELECT id
           FROM bot_dream_publications
           WHERE chat_id = ?
             AND status = 'queued'
             AND attempts < max_attempts
             AND created_at_ms <= ?
             AND (retry_not_before_ms IS NULL OR retry_not_before_ms <= ?)
           ORDER BY created_at_ms ASC, id ASC
           LIMIT 1`,
        )
        .get(chatId, nowMs, nowMs) as Record<string, unknown> | undefined;
      if (!candidate) return undefined;
      const id = String(candidate.id);
      const claimed = this.db
        .prepare(
          `UPDATE bot_dream_publications
           SET status = 'sending', attempts = attempts + 1, lease_owner = ?,
               retry_not_before_ms = NULL, sending_at_ms = ?, updated_at_ms = ?, error = NULL
           WHERE id = ? AND status = 'queued' AND attempts < max_attempts
             AND created_at_ms <= ?
             AND (retry_not_before_ms IS NULL OR retry_not_before_ms <= ?)`,
        )
        .run(workerId, nowMs, nowMs, id, nowMs, nowMs);
      if (claimed.changes === 0) return undefined;
      return this.getDreamPublicationLocked(id);
    });
  }

  markDreamPublicationSent(input: {
    id: string;
    workerId: string;
    telegramMessageId: number;
    nowMs?: number;
  }): boolean {
    assertPublicationId(input.id);
    const workerId = normalizedWorkerId(input.workerId);
    assertPositiveSafeInteger(input.telegramMessageId, "telegramMessageId");
    const nowMs = input.nowMs ?? Date.now();
    assertTimestamp(nowMs, "nowMs");
    return this.writeWithRetry("markDreamPublicationSent", () =>
      this.db
        .prepare(
          `UPDATE bot_dream_publications
           SET status = 'sent', lease_owner = NULL, telegram_message_id = ?,
               sent_at_ms = ?, completed_at_ms = ?, updated_at_ms = ?, error = NULL
           WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
        )
        .run(input.telegramMessageId, nowMs, nowMs, nowMs, input.id, workerId)
        .changes > 0,
    );
  }

  /**
   * A definitive pre-ACK Telegram rejection can retry. Once its bounded
   * attempt budget is exhausted, it becomes terminal `failed`.
   */
  markDreamPublicationRetryableFailure(input: {
    id: string;
    workerId: string;
    error: string;
    retryNotBeforeMs: number;
    nowMs?: number;
  }): StoredDreamPublication | undefined {
    assertPublicationId(input.id);
    const workerId = normalizedWorkerId(input.workerId);
    const error = normalizedError(input.error);
    const nowMs = input.nowMs ?? Date.now();
    assertTimestamp(nowMs, "nowMs");
    assertTimestamp(input.retryNotBeforeMs, "retryNotBeforeMs");
    if (input.retryNotBeforeMs < nowMs) {
      throw new Error("retryNotBeforeMs must not be before nowMs.");
    }
    return this.immediateTransaction("markDreamPublicationRetryableFailure", () => {
      const changed = this.db
        .prepare(
          `UPDATE bot_dream_publications
           SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
               lease_owner = NULL,
               retry_not_before_ms = CASE WHEN attempts >= max_attempts THEN NULL ELSE ? END,
               error = ?, updated_at_ms = ?,
               completed_at_ms = CASE WHEN attempts >= max_attempts THEN ? ELSE NULL END
           WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
        )
        .run(input.retryNotBeforeMs, error, nowMs, nowMs, input.id, workerId);
      return changed.changes > 0 ? this.getDreamPublicationLocked(input.id) : undefined;
    });
  }

  /** A timeout/network ambiguity must never be re-queued automatically. */
  markDreamPublicationLostAck(input: {
    id: string;
    workerId: string;
    error: string;
    nowMs?: number;
  }): boolean {
    assertPublicationId(input.id);
    const workerId = normalizedWorkerId(input.workerId);
    const error = normalizedError(input.error);
    const nowMs = input.nowMs ?? Date.now();
    assertTimestamp(nowMs, "nowMs");
    return this.writeWithRetry("markDreamPublicationLostAck", () =>
      this.db
        .prepare(
          `UPDATE bot_dream_publications
           SET status = 'lost_ack', lease_owner = NULL, error = ?,
               completed_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
        )
        .run(error, nowMs, nowMs, input.id, workerId)
        .changes > 0,
    );
  }

  /** A definitive non-retryable pre-ACK rejection is terminal, not ambiguous. */
  markDreamPublicationDefinitiveFailure(input: {
    id: string;
    workerId: string;
    error: string;
    nowMs?: number;
  }): boolean {
    assertPublicationId(input.id);
    const workerId = normalizedWorkerId(input.workerId);
    const error = normalizedError(input.error);
    const nowMs = input.nowMs ?? Date.now();
    assertTimestamp(nowMs, "nowMs");
    return this.writeWithRetry("markDreamPublicationDefinitiveFailure", () =>
      this.db
        .prepare(
          `UPDATE bot_dream_publications
           SET status = 'failed', lease_owner = NULL, error = ?,
               retry_not_before_ms = NULL, completed_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
        )
        .run(error, nowMs, nowMs, input.id, workerId)
        .changes > 0,
    );
  }

  /** Returns the next queued publication's due time, including immediately due work. */
  getNextDreamPublicationDueAt(chatId: string): number | undefined {
    const normalized = normalizedChatId(chatId);
    const row = this.db
      .prepare(
        `SELECT MIN(COALESCE(retry_not_before_ms, created_at_ms)) AS due_at_ms
         FROM bot_dream_publications
         WHERE chat_id = ? AND status = 'queued' AND attempts < max_attempts`,
      )
      .get(normalized) as Record<string, unknown> | undefined;
    return row?.due_at_ms == null ? undefined : Number(row.due_at_ms);
  }

  /** Startup is the one safe recovery point for an interrupted sender. */
  reconcileDreamPublicationsOnStartup(nowMs = Date.now()): number {
    assertTimestamp(nowMs, "nowMs");
    return this.immediateTransaction("reconcileDreamPublicationsOnStartup", () =>
      Number(
        this.db
          .prepare(
            `UPDATE bot_dream_publications
             SET status = 'lost_ack', lease_owner = NULL, error = ?,
                 completed_at_ms = ?, updated_at_ms = ?
             WHERE status = 'sending'`,
          )
          .run(DREAM_PUBLICATION_RESTART_LOST_ACK_ERROR, nowMs, nowMs)
          .changes ?? 0,
      ),
    );
  }

  protected getDreamPublicationLocked(id: string): StoredDreamPublication | undefined {
    const row = this.db
      .prepare("SELECT * FROM bot_dream_publications WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToStoredDreamPublication(row);
  }

  protected getDreamPublicationByDedupeKeyLocked(
    dedupeKey: string,
  ): StoredDreamPublication | undefined {
    const row = this.db
      .prepare("SELECT * FROM bot_dream_publications WHERE dedupe_key = ?")
      .get(dedupeKey) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToStoredDreamPublication(row);
  }
}

function validateEnqueue(input: EnqueueDreamPublicationInput): Required<EnqueueDreamPublicationInput> {
  assertPublicationId(input.id);
  assertDedupeKey(input.dedupeKey);
  if (!SHA256_HEX.test(input.payloadHash)) {
    throw new Error("payloadHash must be a lowercase SHA-256 hex digest.");
  }
  const chatId = normalizedChatId(input.chatId);
  assertBoundedPayload(input.markdown, MAX_DREAM_PUBLICATION_MARKDOWN_BYTES, "markdown");
  assertBoundedPayload(input.plainText, MAX_DREAM_PUBLICATION_PLAIN_BYTES, "plainText");
  const maxAttempts = input.maxAttempts ?? DEFAULT_DREAM_PUBLICATION_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_DREAM_PUBLICATION_ATTEMPTS) {
    throw new Error(`maxAttempts must be an integer between 1 and ${MAX_DREAM_PUBLICATION_ATTEMPTS}.`);
  }
  const nowMs = input.nowMs ?? Date.now();
  assertTimestamp(nowMs, "nowMs");
  return {
    id: input.id.trim(),
    dedupeKey: input.dedupeKey.trim(),
    payloadHash: input.payloadHash,
    chatId,
    markdown: input.markdown,
    plainText: input.plainText,
    maxAttempts,
    nowMs,
  };
}

function assertPublicationId(value: string): void {
  assertNonEmptyBounded(value, MAX_DREAM_PUBLICATION_ID_CHARS, "id");
}

function assertDedupeKey(value: string): void {
  assertNonEmptyBounded(value, MAX_DREAM_PUBLICATION_DEDUPE_KEY_CHARS, "dedupeKey");
}

function normalizedChatId(value: string): string {
  assertNonEmptyBounded(value, 256, "chatId");
  return value.trim();
}

function normalizedWorkerId(value: string): string {
  assertNonEmptyBounded(value, MAX_DREAM_PUBLICATION_WORKER_ID_CHARS, "workerId");
  const normalized = value.trim();
  if (!WORKER_ID.test(normalized)) {
    throw new Error("workerId must contain only machine-safe characters.");
  }
  return normalized;
}

function normalizedError(value: string): string {
  assertNonEmptyBounded(value, MAX_DREAM_PUBLICATION_ERROR_CHARS, "error");
  return value.trim();
}

function assertBoundedPayload(value: string, maxBytes: number, name: string): void {
  assertNonEmptyBounded(value, maxBytes, name);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} must contain at most ${maxBytes} UTF-8 bytes.`);
  }
}

export type DreamPublicationsApi = Pick<
  DreamPublicationsMethods,
  | "enqueueDreamPublication"
  | "getDreamPublication"
  | "getDreamPublicationByDedupeKey"
  | "claimNextDreamPublication"
  | "markDreamPublicationSent"
  | "markDreamPublicationRetryableFailure"
  | "markDreamPublicationDefinitiveFailure"
  | "markDreamPublicationLostAck"
  | "getNextDreamPublicationDueAt"
  | "reconcileDreamPublicationsOnStartup"
>;
