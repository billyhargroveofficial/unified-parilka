const INT32_MAX = 2_147_483_647;

export type NumericEnvRule = {
  fallback: number;
  min: number;
  max: number;
};

export type BooleanEnvRule = {
  fallback: boolean;
};

export const NUMERIC_ENV_RULES = {
  TELEGRAM_API_ID: {
    fallback: 0,
    min: 0,
    max: INT32_MAX,
  },
  TELEGRAM_CONNECTION_RETRIES: {
    fallback: 5,
    min: 0,
    max: 100,
  },
  TELEGRAM_MTCUTE_HISTORY_PAGE_SIZE: {
    fallback: 100,
    min: 1,
    max: 100,
  },
  TELEGRAM_MTCUTE_MAX_HISTORY_MESSAGES: {
    fallback: 1_000_000,
    min: 1,
    max: 1_000_000,
  },
  TELEGRAM_MTCUTE_CONNECTION_MAX_ATTEMPTS: {
    fallback: 5,
    min: 1,
    max: 100,
  },
  TELEGRAM_MTCUTE_CONNECTION_TIMEOUT_MS: {
    fallback: 30_000,
    min: 100,
    max: 10 * 60_000,
  },
  TELEGRAM_MTCUTE_CONNECTION_RETRY_INITIAL_MS: {
    fallback: 250,
    min: 0,
    max: 60_000,
  },
  TELEGRAM_MTCUTE_CONNECTION_RETRY_MAX_MS: {
    fallback: 4_000,
    min: 0,
    max: 300_000,
  },
  TELEGRAM_MTCUTE_REQUEST_TIMEOUT_MS: {
    fallback: 120_000,
    min: 100,
    max: 24 * 60 * 60_000,
  },
  TELEGRAM_MTCUTE_REQUEST_MAX_RETRIES: {
    fallback: 2,
    min: 0,
    max: 20,
  },
  TELEGRAM_MTCUTE_REQUEST_RETRY_DELAY_MS: {
    fallback: 1_000,
    min: 0,
    max: 60_000,
  },
  TELEGRAM_MTCUTE_FLOOD_WAIT_MAX_MS: {
    fallback: 10_000,
    min: 0,
    max: 24 * 60 * 60_000,
  },
  TELEGRAM_MAX_SEND_CHARS: {
    fallback: 4096,
    min: 1,
    max: 35_000,
  },
  TELEGRAM_LIVE_SEND_APPROVAL_TTL_MS: {
    fallback: 5 * 60_000,
    min: 1_000,
    max: 24 * 60 * 60_000,
  },
  TELEGRAM_HISTORY_BATCH_SIZE: {
    fallback: 100,
    min: 1,
    max: 1_000,
  },
  TELEGRAM_MAX_SYNC_LIMIT: {
    fallback: 500_000,
    min: 1,
    max: 1_000_000,
  },
  TELEGRAM_FLOOD_WAIT_MAX_SLEEP_SEC: {
    fallback: 10,
    min: 0,
    max: 24 * 60 * 60,
  },
  TELEGRAM_HISTORY_WAIT_TIME_SEC: {
    fallback: 1,
    min: 0,
    max: 60,
  },
  TELEGRAM_HISTORY_OPERATION_TIMEOUT_MS: {
    fallback: 120_000,
    min: 100,
    max: 24 * 60 * 60_000,
  },
  TELEGRAM_SYNC_INTERVAL_MS: {
    fallback: 60_000,
    min: 1_000,
    max: 24 * 60 * 60_000,
  },
  TELEGRAM_SYNC_RECENT_LIMIT: {
    fallback: 300,
    min: 0,
    max: 1_000_000,
  },
  TELEGRAM_SYNC_BACKFILL_LIMIT: {
    fallback: 1_000,
    min: 0,
    max: 1_000_000,
  },
  TELEGRAM_SYNC_BACKOFF_INITIAL_MS: {
    fallback: 5_000,
    min: 1_000,
    max: 60 * 60_000,
  },
  TELEGRAM_SYNC_BACKOFF_MAX_MS: {
    fallback: 5 * 60_000,
    min: 1_000,
    max: 24 * 60 * 60_000,
  },
  TELEGRAM_EMBEDDINGS_DIMENSIONS: {
    fallback: 256,
    min: 1,
    max: 16_384,
  },
  TELEGRAM_EMBEDDINGS_LOCAL_REQUEST_TIMEOUT_MS: {
    fallback: 30_000,
    min: 100,
    max: 10 * 60_000,
  },
  TELEGRAM_EMBEDDINGS_RERANK_TIMEOUT_MS: {
    fallback: 10_000,
    min: 100,
    max: 10 * 60_000,
  },
  TELEGRAM_EMBEDDINGS_RERANK_MAX_CANDIDATES: {
    fallback: 0,
    min: 0,
    max: 32,
  },
  TELEGRAM_EMBEDDINGS_API_BATCH_SIZE: {
    fallback: 64,
    min: 1,
    max: 2_048,
  },
  TELEGRAM_EMBEDDINGS_REQUEST_TIMEOUT_MS: {
    fallback: 60_000,
    min: 100,
    max: 60 * 60_000,
  },
  TELEGRAM_EMBEDDINGS_MAX_RETRIES: {
    fallback: 2,
    min: 0,
    max: 10,
  },
  TELEGRAM_EMBEDDINGS_RETRY_INITIAL_MS: {
    fallback: 1_000,
    min: 0,
    max: 60 * 60_000,
  },
  TELEGRAM_EMBEDDINGS_RETRY_MAX_MS: {
    fallback: 30_000,
    min: 0,
    max: 60 * 60_000,
  },
  TELEGRAM_EMBEDDINGS_TICK_INTERVAL_MS: {
    fallback: 60_000,
    min: 1_000,
    max: 24 * 60 * 60_000,
  },
  TELEGRAM_EMBEDDINGS_TICK_BUDGET_MS: {
    fallback: 30_000,
    min: 100,
    max: 15 * 60_000,
  },
  TELEGRAM_EMBEDDINGS_CHUNK_MESSAGES: {
    fallback: 12,
    min: 1,
    max: 1_000,
  },
  TELEGRAM_EMBEDDINGS_CHUNK_OVERLAP_MESSAGES: {
    fallback: 0,
    min: 0,
    max: 1_000,
  },
  TELEGRAM_EMBEDDINGS_CHUNK_MAX_CHARS: {
    fallback: 1600,
    min: 1,
    max: 200_000,
  },
  TELEGRAM_EMBEDDINGS_TICK_CHUNK_LIMIT: {
    fallback: 100,
    min: 1,
    max: 100_000,
  },
  TELEGRAM_EMBEDDINGS_MAX_CHUNKS_PER_RUN: {
    fallback: 1_000,
    min: 1,
    max: 100_000,
  },
  TELEGRAM_EMBEDDINGS_MAX_CHARS_PER_RUN: {
    fallback: 500_000,
    min: 1,
    max: 50_000_000,
  },
  TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT: {
    fallback: 20_000,
    min: 1,
    max: 1_000_000,
  },
  TELEGRAM_EMBEDDINGS_SEARCH_LIMIT: {
    fallback: 12,
    min: 1,
    max: 1_000,
  },
  TELEGRAM_USER_COOLDOWN_MS: {
    fallback: 20_000,
    min: 0,
    max: 24 * 60 * 60_000,
  },
  TELEGRAM_MAX_PENDING_PER_USER_PER_CHAT: {
    fallback: 1,
    min: 1,
    max: 1_000,
  },
  TELEGRAM_MAX_QUEUE_PER_CHAT: {
    fallback: 25,
    min: 1,
    max: 100_000,
  },
  PARILKA_MEMORY_MAX_CHARS: {
    fallback: 2_000,
    min: 500,
    max: 4_000,
  },
  TELEGRAM_QUEUE_MAX_AGE_MS: {
    fallback: 2 * 60_000,
    min: 1_000,
    max: 24 * 60 * 60_000,
  },
  TELEGRAM_GLOBAL_CONCURRENCY: {
    fallback: 2,
    min: 1,
    max: 1_000,
  },
  TELEGRAM_MAX_RUNNING_PER_CHAT: {
    fallback: 1,
    min: 1,
    max: 1_000,
  },
} as const satisfies Record<string, NumericEnvRule>;

export const BOOLEAN_ENV_RULES = {
  TELEGRAM_REQUIRE_ALLOWLIST: { fallback: true },
  TELEGRAM_SEND_ENABLED: { fallback: false },
  TELEGRAM_DRY_RUN_DEFAULT: { fallback: true },
  TELEGRAM_LIVE_SEND_APPROVAL_BYPASS: {
    fallback: false,
  },
  TELEGRAM_EMBEDDINGS_ENABLED: { fallback: false },
} as const satisfies Record<string, BooleanEnvRule>;
