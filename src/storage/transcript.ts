import { StoreCore } from "./core.js";
import { rowToStoredMessage } from "./mappers.js";
import { toSqlValues } from "./sqlite-utils.js";
import {
  assertIsoDateTime,
  assertNonEmptyBounded,
  normalizeIsoDateTime,
} from "./validation.js";
import type {
  LiveTranscriptCoverage,
  LiveTranscriptRequest,
  LiveTranscriptResult,
  StoredMessage,
  TranscriptForm,
} from "./types.js";

/**
 * The snapshot budget may ask for up to MAX_TRANSCRIPT_RECENT_COUNT rows, but
 * every delivered page is capped at MAX_TRANSCRIPT_PAGE_ROWS; continuations
 * walk the frozen keyset through nextCursor. The model-facing count budget
 * stays 1_000 while a single call carries at most one page.
 */
// A 200-row page keeps the model-facing projected transcript below the
// 64k function-output cap even after per-message attribution metadata.
export const MAX_TRANSCRIPT_PAGE_ROWS = 200;
export const MAX_TRANSCRIPT_RECENT_COUNT = 1_000;
const MAX_TRANSCRIPT_CURSOR_CHARS = 512;
const TRANSCRIPT_CURSOR_VERSION = 1;

/** Raised for any cursor that fails typed validation. */
export class TranscriptCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptCursorError";
  }
}

interface TranscriptCursorPayload {
  v: number;
  form: TranscriptForm;
  chatId: string;
  /** Frozen authoritative upper message id of the snapshot. */
  upper: number;
  /** Keyset anchor: lowest covered id (recent) or highest covered id (period). */
  anchor: number;
  /** Rows still requested by the snapshot budget. */
  budget: number;
  /** Rows covered before this continuation. */
  covered: number;
  /** Frozen totalAvailable of the snapshot. */
  total: number;
  /** Frozen omittedCount of the snapshot. */
  omitted: number;
  start?: string;
  end?: string;
}

/**
 * Method module installed on MessageStore.prototype.
 *
 * Live-only transcript reads: deleted rows are always excluded, every page is
 * chronological, and the first call freezes the authoritative upper message id
 * inside an opaque, versioned, strictly validated keyset cursor. Continuations
 * can therefore never observe or exceed that upper bound, which keeps recent
 * and period snapshots stable against newer inserts.
 */
export abstract class TranscriptMethods extends StoreCore {
  getLiveTranscript(request: LiveTranscriptRequest): LiveTranscriptResult {
    assertNonEmptyBounded(request.chatId, 256, "chatId");
    if (request.form !== "recent" && request.form !== "period") {
      throw new Error('form must be "recent" or "period".');
    }
    if ("cursor" in request) {
      return this.continueLiveTranscriptLocked(request);
    }
    if (request.form === "recent") {
      return this.startRecentTranscriptLocked(
        request.chatId,
        request.count,
        request.upperMessageId,
      );
    }
    return this.startPeriodTranscriptLocked(
      request.chatId,
      request.startInclusive,
      request.endExclusive,
      request.upperMessageId,
    );
  }

