import type { EmbeddingRuntimeConfig } from "../../embeddings.js";

const DEFAULT_LOCAL_BGE_ENDPOINT = "http://127.0.0.1:8767";
/**
 * At 1,024 float dimensions this bounds a dense pass to roughly 200 MiB of
 * raw vector payload while covering the current ~23k-chunk production index.
 */
const BOT_DENSE_CANDIDATE_LIMIT = 50_000;

export interface BotRagRuntimeConfig {
  readonly vector: EmbeddingRuntimeConfig;
  readonly rerankMaxCandidates: number;
  readonly automaticTimeoutMs: number;
}

/**
 * Builds the bot's read-only retrieval slice without loading MTProto, Telegram
 * session, or external embedding credentials. The production backend is fixed
 * to the operator-owned loopback BGE-M3 service; BM25 remains the fallback.
 */
export function parseBotRagRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): BotRagRuntimeConfig {
  const endpoint = loopbackHttpOrigin(
    optional(env.PARILKA_BOT_RAG_LOCAL_ENDPOINT) ??
      DEFAULT_LOCAL_BGE_ENDPOINT,
  );
  const localRequestTimeoutMs = integer(
    env.PARILKA_BOT_RAG_LOCAL_REQUEST_TIMEOUT_MS,
    2_000,
    100,
    10_000,
    "PARILKA_BOT_RAG_LOCAL_REQUEST_TIMEOUT_MS",
  );
  const rerankTimeoutMs = integer(
    env.PARILKA_BOT_RAG_RERANK_TIMEOUT_MS,
    2_000,
    100,
    10_000,
    "PARILKA_BOT_RAG_RERANK_TIMEOUT_MS",
  );
  const rerankMaxCandidates = integer(
    env.PARILKA_BOT_RAG_RERANK_MAX_CANDIDATES,
    8,
    0,
    16,
    "PARILKA_BOT_RAG_RERANK_MAX_CANDIDATES",
  );
  const automaticTimeoutMs = integer(
    env.PARILKA_BOT_RAG_AUTOMATIC_TIMEOUT_MS,
    2_500,
    100,
    10_000,
    "PARILKA_BOT_RAG_AUTOMATIC_TIMEOUT_MS",
  );

  return {
    rerankMaxCandidates,
    automaticTimeoutMs,
    vector: {
      embeddings: {
        enabled: true,
        backend: "local_bge_m3",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        localEndpoint: endpoint,
        localRequestTimeoutMs,
        rerankTimeoutMs,
        rerankMaxCandidates,
        model: "bge-m3",
        dimensions: 1_024,
        apiBatchSize: 64,
        requestTimeoutMs: 60_000,
        maxRetries: 0,
        retryInitialMs: 0,
        retryMaxMs: 0,
        tickIntervalMs: 60_000,
        tickBudgetMs: 30_000,
        chunkMessages: 12,
        chunkOverlapMessages: 0,
        chunkMaxChars: 1_600,
        tickChunkLimit: 100,
        maxChunksPerRun: 1_000,
        maxCharsPerRun: 500_000,
        vectorCandidateLimit: BOT_DENSE_CANDIDATE_LIMIT,
        searchLimit: 12,
      },
    },
  };
}

function loopbackHttpOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PARILKA_BOT_RAG_LOCAL_ENDPOINT must be a loopback HTTP origin.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PARILKA_BOT_RAG_LOCAL_ENDPOINT must be a loopback HTTP origin.");
  }
  return url.origin;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function integer(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const value = optional(raw) === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
