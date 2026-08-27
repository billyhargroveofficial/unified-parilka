import type {
  KeywordSearchHit,
  MessageStore,
} from "../store.js";
import type { EmbeddingRuntimeConfig } from "../embeddings.js";
import {
  createVectorBackend,
  type VectorBackend,
} from "./backend.js";
import {
  fuseHybridSearch,
  fuseRankedChannels,
  type ChannelFusedHit,
  type RetrievalChannelInput,
} from "./fusion.js";
import { VectorIndexer } from "./indexer.js";
import { VectorSearcher } from "./search.js";
import type {
  EmbeddingIndexEstimate,
  EmbeddingIndexResult,
  HybridSearchHit,
  VectorIndexParams,
  VectorSearchParams,
  VectorSearchHit,
  VectorSearchResult,
} from "./types.js";

export type VectorRerankResult = {
  available: boolean;
  scores?: number[];
  error?: string;
};

export class VectorRag {
  readonly #backend: VectorBackend;
  readonly #indexer: VectorIndexer;
  readonly #searcher: VectorSearcher;

  constructor(
    config: EmbeddingRuntimeConfig,
    store: MessageStore,
  ) {
    this.#backend = createVectorBackend(config);
    this.#indexer = new VectorIndexer(
      config,
      store,
      this.#backend,
      this.#backend.namespace,
    );
    this.#searcher = new VectorSearcher(
      config,
      store,
      this.#backend,
      this.#backend.namespace,
    );
  }

  get isConfigured(): boolean {
    return this.#backend.isConfigured;
  }

  get backendKind(): "external_openai" | "local_bge_m3" {
    return this.#backend.kind;
  }

  get supportsSparse(): boolean {
    return this.#backend.supportsSparse;
  }

  get supportsRerank(): boolean {
    return this.#backend.supportsRerank;
  }

  indexCachedMessages(
    params: VectorIndexParams,
  ): Promise<EmbeddingIndexResult> {
    return this.#indexer.indexCachedMessages(params);
  }

  estimateIndexCachedMessages(params: {
    chatId: string;
    limitChunks?: number;
    afterMessageId?: number;
    rebuild?: boolean;
  }): EmbeddingIndexEstimate {
    return this.#indexer.estimateIndexCachedMessages(params);
  }

  search(params: VectorSearchParams): Promise<VectorSearchResult> {
    return this.#searcher.search(params);
  }

  /** Legacy two-channel RRF kept for the MCP search_messages contract. */
  hybrid(
    keywordHits: KeywordSearchHit[],
    vectorHits: VectorSearchHit[],
    limit: number,
  ): HybridSearchHit[] {
    return fuseHybridSearch(keywordHits, vectorHits, limit);
  }

  /** Deterministic N-channel RRF over named bm25/dense/sparse channels. */
  fuseChannels(
    channels: readonly RetrievalChannelInput[],
    limit: number,
  ): ChannelFusedHit[] {
    return fuseRankedChannels(channels, limit);
  }

  /**
   * Optional bounded ColBERT late-interaction rerank. Never fatal: any
   * failure reports `available: false` and callers keep first-stage order.
   */
  async rerank(params: {
    query: string;
    candidates: string[];
    signal?: AbortSignal;
  }): Promise<VectorRerankResult> {
    if (!this.#backend.supportsRerank) {
      return {
        available: false,
        error:
          "ColBERT rerank requires the local BGE-M3 backend.",
      };
    }
    if (!this.#backend.isConfigured) {
      return {
        available: false,
        error:
          "Local BGE-M3 service is not configured; rerank is skipped.",
      };
    }
    if (params.candidates.length === 0) {
      return { available: true, scores: [] };
    }
    try {
      const scores = await this.#backend.rerank(
        params.query,
        params.candidates,
        params.signal,
      );
      return { available: true, scores };
    } catch (error) {
      if (params.signal?.aborted) {
        throw error;
      }
      return {
        available: false,
        error:
          error instanceof Error
            ? error.message
            : "Rerank failed.",
      };
    }
  }
}
