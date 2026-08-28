import type { AppConfig } from "../config.js";
import type { EmbeddingBackendKind } from "../config/types.js";
import {
  LOCAL_BGE_M3_DIMENSIONS,
  LOCAL_BGE_M3_MODEL,
} from "../config/types.js";
import {
  EmbeddingClient,
  embeddingNamespace,
  localBgeM3Namespace,
  normalizeVector,
  vectorToBlob,
  type EmbeddingChunkInput,
  type EmbeddingChunkVector,
} from "../embeddings.js";
import { fingerprintEmbeddingSource } from "../embedding-source.js";
import { ToolError } from "../errors.js";
import type { SparseTerm } from "../store.js";
import {
  LOCAL_ENCODE_MAX_BATCH,
  LocalBgeM3Client,
} from "./bge-client.js";

export type EncodedQuery = {
  dense: number[];
  sparseTerms: SparseTerm[];
};

/**
 * The single encode/query boundary used by the vector slice. The external
 * OpenAI-compatible backend is dense-only and backward compatible; the local
 * BGE-M3 backend emits dense + learned sparse in one encode pass and offers
 * the bounded ColBERT rerank.
 */
export interface VectorBackend {
  readonly kind: EmbeddingBackendKind;
  readonly model: string;
  readonly dimensions: number | undefined;
  readonly namespace: string;
  readonly supportsSparse: boolean;
  readonly supportsRerank: boolean;
  readonly maxEncodeBatch: number;
  readonly isConfigured: boolean;
  assertConfigured(): void;
  providerLabel(): string;
  privacyNotice(): string;
  encodeChunks(
    chunks: EmbeddingChunkInput[],
    signal?: AbortSignal,
  ): Promise<EmbeddingChunkVector[]>;
  encodeQuery(
    query: string,
    signal?: AbortSignal,
  ): Promise<EncodedQuery>;
  rerank(
    query: string,
    candidates: string[],
    signal?: AbortSignal,
  ): Promise<number[]>;
}

export function createVectorBackend(
  config: AppConfig,
): VectorBackend {
  if (config.embeddings.backend === "local_bge_m3") {
    return new LocalBgeM3Backend(config);
  }
  return new ExternalOpenAiBackend(config);
}

class ExternalOpenAiBackend implements VectorBackend {
  readonly kind = "external_openai" as const;
  readonly #client: EmbeddingClient;
  readonly #config: AppConfig;

  constructor(config: AppConfig) {
    this.#config = config;
    this.#client = new EmbeddingClient(config);
  }

  get model(): string {
    return this.#config.embeddings.model;
  }

  get dimensions(): number | undefined {
    return this.#config.embeddings.dimensions;
  }

  get namespace(): string {
    return embeddingNamespace(this.#config);
  }

  get supportsSparse(): boolean {
    return false;
  }

  get supportsRerank(): boolean {
    return false;
  }

  get maxEncodeBatch(): number {
    return this.#config.embeddings.apiBatchSize;
  }

  get isConfigured(): boolean {
    return this.#client.isConfigured;
  }

  assertConfigured(): void {
    this.#client.assertConfigured();
  }

  providerLabel(): string {
    try {
      const host = new URL(this.#config.embeddings.baseUrl).hostname;
      return host.endsWith("openai.com")
        ? "OpenAI"
        : `OpenAI-compatible (${host})`;
    } catch {
      return "OpenAI-compatible";
    }
  }

  privacyNotice(): string {
    return "Embedding indexing sends cached Telegram message text to the configured external embeddings provider.";
  }

  encodeChunks(
    chunks: EmbeddingChunkInput[],
    signal?: AbortSignal,
  ): Promise<EmbeddingChunkVector[]> {
    return this.#client.embedChunks(chunks, signal);
  }

  async encodeQuery(
    query: string,
    signal?: AbortSignal,
  ): Promise<EncodedQuery> {
    return {
      dense: await this.#client.embedQuery(query, signal),
      sparseTerms: [],
    };
  }

  rerank(): Promise<number[]> {
    throw new ToolError({
      category: "internal",
      retryable: false,
      message:
        "ColBERT rerank requires the local BGE-M3 backend; the external provider has no late-interaction channel.",
    });
  }
}

class LocalBgeM3Backend implements VectorBackend {
  readonly kind = "local_bge_m3" as const;
  readonly #client: LocalBgeM3Client;
  readonly #config: AppConfig;

  constructor(config: AppConfig) {
    this.#config = config;
    this.#client = new LocalBgeM3Client(config);
  }

  get model(): string {
    return LOCAL_BGE_M3_MODEL;
  }

  get dimensions(): number {
    return LOCAL_BGE_M3_DIMENSIONS;
  }

  get namespace(): string {
    return localBgeM3Namespace(this.model, this.dimensions);
  }

  get supportsSparse(): boolean {
    return true;
  }

  get supportsRerank(): boolean {
    return true;
  }

  get maxEncodeBatch(): number {
    return Math.min(
      this.#config.embeddings.apiBatchSize,
      LOCAL_ENCODE_MAX_BATCH,
    );
  }

  get isConfigured(): boolean {
    return this.#client.isConfigured;
  }

  assertConfigured(): void {
    this.#client.assertConfigured();
  }

  providerLabel(): string {
    return "Local BGE-M3 (loopback)";
  }

  privacyNotice(): string {
    return "Embedding indexing runs on the operator-owned local loopback BGE-M3 service; cached message text does not leave this machine.";
  }

  async encodeChunks(
    chunks: EmbeddingChunkInput[],
    signal?: AbortSignal,
  ): Promise<EmbeddingChunkVector[]> {
    const encoded = await this.#client.encodeTexts(
      chunks.map((chunk) => chunk.text),
      signal,
    );
    return chunks.map((chunk, index) => {
      const result = encoded[index];
      const normalized = normalizeVector(result.dense);
      return {
        ...chunk,
        namespace: this.namespace,
        model: this.model,
        dimensions: normalized.length,
        embedding: vectorToBlob(normalized),
        contentHash: fingerprintEmbeddingSource(chunk.text),
        sparseTerms: result.sparseTerms,
      };
    });
  }

  async encodeQuery(
    query: string,
    signal?: AbortSignal,
  ): Promise<EncodedQuery> {
    const encoded = await this.#client.encodeQuery(query, signal);
    return {
      dense: normalizeVector(encoded.dense),
      sparseTerms: encoded.sparseTerms,
    };
  }

  rerank(
    query: string,
    candidates: string[],
    signal?: AbortSignal,
  ): Promise<number[]> {
    return this.#client.rerank(query, candidates, signal);
  }
}
