export type StoredMessage = {
  id?: number;
  chatId: string;
  messageId: number;
  date?: string;
  senderId?: string;
  senderName?: string;
  text: string;
  /**
   * False means the transport deliberately has no plain-text projection for
   * this message (currently Telegram native rich content). It is transient
   * upsert input, not a persisted message property: a reconciliation must not
   * replace an already-recorded canonical projection with an empty placeholder.
   */
  textAvailable?: boolean;
  replyToMessageId?: number;
  topicId?: number;
  rawJson?: string;
  deletedAt?: string;
};

export type SyncState = {
  chatId: string;
  oldestMessageId?: number;
  newestMessageId?: number;
  nextBackfillOffsetId?: number;
  recentCatchupMinId?: number;
  recentCatchupNextOffsetId?: number;
  recentCatchupNewestId?: number;
  syncedCount: number;
  lastRecentSyncAt?: string;
  lastBackfillAt?: string;
  backfillExhaustedAt?: string;
  lastError?: string;
  updatedAt?: string;
};

export type DaemonStatus = {
  service: string;
  lastStartedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  updatedAt?: string;
};

export type ChatCacheStatus = {
  chatId: string;
  messages: {
    count: number;
    oldestMessageId?: number;
    newestMessageId?: number;
  };
  syncState: SyncState | null;
  daemonStatus: DaemonStatus | null;
  embeddings: Array<Record<string, unknown>>;
  maintenance: MaintenanceJob[];
};

export type MaintenanceJobStatus = "pending" | "completed";

export type MaintenanceJob = {
  name: string;
  status: MaintenanceJobStatus;
  reason?: string;
  details?: Record<string, unknown>;
  updatedAt?: string;
  completedAt?: string;
};

export type MaintenanceJobName =
  | "messages_fts_rebuild"
  | "embedding_chunk_membership_backfill";

export type DurableQueueStatus = {
  botTurns: Record<
    string,
    { count: number; oldestUpdatedAtMs?: number }
  >;
  botUpdates: Record<
    string,
    { count: number; oldestReceivedAtMs?: number }
  >;
  sendOutbox: Record<
    string,
    { count: number; oldestCreatedAtMs?: number }
  >;
};

export type KeywordSearchHit = {
  message: StoredMessage;
  rank: number;
};

export type LexicalSearchMatchMode = "all" | "any" | "phrase" | "prefix";

export type LexicalSearchOrder = "relevance" | "newest" | "oldest";

/**
 * Deterministic lexical FTS search without any vector/embedding channel.
 * Dates are UTC ISO strings; the start is inclusive and the end exclusive.
 * Rows with a NULL date never match a date filter.
 */
export type LexicalSearchParams = {
  chatId: string;
  query: string;
  match?: LexicalSearchMatchMode;
  /** Exact filter: sender_id or sender_name equals this value. */
  sender?: string;
  excludeSenderIds?: readonly string[];
  dateFromInclusive?: string;
  dateToExclusive?: string;
  beforeId?: number;
  afterId?: number;
  order?: LexicalSearchOrder;
  limit?: number;
};

export type TranscriptForm = "recent" | "period";

/**
 * Live-only transcript read. The first call derives the authoritative upper
 * message id (min of the optional caller upper bound and the chat's maximum
 * stored id) and freezes it inside the opaque cursor, so continuations are
 * stable against newer inserts. Dates are UTC ISO strings; the period start
 * is inclusive and the end exclusive.
 */
export type LiveTranscriptRequest =
  | {
      chatId: string;
      form: "recent";
      count: number;
      upperMessageId?: number;
    }
  | {
      chatId: string;
      form: "period";
      startInclusive: string;
      endExclusive: string;
      upperMessageId?: number;
    }
  | {
      chatId: string;
      form: TranscriptForm;
      cursor: string;
      /** Application-owned maximum upper bound for this continuation. */
      upperMessageId?: number;
    };

