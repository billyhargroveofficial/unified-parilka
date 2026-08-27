import {
  createBlobCosineScorer,
  type EmbeddingRuntimeConfig,
} from "../embeddings.js";
import { ToolError } from "../errors.js";
import {
  MessageStore,
  type SparseChunkHit,
  type StoredEmbeddingChunk,
} from "../store.js";
import type { VectorBackend } from "./backend.js";
import { formatMessage } from "./source-formatter.js";
import type {
  VectorSearchHit,
  VectorSearchParams,
  VectorSearchResult,
} from "./types.js";

export class VectorSearcher {
  constructor(
    private readonly config: EmbeddingRuntimeConfig,
    private readonly store: MessageStore,
    private readonly backend: VectorBackend,
    private readonly namespace: string,
  ) {}

  async search(
    params: VectorSearchParams,
  ): Promise<VectorSearchResult> {
    // Per-turn availability needs only the exact index metadata. Coverage is
    // retained for diagnostics/indexing through getEmbeddingStats, because a
    // full corpus coverage scan here would dominate every interactive search.
    const stats = this.store.getEmbeddingSearchStats(params.chatId, {
      namespace: this.namespace,
    });
    if (
      this.store.isMaintenanceJobPending(
        "embedding_chunk_membership_backfill",
      )
    ) {
      return {
        available: false,
        error:
          "Vector search is temporarily unavailable while chunk membership backfill is pending. Run state maintenance with --apply.",
        backend: this.backend.kind,
        stats,
        hits: [],
        sparseHits: [],
      };
    }
    if (!this.backend.isConfigured) {
      return {
        available: false,
        error: this.unconfiguredError(),
        backend: this.backend.kind,
        stats,
        hits: [],
        sparseHits: [],
      };
    }
    if (stats.length === 0) {
      return {
        available: false,
        error:
          "No vector chunks indexed yet. Run index_embeddings first.",
        backend: this.backend.kind,
        stats,
        hits: [],
        sparseHits: [],
      };
    }

    const limit = Math.max(
      1,
      Math.min(
        params.limit ?? this.config.embeddings.searchLimit,
        50,
      ),
    );
    // One encode pass yields the dense vector and, for the local BGE-M3
    // backend, the learned sparse query terms. A failure here breaks both
    // first-stage channels, so it still throws.
    const encoded = await this.backend.encodeQuery(
      params.query,
      params.signal,
    );
    const searchDimensions =
      this.backend.dimensions ?? encoded.dense.length;
    const window = {
      beforeId: params.beforeId,
      afterId: params.afterId,
    };
    const includeMessages = params.includeMessages ?? true;

    // Dense and sparse first-stage retrievals are isolated: a dense-only
    // failure (candidate cap, corrupt blob, dimension mismatch) degrades the
    // dense channel without killing learned sparse.
    const dense = this.runDenseChannel({
      chatId: params.chatId,
      queryVector: encoded.dense,
      searchDimensions,
      limit,
      includeMessages,
      window,
    });

    const sparse = this.runSparseChannel({
      params,
      encodedSparseTerms: encoded.sparseTerms,
      searchDimensions,
      candidateLimit: this.config.embeddings.vectorCandidateLimit,
      limit,
      includeMessages,
      window,
    });

    return {
      available: dense.available,
      ...(dense.error === undefined ? {} : { error: dense.error }),
      backend: this.backend.kind,
      stats,
      ...(dense.available
        ? {
            candidateLimit:
              this.config.embeddings.vectorCandidateLimit,
            candidateCount: dense.candidateCount,
          }
        : dense.candidateCount === undefined
          ? {}
          : {
              candidateLimit:
                this.config.embeddings.vectorCandidateLimit,
              candidateCount: dense.candidateCount,
            }),
      hits: dense.hits,
      sparseHits: sparse.hits,
      ...(sparse.available === undefined
        ? {}
        : { sparseAvailable: sparse.available }),
      ...(sparse.error === undefined
        ? {}
        : { sparseError: sparse.error }),
      ...(sparse.candidateCount === undefined
        ? {}
        : { sparseCandidateCount: sparse.candidateCount }),
    };
  }

