import "./env-files.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  boolFromEnv,
  csvFromEnv,
  embeddingBackendFromEnv,
  intFromEnv,
  telegramTransportFromEnv,
} from "./env-parsers.js";
import { expandPath } from "./paths.js";
import type {
  AppConfig,
  TelegramAuthConfig,
} from "./types.js";
import {
  LOCAL_BGE_M3_DIMENSIONS,
  LOCAL_BGE_M3_MODEL,
} from "./types.js";
import {
  validateChatReferences,
  validateConfig,
  validateDefaultChatAllowlisted,
  validateRequiredApiCredentials,
} from "./validation.js";

export function loadConfig(): AppConfig {
  const telegram = loadTelegramAuthConfig();
  const dbPath = expandPath(
    process.env.TELEGRAM_DB_PATH ||
      "~/.telegram-parilka-mcp/messages.sqlite",
  );
  const authStoragePath = expandPath(
    process.env.TELEGRAM_MTCUTE_AUTH_DB_PATH?.trim() ||
      "~/.telegram-parilka-mcp/mtcute-auth.sqlite",
  );
  const embeddingApiKey =
    process.env.TELEGRAM_EMBEDDINGS_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  const embeddingDimensions = intFromEnv(
    "TELEGRAM_EMBEDDINGS_DIMENSIONS",
  );
  const embeddingBackend = embeddingBackendFromEnv();
  const embeddingLocal =
    embeddingBackend === "local_bge_m3";

  const config: AppConfig = {
    telegram: {
      ...telegram,
      transport: telegramTransportFromEnv(),
      mtcute: {
        authStoragePath,
        historyPageSize: intFromEnv(
          "TELEGRAM_MTCUTE_HISTORY_PAGE_SIZE",
        ),
        maxHistoryMessages: intFromEnv(
          "TELEGRAM_MTCUTE_MAX_HISTORY_MESSAGES",
        ),
        connectionMaxAttempts: intFromEnv(
          "TELEGRAM_MTCUTE_CONNECTION_MAX_ATTEMPTS",
        ),
        connectionTimeoutMs: intFromEnv(
          "TELEGRAM_MTCUTE_CONNECTION_TIMEOUT_MS",
        ),
        connectionRetryInitialMs: intFromEnv(
          "TELEGRAM_MTCUTE_CONNECTION_RETRY_INITIAL_MS",
        ),
        connectionRetryMaxMs: intFromEnv(
          "TELEGRAM_MTCUTE_CONNECTION_RETRY_MAX_MS",
        ),
        requestTimeoutMs: intFromEnv(
          "TELEGRAM_MTCUTE_REQUEST_TIMEOUT_MS",
        ),
        requestMaxRetries: intFromEnv(
          "TELEGRAM_MTCUTE_REQUEST_MAX_RETRIES",
        ),
        requestRetryDelayMs: intFromEnv(
          "TELEGRAM_MTCUTE_REQUEST_RETRY_DELAY_MS",
        ),
        floodWaitMaxMs: intFromEnv(
          "TELEGRAM_MTCUTE_FLOOD_WAIT_MAX_MS",
        ),
      },
      botSenderId: parseOptionalBotSenderId(),
    },
    storage: {
      dbPath,
    },
    safety: {
      sendEnabled: boolFromEnv("TELEGRAM_SEND_ENABLED"),
      dryRunDefault: boolFromEnv(
        "TELEGRAM_DRY_RUN_DEFAULT",
      ),
      maxSendChars: intFromEnv(
        "TELEGRAM_MAX_SEND_CHARS",
      ),
      liveSendApprovalTtlMs: intFromEnv(
        "TELEGRAM_LIVE_SEND_APPROVAL_TTL_MS",
      ),
      liveSendApprovalBypass: boolFromEnv(
        "TELEGRAM_LIVE_SEND_APPROVAL_BYPASS",
      ),
    },
    sync: {
      batchSize: intFromEnv(
        "TELEGRAM_HISTORY_BATCH_SIZE",
      ),
      maxSyncLimit: intFromEnv(
        "TELEGRAM_MAX_SYNC_LIMIT",
      ),
      floodWaitMaxSleepSec: intFromEnv(
        "TELEGRAM_FLOOD_WAIT_MAX_SLEEP_SEC",
      ),
      historyWaitTimeSec: intFromEnv(
        "TELEGRAM_HISTORY_WAIT_TIME_SEC",
      ),
      historyOperationTimeoutMs: intFromEnv(
        "TELEGRAM_HISTORY_OPERATION_TIMEOUT_MS",
      ),
      intervalMs: intFromEnv(
        "TELEGRAM_SYNC_INTERVAL_MS",
      ),
      recentLimit: intFromEnv(
        "TELEGRAM_SYNC_RECENT_LIMIT",
      ),
      backfillLimit: intFromEnv(
        "TELEGRAM_SYNC_BACKFILL_LIMIT",
      ),
      transientBackoffInitialMs: intFromEnv(
        "TELEGRAM_SYNC_BACKOFF_INITIAL_MS",
      ),
      transientBackoffMaxMs: intFromEnv(
        "TELEGRAM_SYNC_BACKOFF_MAX_MS",
      ),
    },
    embeddings: {
      enabled: boolFromEnv(
        "TELEGRAM_EMBEDDINGS_ENABLED",
      ),
      backend: embeddingBackend,
      // The local BGE-M3 backend is loopback-only and needs no credential;
      // an API key is never attached to local requests.
      apiKey: embeddingLocal ? "" : embeddingApiKey,
      baseUrl:
        process.env.TELEGRAM_EMBEDDINGS_BASE_URL?.trim() ||
        "https://api.openai.com/v1",
      localEndpoint:
        process.env.TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT?.trim() ||
        "",
      localRequestTimeoutMs: intFromEnv(
        "TELEGRAM_EMBEDDINGS_LOCAL_REQUEST_TIMEOUT_MS",
      ),
      rerankTimeoutMs: intFromEnv(
        "TELEGRAM_EMBEDDINGS_RERANK_TIMEOUT_MS",
      ),
      rerankMaxCandidates: intFromEnv(
        "TELEGRAM_EMBEDDINGS_RERANK_MAX_CANDIDATES",
      ),
      model: embeddingLocal
        ? LOCAL_BGE_M3_MODEL
        : process.env.TELEGRAM_EMBEDDINGS_MODEL?.trim() ||
          "text-embedding-3-small",
      dimensions: embeddingLocal
        ? LOCAL_BGE_M3_DIMENSIONS
        : embeddingDimensions,
      apiBatchSize: intFromEnv(
        "TELEGRAM_EMBEDDINGS_API_BATCH_SIZE",
      ),
      requestTimeoutMs: intFromEnv(
        "TELEGRAM_EMBEDDINGS_REQUEST_TIMEOUT_MS",
      ),
      maxRetries: intFromEnv(
        "TELEGRAM_EMBEDDINGS_MAX_RETRIES",
      ),
      retryInitialMs: intFromEnv(
        "TELEGRAM_EMBEDDINGS_RETRY_INITIAL_MS",
      ),
      retryMaxMs: intFromEnv(
        "TELEGRAM_EMBEDDINGS_RETRY_MAX_MS",
      ),
      tickIntervalMs: intFromEnv(
        "TELEGRAM_EMBEDDINGS_TICK_INTERVAL_MS",
      ),
      tickBudgetMs: intFromEnv(
        "TELEGRAM_EMBEDDINGS_TICK_BUDGET_MS",
      ),
      chunkMessages: intFromEnv(
        "TELEGRAM_EMBEDDINGS_CHUNK_MESSAGES",
      ),
      chunkOverlapMessages: intFromEnv(
        "TELEGRAM_EMBEDDINGS_CHUNK_OVERLAP_MESSAGES",
      ),
      chunkMaxChars: intFromEnv(
        "TELEGRAM_EMBEDDINGS_CHUNK_MAX_CHARS",
      ),
      tickChunkLimit: intFromEnv(
        "TELEGRAM_EMBEDDINGS_TICK_CHUNK_LIMIT",
      ),
      maxChunksPerRun: intFromEnv(
        "TELEGRAM_EMBEDDINGS_MAX_CHUNKS_PER_RUN",
      ),
      maxCharsPerRun: intFromEnv(
        "TELEGRAM_EMBEDDINGS_MAX_CHARS_PER_RUN",
      ),
      vectorCandidateLimit: intFromEnv(
        "TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT",
      ),
      searchLimit: intFromEnv(
        "TELEGRAM_EMBEDDINGS_SEARCH_LIMIT",
      ),
    },
    throttle: {
      userCooldownMs: intFromEnv(
        "TELEGRAM_USER_COOLDOWN_MS",
      ),
      maxPendingPerUserPerChat: intFromEnv(
        "TELEGRAM_MAX_PENDING_PER_USER_PER_CHAT",
      ),
      maxQueuePerChat: intFromEnv(
        "TELEGRAM_MAX_QUEUE_PER_CHAT",
      ),
      maxAgeMs: intFromEnv(
        "TELEGRAM_QUEUE_MAX_AGE_MS",
      ),
      globalConcurrency: intFromEnv(
        "TELEGRAM_GLOBAL_CONCURRENCY",
      ),
      maxRunningPerChat: intFromEnv(
        "TELEGRAM_MAX_RUNNING_PER_CHAT",
      ),
    },
    memory: {
      memoryMaxChars: intFromEnv(
        "PARILKA_MEMORY_MAX_CHARS",
      ),
    },
    hermesProjection: {
      enabled: boolFromEnv(
        "PARILKA_HERMES_PROJECTION_ENABLED",
      ),
    },
  };

  validateConfig(config);
  mkdirSync(dirname(config.storage.dbPath), {
    recursive: true,
  });
  return config;
}