export type LiveTranscriptCoverage = {
  /** Frozen authoritative upper message id of this snapshot. */
  upperMessageId: number;
  /** Live rows the snapshot can reach (id-bounded; date-bounded for period). */
  totalAvailable: number;
  /** Rows returned by this page. */
  returnedCount: number;
  /** Rows covered by the snapshot so far, including this page. */
  coveredCount: number;
  firstMessageId?: number;
  lastMessageId?: number;
  firstDate?: string;
  lastDate?: string;
  /** Page rows whose text is empty or whitespace-only (media or empty). */
  emptyTextCount: number;
  /** Same value as emptyTextCount; kept for backward compatibility. */
  mediaOrEmptyTextCount: number;
  /** True when the requested snapshot needs more pages than this one. */
  truncated: boolean;
  /**
   * Rows that stay outside the requested snapshot even after full
   * pagination: older live rows beyond the recent budget, or undated rows
   * inside a period span.
   */
  omittedCount: number;
  hasMore: boolean;
  nextCursor?: string;
};

export type LiveTranscriptResult = {
  form: TranscriptForm;
  /** Chronological (message id ascending), deleted rows excluded. */
  messages: StoredMessage[];
  coverage: LiveTranscriptCoverage;
};

export type StoredEmbeddingChunk = {
  id: number;
  chatId: string;
  namespace: string;
  startMessageId: number;
  endMessageId: number;
  messageIds: number[];
  messageCount: number;
  text: string;
  model: string;
  dimensions: number;
  embedding: Uint8Array;
  contentHash: string;
  dirtyAt?: string;
  updatedAt: string;
};

/**
 * One learned sparse posting produced together with the parent chunk's dense
 * vector by a single local BGE-M3 encode pass. Token ids are vocabulary ids
 * of the parent model's tokenizer; weights are finite positive floats.
 */
export type SparseTerm = {
  tokenId: number;
  weight: number;
};

/** Scored sparse posting lookup result for one current parent chunk. */
export type SparseChunkScore = {
  chunkId: number;
  score: number;
};

export type StaleEmbeddingChunkReason =
  | "missing_message"
  | "deleted_message"
  | "source_changed";

export type StaleEmbeddingChunkRange = {
  chatId: string;
  startMessageId: number;
  endMessageId: number;
  reason: StaleEmbeddingChunkReason;
};

export type EmbeddingChunkCommitResult = {
  committedChunks: number;
  /**
   * Sum of messageCount for committed chunks. Overlap messages are counted
   * once per committed chunk, matching provider input accounting.
   */
  committedMessages: number;
  staleRanges: StaleEmbeddingChunkRange[];
  /**
   * End id of the last contiguous committed input before the first stale
   * chunk. It is intentionally absent when the first input is stale.
   */
  nextAfterMessageId?: number;
};

export type SendOutboxStatus = "queued" | "sending" | "sent" | "failed" | "expired";

export type SendStartupReconciliation = {
  expiredQueued: number;
  markedUnknownDelivery: number;
};

export type StoredSendOutboxItem = {
  id: string;
  dedupeKey?: string;
  payloadHash: string;
  chatId: string;
  replyToMessageId?: number;
  userKey: string;
  status: SendOutboxStatus;
  telegramMessageId?: number;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
  queuedAtMs?: number;
  sendingAtMs?: number;
  sentAtMs?: number;
  expiresAtMs: number;
};

export type SendReservation =
  | {
      kind: "queued";
      outboxId: string;
      expiresAtMs: number;
    }
  | {
      kind: "duplicate_sent";
      outboxId: string;
      chatId: string;
      telegramMessageId?: number;
    };

export type BotDurableStatus =
  | "queued"
  | "running"
  | "drafted"
  | "sending"
  | "sent"
  | "skipped"
  | "failed"
  | "lost_ack"
  | "dead_letter";

