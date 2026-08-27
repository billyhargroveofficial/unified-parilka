import { StoreCore } from "./core.js";
import {
  rowToStoredBotTurn,
  rowToStoredBotUpdate,
} from "./mappers.js";
import type {
  BotDurableStatus,
  BotTurnProgressState,
  StoredBotTurn,
  StoredBotUpdate,
} from "./types.js";
import {
  assertBotLeaseMs,
  assertNonEmptyBounded,
  assertBotTurnId,
  assertTimestamp,
  botTurnRetryDelayMs,
  normalizeBotStatuses,
  normalizeQueryLimit,
} from "./validation.js";
import { toSqlValues } from "./sqlite-utils.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class BotTurnMethods extends StoreCore {
declare protected getBotUpdateLocked: (
    updateId: number,
  ) => StoredBotUpdate | undefined;

  claimNextBotTurn(params: {
    workerId: string;
    chatId: string;
    leaseMs: number;
    nowMs?: number;
  }): StoredBotTurn | undefined {
    const workerId = params.workerId.trim();
    if (!workerId) {
      throw new Error("workerId must not be empty.");
    }
    const chatId = params.chatId.trim();
    assertNonEmptyBounded(chatId, 256, "chatId");
    assertBotLeaseMs(params.leaseMs);
    const nowMs = params.nowMs ?? Date.now();
    assertTimestamp(nowMs, "nowMs");
    assertTimestamp(nowMs + params.leaseMs, "leaseExpiresAtMs");

    return this.immediateTransaction("claimNextBotTurn", () => {
      this.recoverStaleBotTurnLeasesLocked(nowMs);
      this.quarantineBotTurnsOutsideChatLocked(chatId, nowMs);
      const candidate = this.db
        .prepare(
          `SELECT id, status
           FROM bot_turns
           WHERE chat_id = ?
             AND status IN ('queued', 'failed')
             AND attempts < max_attempts
             AND (retry_not_before_ms IS NULL OR retry_not_before_ms <= ?)
           ORDER BY created_at_ms ASC, id ASC
           LIMIT 1`,
        )
        .get(chatId, nowMs) as Record<string, unknown> | undefined;
      if (!candidate) {
        return undefined;
      }

      const turnId = Number(candidate.id);
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET status = 'running', attempts = attempts + 1, lease_owner = ?,
               lease_expires_at_ms = ?, retry_not_before_ms = NULL,
               error = NULL, started_at_ms = COALESCE(started_at_ms, ?),
               updated_at_ms = ?
           WHERE id = ? AND status = ? AND attempts < max_attempts`,
        )
        .run(workerId, nowMs + params.leaseMs, nowMs, nowMs, turnId, String(candidate.status));
      if (result.changes === 0) {
        return undefined;
      }
      this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      return this.getBotTurnLocked(turnId);
    });
  }

  getNextBotTurnRetryAt(
    chatId: string,
    nowMs = Date.now(),
  ): number | undefined {
    assertNonEmptyBounded(chatId.trim(), 256, "chatId");
    assertTimestamp(nowMs, "nowMs");
    const row = this.db
      .prepare(
        `SELECT MIN(retry_not_before_ms) AS retry_at
         FROM bot_turns
         WHERE chat_id = ?
           AND status = 'failed'
           AND attempts < max_attempts
           AND retry_not_before_ms > ?`,
      )
      .get(chatId.trim(), nowMs) as Record<string, unknown> | undefined;
    return row?.retry_at == null ? undefined : Number(row.retry_at);
  }

  saveBotTurnDraft(turnId: number, workerId: string, draftText: string, nowMs = Date.now()): boolean {
    assertBotTurnId(turnId);
    assertTimestamp(nowMs, "nowMs");
    const owner = workerId.trim();
    if (!owner) {
      throw new Error("workerId must not be empty.");
    }
    return this.immediateTransaction("saveBotTurnDraft", () => {
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET status = 'drafted', draft_text = ?, updated_at_ms = ?
           WHERE id = ? AND status IN ('running', 'drafted') AND lease_owner = ?
             AND lease_expires_at_ms > ?`,
        )
        .run(draftText, nowMs, turnId, owner, nowMs);
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  renewBotTurnLease(
    turnId: number,
    workerId: string,
    leaseMs: number,
    nowMs = Date.now(),
  ): boolean {
    assertBotTurnId(turnId);
    assertBotLeaseMs(leaseMs);
    assertTimestamp(nowMs, "nowMs");
    assertTimestamp(nowMs + leaseMs, "leaseExpiresAtMs");
    const owner = workerId.trim();
    if (!owner) {
      throw new Error("workerId must not be empty.");
    }
    return this.immediateTransaction("renewBotTurnLease", () => {
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET lease_expires_at_ms = MAX(lease_expires_at_ms, ?), updated_at_ms = ?
           WHERE id = ? AND status IN ('running', 'drafted') AND lease_owner = ?
             AND lease_expires_at_ms > ?`,
        )
        .run(nowMs + leaseMs, nowMs, turnId, owner, nowMs);
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  markBotTurnSending(turnId: number, workerId: string, nowMs = Date.now()): boolean {
    assertBotTurnId(turnId);
    assertTimestamp(nowMs, "nowMs");
    const owner = workerId.trim();
    if (!owner) {
      throw new Error("workerId must not be empty.");
    }
    return this.immediateTransaction("markBotTurnSending", () => {
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET status = 'sending', lease_owner = NULL, lease_expires_at_ms = NULL,
               retry_not_before_ms = NULL, updated_at_ms = ?
           WHERE id = ? AND status = 'drafted' AND lease_owner = ?
             AND lease_expires_at_ms > ?`,
        )
        .run(nowMs, turnId, owner, nowMs);
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  markBotTurnSent(turnId: number, telegramMessageId?: number, nowMs = Date.now()): boolean {
    assertBotTurnId(turnId);
    assertTimestamp(nowMs, "nowMs");
    if (telegramMessageId != null && !Number.isSafeInteger(telegramMessageId)) {
      throw new Error("telegramMessageId must be a safe integer when provided.");
    }
    return this.transitionBotTurnFromSending(
      "markBotTurnSent",
      turnId,
      "sent",
      undefined,
      telegramMessageId,
      nowMs,
    );
  }

  markBotTurnLostAck(turnId: number, error: string, nowMs = Date.now()): boolean {
    assertBotTurnId(turnId);
    assertTimestamp(nowMs, "nowMs");
    return this.transitionBotTurnFromSending(
      "markBotTurnLostAck",
      turnId,
      "lost_ack",
      error.trim() || "Telegram delivery acknowledgement was lost.",
      undefined,
      nowMs,
    );
  }

  /**
   * Use only after a Telegram API response proves that no message was
   * created. Ambiguous network failures must remain terminal via lost_ack.
   */
  markBotTurnDispatchRejected(
    turnId: number,
    error: string,
    retryable: boolean,
    nowMs = Date.now(),
    retryAfterMs?: number,
  ): boolean {
    assertBotTurnId(turnId);
    assertTimestamp(nowMs, "nowMs");
    if (
      retryAfterMs != null &&
      (!Number.isSafeInteger(retryAfterMs) ||
        retryAfterMs < 0)
    ) {
      throw new RangeError(
        "retryAfterMs must be a non-negative safe integer.",
      );
    }
    return this.immediateTransaction("markBotTurnDispatchRejected", () => {
      const current = this.getBotTurnLocked(turnId);
      const willRetry =
        current?.status === "sending" &&
        retryable &&
        current.attempts < current.maxAttempts;
      const retryNotBeforeMs = willRetry
        ? nowMs +
          botTurnRetryDelayMs(
            current.attempts,
            retryAfterMs,
          )
        : null;
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET status = CASE
                 WHEN ? = 1 AND attempts < max_attempts THEN 'failed'
                 ELSE 'dead_letter'
               END,
               error = ?, retry_not_before_ms = ?, updated_at_ms = ?,
               completed_at_ms = CASE
                 WHEN ? = 1 AND attempts < max_attempts THEN NULL
                 ELSE ?
               END
           WHERE id = ? AND status = 'sending'`,
        )
        .run(
          retryable ? 1 : 0,
          error.trim() || "Telegram rejected the message before delivery.",
          retryNotBeforeMs,
          nowMs,
          retryable ? 1 : 0,
          nowMs,
          turnId,
        );
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  markBotTurnSkipped(turnId: number, workerId: string, reason?: string, nowMs = Date.now()): boolean {
    return this.finishClaimedBotTurn(turnId, workerId, "skipped", reason, nowMs);
  }

  markBotTurnFailed(
    turnId: number,
    workerId: string,
    error: string,
    nowMs = Date.now(),
    retryable = true,
  ): boolean {
    assertBotTurnId(turnId);
    assertTimestamp(nowMs, "nowMs");
    const owner = workerId.trim();
    if (!owner) {
      throw new Error("workerId must not be empty.");
    }
    if (typeof retryable !== "boolean") {
      throw new TypeError("retryable must be a boolean.");
    }
    return this.immediateTransaction("markBotTurnFailed", () => {
      const current = this.getBotTurnLocked(turnId);
      const retryNotBeforeMs =
        retryable && current != null && current.attempts < current.maxAttempts
          ? nowMs + botTurnRetryDelayMs(current.attempts)
          : null;
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET status = CASE
                 WHEN ? = 1 AND attempts < max_attempts THEN 'failed'
                 ELSE 'dead_letter'
               END,
               error = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
               retry_not_before_ms = ?,
               updated_at_ms = ?,
               completed_at_ms = CASE
                 WHEN ? = 1 AND attempts < max_attempts THEN NULL
                 ELSE ?
               END
           WHERE id = ? AND status IN ('running', 'drafted') AND lease_owner = ?
             AND lease_expires_at_ms > ?`,
        )
        .run(
          retryable ? 1 : 0,
          error.trim() || "Bot turn failed.",
          retryNotBeforeMs,
          nowMs,
          retryable ? 1 : 0,
          nowMs,
          turnId,
          owner,
          nowMs,
        );
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  saveBotTurnProgress(
    turnId: number,
    workerId: string,
    progress: { messageId?: number; state?: BotTurnProgressState },
    nowMs = Date.now(),
  ): boolean {
    assertBotTurnId(turnId);
    assertTimestamp(nowMs, "nowMs");
    const owner = workerId.trim();
    if (!owner) {
      throw new Error("workerId must not be empty.");
    }
    return this.immediateTransaction("saveBotTurnProgress", () => {
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET progress_message_id = ?, progress_state = ?, updated_at_ms = ?
           WHERE id = ? AND status IN ('running', 'drafted') AND lease_owner = ?
             AND lease_expires_at_ms > ?`,
        )
        .run(
          progress.messageId ?? null,
          progress.state ?? null,
          nowMs,
          turnId,
          owner,
          nowMs,
        );
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  clearBotTurnProgress(turnId: number, nowMs = Date.now()): boolean {
    assertBotTurnId(turnId);
    assertTimestamp(nowMs, "nowMs");
    return this.immediateTransaction("clearBotTurnProgress", () => {
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET progress_message_id = NULL, progress_state = NULL, updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(nowMs, turnId);
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  /**
   * Returns one terminal turn whose presentation-only progress bubble still
   * needs deletion. The durable message id is retained until the Bot API
   * confirms cleanup, including after a final reply was already delivered.
   */
  getNextBotTurnProgressCleanup(chatId: string): StoredBotTurn | undefined {
    const normalizedChatId = chatId.trim();
    assertNonEmptyBounded(normalizedChatId, 256, "chatId");
    const row = this.db
      .prepare(
        `SELECT id
         FROM bot_turns
         WHERE chat_id = ?
           AND progress_message_id IS NOT NULL
           AND status IN ('sent', 'skipped', 'lost_ack', 'dead_letter')
         ORDER BY updated_at_ms ASC, id ASC
         LIMIT 1`,
      )
      .get(normalizedChatId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.getBotTurnLocked(Number(row.id));
  }

  /**
   * Clears only the exact persisted progress fence selected for cleanup.
   * Matching the message id prevents a stale cleaner from erasing a newer
   * presentation message should terminal-state handling ever be extended.
   */
  clearTerminalBotTurnProgressIfMatches(
    turnId: number,
    messageId: number,
    nowMs = Date.now(),
  ): boolean {
    assertBotTurnId(turnId);
    if (!Number.isSafeInteger(messageId) || messageId < 1) {
      throw new Error("progress messageId must be a positive safe integer.");
    }
    assertTimestamp(nowMs, "nowMs");
    return this.immediateTransaction("clearTerminalBotTurnProgressIfMatches", () => {
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET progress_message_id = NULL, progress_state = NULL, updated_at_ms = ?
           WHERE id = ? AND progress_message_id = ?
             AND status IN ('sent', 'skipped', 'lost_ack', 'dead_letter')`,
        )
        .run(nowMs, turnId, messageId);
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  getBotTurn(turnId: number): StoredBotTurn | undefined {
    assertBotTurnId(turnId);
    return this.getBotTurnLocked(turnId);
  }

  getBotTurnByTrigger(chatId: string, triggerMessageId: number): StoredBotTurn | undefined {
    if (!Number.isSafeInteger(triggerMessageId)) {
      throw new Error("triggerMessageId must be a safe integer.");
    }
    return this.getBotTurnByTriggerLocked(chatId, triggerMessageId);
  }

  queryBotTurns(
    params: { chatId?: string; statuses?: BotDurableStatus[]; limit?: number } = {},
  ): StoredBotTurn[] {
    const limit = normalizeQueryLimit(params.limit);
    const statuses = normalizeBotStatuses(params.statuses);
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (params.chatId != null) {
      clauses.push("chat_id = ?");
      values.push(params.chatId);
    }
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      values.push(...statuses);
    }
    values.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM bot_turns ${where} ORDER BY created_at_ms ASC, id ASC LIMIT ?`)
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToStoredBotTurn);
  }

  countStuckSendingTurns(chatId: string, staleThresholdMs: number = 5 * 60_000): number {
    assertNonEmptyBounded(chatId, 256, "chatId");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM bot_turns
         WHERE chat_id = ? AND status = 'sending' AND updated_at_ms < ?`,
      )
      .get(chatId, Date.now() - staleThresholdMs) as { count: number };
    return row.count;
  }

  protected recoverStaleBotTurnLeasesLocked(nowMs: number): void {
    const staleRows = this.db
      .prepare(
        `SELECT id, attempts, max_attempts
         FROM bot_turns
         WHERE status IN ('running', 'drafted')
           AND lease_expires_at_ms IS NOT NULL
           AND lease_expires_at_ms <= ?`,
      )
      .all(nowMs) as Record<string, unknown>[];
    if (staleRows.length === 0) {
      return;
    }
    const recover = this.db.prepare(
      `UPDATE bot_turns
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'failed' END,
           error = COALESCE(error, 'Bot worker lease expired before the turn completed.'),
           lease_owner = NULL, lease_expires_at_ms = NULL,
           retry_not_before_ms = CASE
             WHEN attempts >= max_attempts THEN NULL
             ELSE ?
           END,
           updated_at_ms = ?,
           completed_at_ms = CASE WHEN attempts >= max_attempts THEN ? ELSE NULL END
       WHERE id = ?
         AND status IN ('running', 'drafted')
         AND lease_expires_at_ms IS NOT NULL
         AND lease_expires_at_ms <= ?`,
    );
    for (const row of staleRows) {
      const turnId = Number(row.id);
      const attempts = Number(row.attempts);
      recover.run(
        nowMs + botTurnRetryDelayMs(attempts),
        nowMs,
        nowMs,
        turnId,
        nowMs,
      );
      this.syncBotUpdateFromTurnLocked(turnId, nowMs);
    }
  }

  protected quarantineBotTurnsOutsideChatLocked(
    allowedChatId: string,
    nowMs: number,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM bot_turns
         WHERE chat_id <> ?
           AND status IN ('queued', 'failed')`,
      )
      .all(allowedChatId) as Record<string, unknown>[];
    if (rows.length === 0) {
      return;
    }
    this.db
      .prepare(
        `UPDATE bot_turns
         SET status = 'dead_letter',
             error = 'Bot turn belongs to a chat outside the current allowlist.',
             retry_not_before_ms = NULL,
             updated_at_ms = ?,
             completed_at_ms = ?
         WHERE chat_id <> ?
           AND status IN ('queued', 'failed')`,
      )
      .run(nowMs, nowMs, allowedChatId);
    for (const row of rows) {
      this.syncBotUpdateFromTurnLocked(Number(row.id), nowMs);
    }
  }

  protected finishClaimedBotTurn(
    turnId: number,
    workerId: string,
    status: "skipped",
    reason: string | undefined,
    nowMs: number,
  ): boolean {
    assertBotTurnId(turnId);
    assertTimestamp(nowMs, "nowMs");
    const owner = workerId.trim();
    if (!owner) {
      throw new Error("workerId must not be empty.");
    }
    return this.immediateTransaction("finishClaimedBotTurn", () => {
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET status = ?, error = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
               retry_not_before_ms = NULL, updated_at_ms = ?, completed_at_ms = ?
           WHERE id = ? AND status IN ('running', 'drafted') AND lease_owner = ?
             AND lease_expires_at_ms > ?`,
        )
        .run(status, reason?.trim() || null, nowMs, nowMs, turnId, owner, nowMs);
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  protected transitionBotTurnFromSending(
    operation: string,
    turnId: number,
    status: "sent" | "lost_ack",
    error: string | undefined,
    telegramMessageId: number | undefined,
    nowMs: number,
  ): boolean {
    return this.immediateTransaction(operation, () => {
      const result = this.db
        .prepare(
          `UPDATE bot_turns
           SET status = ?, telegram_message_id = ?, error = ?,
               retry_not_before_ms = NULL, updated_at_ms = ?, completed_at_ms = ?
           WHERE id = ? AND status = 'sending'`,
        )
        .run(status, telegramMessageId ?? null, error ?? null, nowMs, nowMs, turnId);
      if (result.changes > 0) {
        this.syncBotUpdateFromTurnLocked(turnId, nowMs);
      }
      return result.changes > 0;
    });
  }

  protected syncBotUpdateFromTurnLocked(turnId: number, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE bot_updates
         SET status = (SELECT status FROM bot_turns WHERE id = ?),
             error = (SELECT error FROM bot_turns WHERE id = ?),
             updated_at_ms = ?,
             completed_at_ms = (SELECT completed_at_ms FROM bot_turns WHERE id = ?)
         WHERE update_id = (SELECT update_id FROM bot_turns WHERE id = ?)`,
      )
      .run(turnId, turnId, nowMs, turnId, turnId);
  }

  protected getBotTurnLocked(turnId: number): StoredBotTurn | undefined {
    const row = this.db.prepare("SELECT * FROM bot_turns WHERE id = ?").get(turnId) as
      | Record<string, unknown>
      | undefined;
    return row == null ? undefined : rowToStoredBotTurn(row);
  }

  protected getBotTurnByTriggerLocked(chatId: string, triggerMessageId: number): StoredBotTurn | undefined {
    const row = this.db
      .prepare("SELECT * FROM bot_turns WHERE chat_id = ? AND trigger_message_id = ?")
      .get(chatId, triggerMessageId) as Record<string, unknown> | undefined;
    return row == null ? undefined : rowToStoredBotTurn(row);
  }
}

export type BotTurnApi = Pick<
  BotTurnMethods,
  | "claimNextBotTurn"
  | "getNextBotTurnRetryAt"
  | "saveBotTurnDraft"
  | "renewBotTurnLease"
  | "markBotTurnSending"
  | "markBotTurnSent"
  | "markBotTurnLostAck"
  | "markBotTurnDispatchRejected"
  | "markBotTurnSkipped"
  | "markBotTurnFailed"
  | "saveBotTurnProgress"
  | "clearBotTurnProgress"
  | "getNextBotTurnProgressCleanup"
  | "clearTerminalBotTurnProgressIfMatches"
  | "getBotTurn"
  | "getBotTurnByTrigger"
  | "queryBotTurns"
  | "countStuckSendingTurns"
>;
