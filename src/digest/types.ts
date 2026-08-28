import type {
  ModelExecutionResult,
  ModelRole,
  ResolvedModelCandidate,
} from "../providers/model-router.js";
import type {
  DigestMessageDateBounds,
  StoredDayDigest,
  StoredDigestRollup,
  StoredMessage,
  UpsertDayDigestInput,
  UpsertDigestRollupInput,
} from "../store.js";

export const DIGEST_TIME_ZONE = "Europe/Moscow";
export const DIGEST_STALE_MESSAGE_THRESHOLD = 25;
export const DAY_DIGEST_PROMPT_VERSION = "parilka-day-v1";
export const WEEK_DIGEST_PROMPT_VERSION = "parilka-week-v1";
export const DEFAULT_MAX_DAY_GENERATIONS_PER_RUN = 3;
export const DEFAULT_MAX_WEEK_GENERATIONS_PER_RUN = 1;
export const MAX_DAY_GENERATIONS_PER_RUN = 31;
export const MAX_WEEK_GENERATIONS_PER_RUN = 8;

export type DigestSummaryKind = "day" | "week";

export interface DigestSummaryRequest {
  kind: DigestSummaryKind;
  period: string;
  dayFrom: string;
  dayTo: string;
  sourceText: string;
  sourceCount: number;
  maxOutputChars: number;
  signal: AbortSignal;
}

export interface DigestSummaryResult {
  text: string;
  model: string;
  providerId: string;
  inputTokens?: number;
  outputTokens?: number;
  fallbackCount?: number;
}

export interface DigestSummaryPort {
  summarize(request: DigestSummaryRequest): Promise<DigestSummaryResult>;
}

export interface DigestModelRouter {
  executeWithFallback<T>(
    role: ModelRole,
    attempt: (
      candidate: ResolvedModelCandidate,
      attemptNumber: number,
    ) => Promise<T>,
  ): Promise<ModelExecutionResult<T>>;
}

export interface DigestStore {
  getDigestMessageDateBounds(
    chatId: string,
  ): DigestMessageDateBounds | undefined;
  getDigestSourceMessages(params: {
    chatId: string;
    startInclusive: string;
    endExclusive: string;
  }): StoredMessage[];
  getDayDigests(params: {
    chatId: string;
    dayFrom: string;
    dayTo: string;
    limit?: number;
  }): StoredDayDigest[];
  listDayDigests(chatId: string): StoredDayDigest[];
  upsertDayDigest(input: UpsertDayDigestInput): StoredDayDigest;
  commitDayDigestIfCurrent(
    input: UpsertDayDigestInput,
    sourceIsCurrent: () => boolean,
  ): StoredDayDigest | undefined;
  deleteDayDigest(params: {
    chatId: string;
    day: string;
  }): { dayDeleted: boolean; weekRollupsDeleted: number };
  getDigestRollups(params: {
    chatId: string;
    kind: "week" | "month";
    dayFrom: string;
    dayTo: string;
    limit?: number;
  }): StoredDigestRollup[];
  upsertDigestRollup(
    input: UpsertDigestRollupInput,
  ): StoredDigestRollup;
  commitDigestRollupIfCurrent(
    input: UpsertDigestRollupInput,
    sourceIsCurrent: () => boolean,
  ): StoredDigestRollup | undefined;
  deleteDigestRollup(params: {
    chatId: string;
    kind: "week" | "month";
    period: string;
  }): boolean;
}

export type DigestItemStatus =
  | "planned"
  | "generated"
  | "unchanged"
  | "skipped_current"
  | "blocked"
  | "deferred"
  | "invalidated"
  | "failed";

export interface DigestReportItem {
  kind: DigestSummaryKind;
  period: string;
  status: DigestItemStatus;
  reason:
    | "missing"
    | "manual_all"
    | "prompt_changed"
    | "source_changed"
    | "source_current"
    | "source_deleted"
    | "day_incomplete"
    | "append_threshold_not_met"
    | "current_day_incomplete"
    | "run_limit"
    | "generation_failed";
  sourceCount: number;
  appendedAfterStoredEnd?: number;
  sourceHash?: string;
  model?: string;
  providerId?: string;
  fallbackCount?: number;
  error?: {
    name: string;
    code: string;
  };
}

export interface DigestPhaseReport {
  scanned: number;
  candidates: number;
  planned: number;
  providerCalls: number;
  generated: number;
  unchanged: number;
  invalidated: number;
  deferred: number;
  skipped: number;
  failed: number;
  items: DigestReportItem[];
}

export interface DigestGenerationReport {
  mode: "dry_run" | "applied";
  chatId: string;
  timeZone: typeof DIGEST_TIME_ZONE;
  staleMessageThreshold: typeof DIGEST_STALE_MESSAGE_THRESHOLD;
  options: {
    all: boolean;
    maxDayGenerationsPerRun: number;
    maxWeekGenerationsPerRun: number;
  };
  startedAt: string;
  finishedAt: string;
  days: DigestPhaseReport;
  weeks: DigestPhaseReport;
}

export interface DigestGenerationOptions {
  store: DigestStore;
  chatId: string;
  apply?: boolean;
  all?: boolean;
  summaryPort?: DigestSummaryPort;
  now?: () => Date;
  maxInputChars?: number;
  maxOutputChars?: number;
  itemTimeoutMs?: number;
  maxDayGenerationsPerRun?: number;
  maxWeekGenerationsPerRun?: number;
}

export type DigestGenerationErrorCode =
  | "input_too_large"
  | "summary_timeout"
  | "summary_aborted"
  | "source_changed_during_generation"
  | "invalid_clock";

export class DigestGenerationError extends Error {
  readonly name = "DigestGenerationError";

  constructor(
    readonly code: DigestGenerationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