export type StoredBotUpdate = {
  updateId: number;
  rawJson: string;
  status: BotDurableStatus;
  addressed: boolean;
  chatId?: string;
  triggerMessageId?: number;
  attempts: number;
  maxAttempts: number;
  error?: string;
  receivedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

export type StoredBotTurn = {
  id: number;
  updateId: number;
  chatId: string;
  triggerMessageId: number;
  status: BotDurableStatus;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
  retryNotBeforeMs?: number;
  draftText?: string;
  telegramMessageId?: number;
  progressMessageId?: number;
  progressState?: BotTurnProgressState;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
};

export type BotTurnProgressState =
  | "none"
  | "dispatching"
  | "active"
  | "unknown";

export type StoredChatMemory = {
  chatId: string;
  memoryText: string;
  lastConsolidatedMessageId?: number;
  revision: number;
  updatedAtMs: number;
};

export type UpsertChatMemoryInput = Omit<
  StoredChatMemory,
  "revision" | "updatedAtMs"
> & {
  updatedAtMs?: number;
};

/**
 * Small, explicit notes that should affect the next turns immediately. They
 * are intentionally capped by storage and replace themselves by title.
 */
export type StoredFastChatMemory = {
  chatId: string;
  key: string;
  title: string;
  note: string;
  sourceMessageId?: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type UpsertFastChatMemoryInput = Omit<
  StoredFastChatMemory,
  "key" | "createdAtMs" | "updatedAtMs"
> & {
  updatedAtMs?: number;
};

/** A durable, structured "problem → solution → when to use it" lesson. */
export type StoredChatLesson = {
  chatId: string;
  key: string;
  title: string;
  problem: string;
  solution: string;
  whenToApply: string;
  sourceMessageId?: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type UpsertChatLessonInput = Omit<
  StoredChatLesson,
  "key" | "createdAtMs" | "updatedAtMs"
> & {
  updatedAtMs?: number;
};

/**
 * A chat-local reusable playbook. The description is the compact index; the
 * instructions are loaded only through the dedicated read tool when needed.
 */
export type StoredChatSkill = {
  chatId: string;
  key: string;
  name: string;
  description: string;
  instructions: string;
  sourceMessageId?: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type UpsertChatSkillInput = Omit<
  StoredChatSkill,
  "key" | "createdAtMs" | "updatedAtMs"
> & {
  updatedAtMs?: number;
};

export type DreamDayStatus = "pending" | "running" | "completed" | "failed";

export type StoredDreamDay = {
  chatId: string;
  day: string;
  status: DreamDayStatus;
  sourceHash?: string;
  interactionCount: number;
  firstMessageId?: number;
  lastMessageId?: number;
  attempts: number;
  error?: string;
  model?: string;
  provider?: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

export type UpsertDreamDayInput = Omit<
  StoredDreamDay,
  "createdAtMs" | "updatedAtMs"
> & {
  createdAtMs?: number;
  updatedAtMs?: number;
};

export type StoredDayDigest = {
  chatId: string;
  day: string;
  startMessageId: number;
  endMessageId: number;
  messageCount: number;
  text: string;
  promptVersion: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  sourceHash?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type StoredDigestRollup = {
  chatId: string;
  kind: "week" | "month";
  period: string;
  dayFrom: string;
  dayTo: string;
  dayCount: number;
  text: string;
  promptVersion: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  sourceHash?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type UpsertDayDigestInput = Omit<
  StoredDayDigest,
  "createdAtMs" | "updatedAtMs"
> & {
  createdAtMs?: number;
};

export type UpsertDigestRollupInput = Omit<
  StoredDigestRollup,
  "createdAtMs" | "updatedAtMs"
> & {
  createdAtMs?: number;
};

export type DigestMessageDateBounds = {
  firstDate: string;
  lastDate: string;
};

export interface MessageStoreOptions {
  /**
   * Opens an already-migrated database without changing its schema, journal
   * mode, or contents. This is used by inspection/dry-run entrypoints.
   */
  readOnly?: boolean;
}

export type BotUpdateIngestResult = {
  disposition: "ingested" | "recovered" | "duplicate";
  /**
   * A polling caller may advance its Telegram offset to this update only
   * after this result exists. It is returned after the inbox/message/turn
   * transaction commits.
   */
  ackUpdateId: number;
  update: StoredBotUpdate;
  turn?: StoredBotTurn;
  /**
   * Present only when an otherwise-addressed trigger was durably ingested but
   * intentionally did not reserve a turn because the persisted per-sender
   * debounce window was still active.
   */
  throttled?: {
    retryAfterMs: number;
  };
};

export type BotUpdateFailureResult = {
  update: StoredBotUpdate;
  /**
   * Poison updates become acknowledgeable only after their bounded retry
   * budget is exhausted and the durable row reaches dead_letter.
   */
  ackUpdateId?: number;
};