  protected startRecentTranscriptLocked(
    chatId: string,
    count: number,
    upperMessageId: number | undefined,
  ): LiveTranscriptResult {
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > MAX_TRANSCRIPT_RECENT_COUNT
    ) {
      throw new Error(
        `count must be an integer between 1 and ${MAX_TRANSCRIPT_RECENT_COUNT}.`,
      );
    }
    const upper = this.resolveTranscriptUpperLocked(chatId, upperMessageId);
    const total = this.countRecentRowsLocked(chatId, upper);
    const omitted = Math.max(0, total - count);
    const rows = this.selectRecentRowsLocked(chatId, upper, undefined, Math.min(count, MAX_TRANSCRIPT_PAGE_ROWS));
    return this.buildTranscriptResult({
      form: "recent",
      chatId,
      upper,
      total,
      omitted,
      previousCovered: 0,
      budget: count - rows.length,
      rows,
    });
  }

  protected startPeriodTranscriptLocked(
    chatId: string,
    startInclusiveRaw: string,
    endExclusiveRaw: string,
    upperMessageId: number | undefined,
  ): LiveTranscriptResult {
    const startInclusive = normalizeIsoDateTime(startInclusiveRaw, "startInclusive");
    const endExclusive = normalizeIsoDateTime(endExclusiveRaw, "endExclusive");
    if (Date.parse(startInclusive) >= Date.parse(endExclusive)) {
      throw new Error("startInclusive must be earlier than endExclusive.");
    }
    const upper = this.resolveTranscriptUpperLocked(chatId, upperMessageId);
    const total = this.countPeriodRowsLocked(chatId, startInclusive, endExclusive, upper);
    const omitted = this.countUndatedPeriodRowsLocked(
      chatId,
      startInclusive,
      endExclusive,
      upper,
    );
    const rows = this.selectPeriodRowsLocked(
      chatId,
      startInclusive,
      endExclusive,
      upper,
      undefined,
      MAX_TRANSCRIPT_PAGE_ROWS,
    );
    return this.buildTranscriptResult({
      form: "period",
      chatId,
      upper,
      total,
      omitted,
      previousCovered: 0,
      budget: total - rows.length,
      rows,
      start: startInclusive,
      end: endExclusive,
    });
  }

  protected continueLiveTranscriptLocked(request: {
    chatId: string;
    form: TranscriptForm;
    cursor: string;
    upperMessageId?: number;
  }): LiveTranscriptResult {
    const payload = decodeTranscriptCursor(request.cursor, {
      chatId: request.chatId,
      form: request.form,
      callerUpper: request.upperMessageId,
    });
    const upper = this.resolveTranscriptUpperLocked(request.chatId, payload.upper);
    if (payload.form === "recent") {
      const rows = this.selectRecentRowsLocked(
        payload.chatId,
        payload.upper,
        payload.anchor,
        Math.min(payload.budget, MAX_TRANSCRIPT_PAGE_ROWS),
      );
      return this.buildTranscriptResult({
        form: "recent",
        chatId: payload.chatId,
        upper: payload.upper,
        total: payload.total,
        omitted: payload.omitted,
        previousCovered: payload.covered,
        budget: payload.budget - rows.length,
        rows,
      });
    }
    const rows = this.selectPeriodRowsLocked(
      payload.chatId,
      payload.start ?? "",
      payload.end ?? "",
      payload.upper,
      payload.anchor,
      Math.min(payload.budget, MAX_TRANSCRIPT_PAGE_ROWS),
    );
    return this.buildTranscriptResult({
      form: "period",
      chatId: payload.chatId,
      upper: payload.upper,
      total: payload.total,
      omitted: payload.omitted,
      previousCovered: payload.covered,
      budget: payload.budget - rows.length,
      rows,
      start: payload.start,
      end: payload.end,
    });
  }

  protected resolveTranscriptUpperLocked(
    chatId: string,
    upperMessageId: number | undefined,
  ): number {
    if (
      upperMessageId !== undefined &&
      (!Number.isSafeInteger(upperMessageId) || upperMessageId < 0)
    ) {
      throw new Error("upperMessageId must be a non-negative safe integer.");
    }
    const row = this.db
      .prepare("SELECT MAX(message_id) AS max_id FROM messages WHERE chat_id = ?")
      .get(chatId) as Record<string, unknown> | undefined;
    const maxId =
      row?.max_id == null ? undefined : Number(row.max_id);
    if (maxId === undefined) {
      return upperMessageId ?? 0;
    }
    return upperMessageId === undefined
      ? maxId
      : Math.min(upperMessageId, maxId);
  }

  protected countRecentRowsLocked(chatId: string, upper: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE chat_id = ? AND deleted_at IS NULL AND message_id <= ?`,
      )
      .get(chatId, upper) as Record<string, unknown>;
    return Number(row.count ?? 0);
  }

  protected selectRecentRowsLocked(
    chatId: string,
    upper: number,
    anchor: number | undefined,
    limit: number,
  ): StoredMessage[] {
    if (limit <= 0) {
      return [];
    }
    const clauses = ["chat_id = ?", "deleted_at IS NULL", "message_id <= ?"];
    const values: unknown[] = [chatId, upper];
    if (anchor !== undefined) {
      clauses.push("message_id < ?");
      values.push(anchor);
    }
    values.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY message_id DESC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.reverse().map(rowToStoredMessage);
  }

  protected countPeriodRowsLocked(
    chatId: string,
    startInclusive: string,
    endExclusive: string,
    upper: number,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE chat_id = ? AND deleted_at IS NULL AND date IS NOT NULL
           AND date >= ? AND date < ? AND message_id <= ?`,
      )
      .get(chatId, startInclusive, endExclusive, upper) as
      | Record<string, unknown>
      | undefined;
    return Number(row?.count ?? 0);
  }

  protected selectPeriodRowsLocked(
    chatId: string,
    startInclusive: string,
    endExclusive: string,
    upper: number,
    anchor: number | undefined,
    limit: number,
  ): StoredMessage[] {
    if (limit <= 0) {
      return [];
    }
    const clauses = [
      "chat_id = ?",
      "deleted_at IS NULL",
      "date IS NOT NULL",
      "date >= ?",
      "date < ?",
      "message_id <= ?",
    ];
    const values: unknown[] = [chatId, startInclusive, endExclusive, upper];
    if (anchor !== undefined) {
      clauses.push("message_id > ?");
      values.push(anchor);
    }
    values.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY message_id ASC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  /**
   * Undated rows that lie strictly between the dated rows of the period cannot
   * be assigned to the period, so they are reported as an honest omission.
   * Rows before the first dated match or after the last dated match of the
   * period are not attributed to the period.
   */
  protected countUndatedPeriodRowsLocked(
    chatId: string,
    startInclusive: string,
    endExclusive: string,
    upper: number,
  ): number {
    const bounds = this.db
      .prepare(
        `SELECT MIN(message_id) AS min_id, MAX(message_id) AS max_id FROM messages
         WHERE chat_id = ? AND deleted_at IS NULL AND date IS NOT NULL
           AND date >= ? AND date < ? AND message_id <= ?`,
      )
      .get(chatId, startInclusive, endExclusive, upper) as
      | Record<string, unknown>
      | undefined;
    if (bounds?.min_id == null || bounds.max_id == null) {
      return 0;
    }
    const minId = Number(bounds.min_id);
    const maxId = Number(bounds.max_id);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE chat_id = ? AND deleted_at IS NULL AND date IS NULL
           AND message_id >= ? AND message_id <= ?`,
      )
      .get(chatId, minId, maxId) as Record<string, unknown>;
    return Number(row.count ?? 0);
  }

  protected buildTranscriptResult(input: {
    form: TranscriptForm;
    chatId: string;
    upper: number;
    total: number;
    omitted: number;
    previousCovered: number;
    budget: number;
    rows: StoredMessage[];
    start?: string;
    end?: string;
  }): LiveTranscriptResult {
    // Rows deleted between pages can produce an empty continuation; stop
    // instead of issuing a cursor that would never advance.
    const stalled = input.rows.length === 0 && input.previousCovered > 0;
    const covered = input.previousCovered + input.rows.length;
    const snapshotBudget = covered + Math.max(0, input.budget);
    const hasMore =
      !stalled &&
      input.rows.length > 0 &&
      input.budget > 0 &&
      covered < input.total;
    const emptyTextCount = input.rows.filter(
      (message) => message.text.trim().length === 0,
    ).length;
    const coverage: LiveTranscriptCoverage = {
      upperMessageId: input.upper,
      totalAvailable: input.total,
      returnedCount: input.rows.length,
      coveredCount: covered,
      emptyTextCount,
      mediaOrEmptyTextCount: emptyTextCount,
      truncated: covered < Math.min(snapshotBudget, input.total),
      omittedCount: input.omitted,
      hasMore,
    };
    const first = input.rows[0];
    const last = input.rows.at(-1);
    if (first !== undefined && last !== undefined) {
      coverage.firstMessageId = first.messageId;
      coverage.lastMessageId = last.messageId;
      coverage.firstDate = first.date;
      coverage.lastDate = last.date;
    }
    if (hasMore) {
      coverage.nextCursor = encodeTranscriptCursor({
        v: TRANSCRIPT_CURSOR_VERSION,
        form: input.form,
        chatId: input.chatId,
        upper: input.upper,
        anchor: input.form === "recent" ? first!.messageId : last!.messageId,
        budget: input.budget,
        covered,
        total: input.total,
        omitted: input.omitted,
        ...(input.start === undefined ? {} : { start: input.start }),
        ...(input.end === undefined ? {} : { end: input.end }),
      });
    }
    return { form: input.form, messages: input.rows, coverage };
  }
}

function encodeTranscriptCursor(payload: TranscriptCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

interface DecodeCursorContext {
  chatId: string;
  form: TranscriptForm;
  callerUpper?: number;
}

function decodeTranscriptCursor(
  cursor: string,
  context: DecodeCursorContext,
): TranscriptCursorPayload {
  if (typeof cursor !== "string" || cursor.trim().length === 0) {
    throw new TranscriptCursorError("Cursor must be a non-empty string.");
  }
  if (cursor.length > MAX_TRANSCRIPT_CURSOR_CHARS) {
    throw new TranscriptCursorError("Cursor exceeds the bounded length.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TranscriptCursorError("Cursor is not valid base64url JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TranscriptCursorError("Cursor payload must be an object.");
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.v !== TRANSCRIPT_CURSOR_VERSION) {
    throw new TranscriptCursorError("Cursor version is not supported.");
  }
  if (payload.form !== "recent" && payload.form !== "period") {
    throw new TranscriptCursorError("Cursor form is invalid.");
  }
  if (payload.form !== context.form) {
    throw new TranscriptCursorError(
      "Cursor does not match the requested transcript form.",
    );
  }
  if (typeof payload.chatId !== "string" || payload.chatId.length === 0) {
    throw new TranscriptCursorError("Cursor chat reference is invalid.");
  }
  if (payload.chatId !== context.chatId) {
    throw new TranscriptCursorError("Cursor belongs to a different chat.");
  }
  const upper = cursorInteger(payload, "upper");
  const anchor = cursorInteger(payload, "anchor");
  const budget = cursorInteger(payload, "budget");
  const covered = cursorInteger(payload, "covered");
  const total = cursorInteger(payload, "total");
  const omitted = cursorInteger(payload, "omitted");

  // Semantic sanity checks. A forged cursor must not enlarge the snapshot,
  // increase the budget, or claim progress it did not make.
  if (anchor < 1 || budget < 1 || covered < 0) {
    throw new TranscriptCursorError("Cursor bounds are inconsistent.");
  }
  if (anchor > upper) {
    throw new TranscriptCursorError(
      "Cursor anchor exceeds its authoritative upper message id.",
    );
  }
  if (covered > total) {
    throw new TranscriptCursorError(
      "Cursor covered count exceeds the frozen total.",
    );
  }
  if (omitted < 0 || omitted > total) {
    throw new TranscriptCursorError("Cursor omitted count is out of bounds.");
  }
  if (covered + omitted > total + budget) {
    throw new TranscriptCursorError(
      "Cursor budget is inconsistent with covered/omitted totals.",
    );
  }
  if (
    context.callerUpper !== undefined &&
    (!Number.isSafeInteger(context.callerUpper) || context.callerUpper < 0)
  ) {
    throw new Error("callerUpper must be a non-negative safe integer.");
  }
  if (
    context.callerUpper !== undefined &&
    upper > context.callerUpper
  ) {
    throw new TranscriptCursorError(
      "Cursor exceeds the application-owned upper bound.",
    );
  }

  const form = payload.form;
  if (form === "period") {
    const start = normalizeIsoDateTime(cursorIsoDate(payload, "start"), "start");
    const end = normalizeIsoDateTime(cursorIsoDate(payload, "end"), "end");
    if (Date.parse(start) >= Date.parse(end)) {
      throw new TranscriptCursorError("Cursor period bounds are invalid.");
    }
    return {
      v: TRANSCRIPT_CURSOR_VERSION,
      form,
      chatId: payload.chatId,
      upper,
      anchor,
      budget,
      covered,
      total,
      omitted,
      start,
      end,
    };
  }
  return {
    v: TRANSCRIPT_CURSOR_VERSION,
    form,
    chatId: payload.chatId,
    upper,
    anchor,
    budget,
    covered,
    total,
    omitted,
  };
}

function cursorInteger(
  payload: Record<string, unknown>,
  name: string,
): number {
  const value = payload[name];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TranscriptCursorError(`Cursor field ${name} is invalid.`);
  }
  return value;
}

const CANONICAL_UTC_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function cursorIsoDate(
  payload: Record<string, unknown>,
  name: string,
): string {
  const value = payload[name];
  if (
    typeof value !== "string" ||
    !CANONICAL_UTC_ISO_RE.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TranscriptCursorError(
      `Cursor field ${name} must be a canonical UTC ISO-8601 date-time string.`,
    );
  }
  return value;
}

export type TranscriptApi = Pick<TranscriptMethods, "getLiveTranscript">;