  /**
   * Dense first-stage retrieval. Never throws: candidate-cap overflow,
   * dimension mismatches, and corrupt embedding blobs degrade this channel
   * with a bounded error so the learned sparse channel can still run.
   */
  private runDenseChannel(params: {
    chatId: string;
    queryVector: number[];
    searchDimensions: number;
    limit: number;
    includeMessages: boolean;
    window: { beforeId?: number; afterId?: number };
  }): {
    available: boolean;
    error?: string;
    hits: VectorSearchHit[];
    candidateCount?: number;
  } {
    const candidateLimit =
      this.config.embeddings.vectorCandidateLimit;
    try {
      const chunks = this.store.getEmbeddingChunks({
        chatId: params.chatId,
        namespace: this.namespace,
        model: this.backend.model,
        dimensions: params.searchDimensions,
        beforeId: params.window.beforeId,
        afterId: params.window.afterId,
        // Membership rows are not needed to score vectors.  Deferring them
        // avoids a query per corpus chunk on ordinary bot turns.
        hydrateMessageIds: false,
        limit: candidateLimit + 1,
      });
      if (chunks.length > candidateLimit) {
        return {
          available: false,
          error: `Vector search candidate limit ${candidateLimit} exceeded for model ${this.backend.model} and dimensions ${params.searchDimensions}. Narrow the search with before_id/after_id or raise TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT after benchmarking.`,
          hits: [],
          candidateCount: chunks.length,
        };
      }
      const mismatchedChunk = chunks.find(
        (chunk) =>
          chunk.dimensions !== params.queryVector.length,
      );
      if (mismatchedChunk) {
        return {
          available: false,
          error: `Refusing mixed-dimension vector comparison: query has ${params.queryVector.length} dimensions but chunk ${mismatchedChunk.id} has ${mismatchedChunk.dimensions}.`,
          hits: [],
          candidateCount: chunks.length,
        };
      }
      // Validate the query once and score each stored BLOB in a single pass.
      // Do not materialize or cache candidate vectors: a call observes the
      // exact database BLOB it was handed, including corruption.
      const scoreBlob = createBlobCosineScorer(params.queryVector);
      const ranked = chunks
        .map((chunk) => ({
          chunk,
          score: scoreBlob(chunk.embedding, chunk.dimensions),
        }))
        .sort((left, right) => right.score - left.score);
      const hits: VectorSearchHit[] = [];

      // The coarse SQL range predicates guarantee a member can exist in the
      // requested causal window for each well-formed chunk.  Hydrate ranked
      // candidates in small batches nevertheless: it preserves that window
      // when legacy/corrupt membership rows are absent, without returning to
      // N+1 queries or loading the whole corpus' memberships.
      for (let offset = 0; offset < ranked.length && hits.length < params.limit; offset += params.limit) {
        const batch = ranked.slice(offset, offset + params.limit);
        const messageIdsByChunkId = this.store.getEmbeddingChunkMessageIds({
          chunkIds: batch.map(({ chunk }) => chunk.id),
        });
        for (const candidate of batch) {
          const hit = this.toVectorHit(
            {
              ...candidate.chunk,
              messageIds: messageIdsByChunkId.get(candidate.chunk.id) ?? [],
            },
            candidate.score,
            params.includeMessages,
            params.window,
          );
          if (hit !== undefined) hits.push(hit);
          if (hits.length === params.limit) break;
        }
      }
      return {
        available: true,
        hits: hits.map((hit, index) => ({ ...hit, rank: index + 1 })),
        candidateCount: chunks.length,
      };
    } catch (error) {
      return {
        available: false,
        error:
          error instanceof Error
            ? error.message
            : "Dense search failed.",
        hits: [],
      };
    }
  }