export function loadTelegramAuthConfig(
  options: {
    requireApiCredentials?: boolean;
    requireChatConfig?: boolean;
  } = {},
): TelegramAuthConfig {
  const apiId = intFromEnv("TELEGRAM_API_ID");
  const apiHash =
    process.env.TELEGRAM_API_HASH?.trim() || "";
  validateRequiredApiCredentials(
    apiId,
    apiHash,
    options.requireApiCredentials,
  );

  const defaultChatId =
    process.env.TELEGRAM_DEFAULT_CHAT_ID?.trim() || "";
  const allowedChatIds = csvFromEnv(
    process.env.TELEGRAM_ALLOWED_CHAT_IDS,
  );
  const requireChatConfig =
    options.requireChatConfig !== false;
  validateChatReferences(
    defaultChatId,
    allowedChatIds,
    requireChatConfig,
  );

  const requireAllowlistedChat = boolFromEnv(
    "TELEGRAM_REQUIRE_ALLOWLIST",
  );
  validateDefaultChatAllowlisted(
    defaultChatId,
    allowedChatIds,
    requireChatConfig,
    requireAllowlistedChat,
  );

  return {
    apiId,
    apiHash,
    session:
      process.env.TELEGRAM_SESSION?.trim() ||
      process.env.TELEGRAM_SESSION_STRING_PERSONAL?.trim() ||
      process.env.TELEGRAM_SESSION_STRING_WIFE?.trim() ||
      process.env.SESSION?.trim() ||
      "",
    phone: process.env.TELEGRAM_PHONE?.trim() || "",
    defaultChatId,
    allowedChatIds,
    requireAllowlistedChat,
    connectionRetries: intFromEnv(
      "TELEGRAM_CONNECTION_RETRIES",
    ),
  };
}

/**
 * Optional bot Telegram user id. The value must be a positive decimal string
 * without a leading zero that stays within the JavaScript safe integer range
 * (up to 16 digits, i.e. MAX_SAFE_INTEGER); empty/unset yields undefined.
 * This is deliberately not imported from bot runtime config to keep MCP
 * config self-contained.
 */
function parseOptionalBotSenderId(): string | undefined {
  const raw = process.env.PARILKA_BOT_ID?.trim();
  if (raw == null || raw === "") {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      "PARILKA_BOT_ID must be a positive decimal integer without a leading zero.",
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      "PARILKA_BOT_ID must not exceed the JavaScript safe integer range.",
    );
  }
  return raw;
}
