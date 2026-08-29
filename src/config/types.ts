import { z } from "zod";

export const ToolSchemas = {
  chatRef: z.string().min(1).optional(),
};

export type TelegramTransport = "mtcute" | "gramjs";

export type EmbeddingBackendKind =
  | "external_openai"
  | "local_bge_m3";

/** Fixed identity of the local BGE-M3 backend; validated, not configurable. */
export const LOCAL_BGE_M3_MODEL = "bge-m3";
export const LOCAL_BGE_M3_DIMENSIONS = 1024;
/**
 * Shared per-text character bound of the local BGE-M3 wire contract; config
 * validation refuses chunk windows wider than the service can accept.
 */
export const LOCAL_BGE_M3_MAX_TEXT_CHARS = 8_000;

export type TelegramAuthConfig = {
  apiId: number;
  apiHash: string;
  session: string;
  phone: string;
  defaultChatId: string;
  allowedChatIds: string[];
  requireAllowlistedChat: boolean;
  connectionRetries: number;
};

export type MtcuteRuntimeConfig = {
  authStoragePath: string;
  historyPageSize: number;
  maxHistoryMessages: number;
  connectionMaxAttempts: number;
  connectionTimeoutMs: number;
  connectionRetryInitialMs: number;
  connectionRetryMaxMs: number;
  requestTimeoutMs: number;
  requestMaxRetries: number;
  requestRetryDelayMs: number;
  floodWaitMaxMs: number;
};

export type AppConfig = {
  telegram: TelegramAuthConfig & {
    transport: TelegramTransport;
    mtcute: MtcuteRuntimeConfig;
    /** Durable Telegram user id of this bot; undefined when unconfigured. */
    botSenderId?: string;
  };
  storage: {
    dbPath: string;
  };
  safety: {
    sendEnabled: boolean;
    dryRunDefault: boolean;
    maxSendChars: number;
    liveSendApprovalTtlMs: number;
    liveSendApprovalBypass: boolean;
  };
  sync: {
    batchSize: number;
    maxSyncLimit: number;
    floodWaitMaxSleepSec: number;
    historyWaitTimeSec: number;
    historyOperationTimeoutMs: number;
    intervalMs: number;
    recentLimit: number;
    backfillLimit: number;
    transientBackoffInitialMs: number;
    transientBackoffMaxMs: number;
  };
  embeddings: {
    enabled: boolean;
    /**
     * external_openai keeps the backward-compatible OpenAI-compatible HTTPS
     * provider; local_bge_m3 is the recommended production path and talks to
     * the operator-owned loopback BGE-M3 service (dense + learned sparse in
     * one encode, optional bounded ColBERT rerank).
     */
    backend: EmbeddingBackendKind;
    apiKey: string;
    baseUrl: string;
    /** Loopback BGE-M3 service origin; required for backend local_bge_m3. */
    localEndpoint: string;
    localRequestTimeoutMs: number;
    rerankTimeoutMs: number;
    /** 0 disables the optional bounded ColBERT top-K rerank. Hard max 32. */
    rerankMaxCandidates: number;
    model: string;
    dimensions?: number;
    apiBatchSize: number;
    requestTimeoutMs: number;
    maxRetries: number;
    retryInitialMs: number;
    retryMaxMs: number;
    tickIntervalMs: number;
    tickBudgetMs: number;
    chunkMessages: number;
    chunkOverlapMessages: number;
    chunkMaxChars: number;
    tickChunkLimit: number;
    maxChunksPerRun: number;
    maxCharsPerRun: number;
    vectorCandidateLimit: number;
    searchLimit: number;
  };
  throttle: {
    userCooldownMs: number;
    maxPendingPerUserPerChat: number;
    maxQueuePerChat: number;
    maxAgeMs: number;
    globalConcurrency: number;
    maxRunningPerChat: number;
  };
  memory: {
    memoryMaxChars: number;
  };
  /**
   * Populated by loadConfig for every production config; optional only so
   * hand-built test/smoke configs do not need the section.
   */
  hermesProjection?: {
    /**
     * Kill switch for the Hermes profile projection apply pass. 1/true/yes
     * enables it; missing/empty/false leaves the profile untouched.
     */
    enabled: boolean;
  };
  openclawProjection?: {
    /**
     * Kill switch for the OpenClaw workspace projection apply pass. 1/true/yes
     * enables it; missing/empty/false leaves the workspace untouched.
     */
    enabled: boolean;
  };
};