  /**
   * Learned sparse channel over stored postings. Failures degrade the
   * channel, never the whole search: BM25 and dense stay independent.
   */
  private runSparseChannel(params: {
    params: VectorSearchParams;
    encodedSparseTerms: readonly { tokenId: number; weight: number }[];
    searchDimensions: number;
    candidateLimit: number;
    limit: number;
    includeMessages: boolean;
    window: { beforeId?: number; afterId?: number };
  }): {
    hits: VectorSearchHit[];
    available?: boolean;
    error?: string;
    candidateCount?: number;
  } {
    if (!this.backend.supportsSparse) {
      return { hits: [] };
    }
    try {
      if (params.encodedSparseTerms.length === 0) {
        return { hits: [], available: true, candidateCount: 0 };
      }
      const chunkHits = this.store.searchSparseChunks({
        chatId: params.params.chatId,
        namespace: this.namespace,
        model: this.backend.model,
        dimensions: params.searchDimensions,
        terms: params.encodedSparseTerms,
        limit: params.candidateLimit,
        ...(params.window.beforeId === undefined
          ? {}
          : { beforeId: params.window.beforeId }),
        ...(params.window.afterId === undefined
          ? {}
          : { afterId: params.window.afterId }),
      });
      const hits = chunkHits
        .map((hit: SparseChunkHit) =>
          this.toVectorHit(
            hit.chunk,
            hit.score,
            params.includeMessages,
            params.window,
          ),
        )
        .filter((hit): hit is VectorSearchHit => hit != null)
        .slice(0, params.limit)
        .map((hit, index) => ({ ...hit, rank: index + 1 }));
      return {
        hits,
        available: true,
        candidateCount: chunkHits.length,
      };
    } catch (error) {
      return {
        hits: [],
        available: false,
        error:
          error instanceof Error
            ? error.message
            : "Sparse search failed.",
      };
    }
  }

  private unconfiguredError(): string {
    if (this.backend.kind === "local_bge_m3") {
      return this.config.embeddings.enabled
        ? "Local BGE-M3 service is not configured. Set TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT to the loopback service origin."
        : "Embeddings are disabled. Set TELEGRAM_EMBEDDINGS_ENABLED=true.";
    }
    return this.config.embeddings.enabled
      ? "Embedding API key is missing. Set OPENAI_API_KEY or TELEGRAM_EMBEDDINGS_API_KEY."
      : "Embeddings are disabled. Set TELEGRAM_EMBEDDINGS_ENABLED=true.";
  }

  private toVectorHit(
    chunk: StoredEmbeddingChunk,
    score: number,
    includeMessages: boolean,
    window: { beforeId?: number; afterId?: number },
  ): VectorSearchHit | undefined {
    const messageIds = chunk.messageIds.filter((messageId) =>
      messageIdInWindow(messageId, window),
    );
    if (messageIds.length === 0) {
      return undefined;
    }
    const trimmed = messageIds.length !== chunk.messageIds.length;
    const visibleMessages =
      includeMessages || trimmed
        ? this.store.getMessagesByIds({
            chatId: chunk.chatId,
            messageIds,
          })
        : [];
    const visibleText = trimmed
      ? visibleMessages
          .map((message) => formatMessage(message))
          .join("\n")
      : chunk.text;
    return {
      rank: 0,
      score,
      chunk: {
        id: chunk.id,
        startMessageId: Math.min(...messageIds),
        endMessageId: Math.max(...messageIds),
        messageIds,
        messageCount: messageIds.length,
        text: visibleText,
        namespace: chunk.namespace,
        model: chunk.model,
        dimensions: chunk.dimensions,
      },
      messages: includeMessages ? visibleMessages : [],
    };
  }
}

function messageIdInWindow(
  messageId: number,
  window: { beforeId?: number; afterId?: number },
): boolean {
  if (window.beforeId != null && messageId >= window.beforeId) {
    return false;
  }
  if (window.afterId != null && messageId <= window.afterId) {
    return false;
  }
  return true;
}

export function assertVectorSearchReady(result: {
  available: boolean;
  error?: string;
}): void {
  if (!result.available) {
    throw new ToolError({
      category: "internal",
      retryable: false,
      message: result.error ?? "Vector search is unavailable.",
    });
  }
}
