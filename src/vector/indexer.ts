import type { AppConfig } from "../config.js";
import {
  EMBEDDING_NORMALIZATION_VERSION,
  type EmbeddingChunkInput,
} from "../embeddings.js";
import { ToolError } from "../errors.js";
import { redactUrl } from "../observability/redaction.js";
import {
  MessageStore,
  type StoredMessage,
} from "../store.js";
import type { VectorBackend } from "./backend.js";
import {
  formatChunkSource,
  formatMessageForChunk,
} from "./source-formatter.js";
import type {
  EmbeddingIndexEstimate,
  EmbeddingIndexResult,
  VectorIndexParams,
} from "./types.js";

export function embeddingEstimateRequiresConfirmation(
  estimate: Pick<
    EmbeddingIndexEstimate,
    "requiresConfirmation" | "budget"
  >,
  confirmed: boolean,
): boolean {
  return (
    !confirmed &&
    (estimate.requiresConfirmation ||
      estimate.budget.truncatedByChunkBudget ||
      estimate.budget.truncatedByCharBudget)
  );
}

export class VectorIndexer {
  constructor(
    private readonly config: AppConfig,
    private readonly store: MessageStore,
    private readonly backend: VectorBackend,
    private readonly namespace: string,
  ) {}

  async indexCachedMessages(
    params: VectorIndexParams,
  ): Promise<EmbeddingIndexResult> {
    throwIfVectorAborted(params.signal);
    const estimate = this.estimateIndexCachedMessages(params);
    throwIfVectorAborted(params.signal);
    if (
      embeddingEstimateRequiresConfirmation(
        estimate,
        params.confirmFirstRun ?? false,
      )
    ) {
      throw new ToolError({
        category: "permission",
        retryable: false,
        message:
          "Embedding index requires explicit confirmation. Review the estimate and retry with confirm_estimate:true or --confirm-estimate.",
      });
    }

    const deletedChunks = params.rebuild
      ? this.store.deleteEmbeddingChunks({
          chatId: params.chatId,
          namespace: this.namespace,
          model: this.backend.model,
          dimensions: this.backend.dimensions,
        })
      : undefined;
    let nextAfterMessageId = params.afterMessageId;
    const plan = this.buildChunks(params.chatId, {
      afterMessageId: params.afterMessageId,
      limitChunks: estimate.limitChunks,
      includeCovered: params.rebuild,
    });
    let chunksCreated = 0;
    let messagesCovered = 0;
    let staleChunks = 0;
    let cursorBlocked = false;

    for (
      let index = 0;
      index < plan.chunks.length;
      index += this.backend.maxEncodeBatch
    ) {
      throwIfVectorAborted(params.signal);
      const batch = plan.chunks.slice(
        index,
        index + this.backend.maxEncodeBatch,
      );
      // One encode pass per batch: for the local BGE-M3 backend the same
      // response carries dense vectors and learned sparse terms, so cadence
      // never pays a second model call.
      const vectors = await this.backend.encodeChunks(
        batch,
        params.signal,
      );
      throwIfVectorAborted(params.signal);

      const committed =
        this.store.commitEmbeddingChunksIfCurrent(
          vectors,
          this.config.embeddings.chunkMaxChars,
        );
      chunksCreated += committed.committedChunks;
      messagesCovered += committed.committedMessages;
      staleChunks += committed.staleRanges.length;
      if (
        !cursorBlocked &&
        committed.nextAfterMessageId !== undefined
      ) {
        nextAfterMessageId = committed.nextAfterMessageId;
      }
      if (committed.staleRanges.length > 0) {
        cursorBlocked = true;
      }
    }
    throwIfVectorAborted(params.signal);

    return {
      ok: true,
      chatId: params.chatId,
      model: this.backend.model,
      dimensions: this.backend.dimensions,
      namespace: this.namespace,
      normalizationVersion: EMBEDDING_NORMALIZATION_VERSION,
      chunksCreated,
      messagesCovered,
      nextAfterMessageId,
      deletedChunks,
      // A successful conditional upsert clears dirty_at atomically. Stale
      // chunks remain dirty/excluded; deleting them here would reopen TOCTOU.
      dirtyChunksDeleted: 0,
      staleChunks,
      budget: {
        ...estimate.budget,
        truncatedByCharBudget: plan.truncatedByCharBudget,
      },
      coverage: this.store.getEmbeddingCoverageStats({
        chatId: params.chatId,
        namespace: this.namespace,
        model: this.backend.model,
        dimensions: this.backend.dimensions,
      }),
      stats: this.store.getEmbeddingStats(params.chatId),
    };
  }

  estimateIndexCachedMessages(params: {
    chatId: string;
    limitChunks?: number;
    afterMessageId?: number;
    rebuild?: boolean;
  }): EmbeddingIndexEstimate {
    if (
      this.store.isMaintenanceJobPending(
        "embedding_chunk_membership_backfill",
      )
    ) {
      throw new ToolError({
        category: "internal",
        retryable: true,
        message:
          "Embedding indexing is temporarily unavailable while chunk membership backfill is pending. Run state maintenance with --apply.",
      });
    }
    this.backend.assertConfigured();
    const requestedLimitChunks = Math.max(
      1,
      params.limitChunks ??
        this.config.embeddings.tickChunkLimit,
    );
    const limitChunks = Math.min(
      requestedLimitChunks,
      this.config.embeddings.maxChunksPerRun,
    );
    const stats = this.store.getEmbeddingStats(params.chatId, {
      namespace: this.namespace,
    });
    const plan = this.buildChunks(params.chatId, {
      afterMessageId: params.afterMessageId,
      limitChunks,
      includeCovered: params.rebuild,
    });
    const existingChunks = stats.reduce(
      (sum, row) => sum + Number(row.chunks ?? 0),
      0,
    );
    const firstRun = existingChunks === 0;

    return {
      provider: this.backend.providerLabel(),
      baseUrl:
        this.backend.kind === "local_bge_m3"
          ? "loopback"
          : redactUrl(this.config.embeddings.baseUrl),
      model: this.backend.model,
      dimensions: this.backend.dimensions,
      namespace: this.namespace,
      normalizationVersion: EMBEDDING_NORMALIZATION_VERSION,
      chatId: params.chatId,
      limitChunks,
      requestedLimitChunks,
      estimatedChunks: plan.chunks.length,
      estimatedMessages: plan.chunks.reduce(
        (sum, chunk) => sum + chunk.messageCount,
        0,
      ),
      estimatedChars: plan.chunks.reduce(
        (sum, chunk) => sum + chunk.text.length,
        0,
      ),
      existingChunks,
      budget: {
        requestedLimitChunks,
        effectiveLimitChunks: limitChunks,
        maxChunksPerRun:
          this.config.embeddings.maxChunksPerRun,
        maxCharsPerRun: this.config.embeddings.maxCharsPerRun,
        truncatedByChunkBudget:
          requestedLimitChunks > limitChunks,
        truncatedByCharBudget: plan.truncatedByCharBudget,
      },
      coverage: this.store.getEmbeddingCoverageStats({
        chatId: params.chatId,
        namespace: this.namespace,
        model: this.backend.model,
        dimensions: this.backend.dimensions,
      }),
      firstRun,
      requiresConfirmation: firstRun && plan.chunks.length > 0,
      privacy: this.backend.privacyNotice(),
    };
  }

  private buildChunks(
    chatId: string,
    params: {
      afterMessageId?: number;
      limitChunks: number;
      includeCovered?: boolean;
    },
  ): {
    chunks: EmbeddingChunkInput[];
    truncatedByCharBudget: boolean;
  } {
    const chunks: EmbeddingChunkInput[] = [];
    let cursor = params.afterMessageId;
    let buffer: StoredMessage[] = [];
    let bufferChars = 0;
    const fetchLimit = Math.max(
      this.config.embeddings.chunkMessages *
        params.limitChunks *
        2,
      500,
    );
    let totalChars = 0;
    let truncatedByCharBudget = false;
    let bufferHasNewMessages = false;
    const overlapMessages = Math.min(
      this.config.embeddings.chunkOverlapMessages,
      Math.max(
        0,
        this.config.embeddings.chunkMessages - 1,
      ),
    );

    const bufferTextLength = (
      messages: StoredMessage[],
    ): number =>
      messages.reduce(
        (sum, message, index) =>
          sum +
          formatMessageForChunk(
            message,
            this.config.embeddings.chunkMaxChars,
          ).length +
          (index > 0 ? 1 : 0),
        0,
      );

    const flush = (retainOverlap: boolean): void => {
      if (
        buffer.length === 0 ||
        chunks.length >= params.limitChunks
      ) {
        return;
      }
      const first = buffer[0]!;
      const last = buffer[buffer.length - 1]!;
      const text = formatChunkSource(
        buffer,
        this.config.embeddings.chunkMaxChars,
      );
      chunks.push({
        chatId,
        startMessageId: first.messageId,
        endMessageId: last.messageId,
        messageIds: buffer.map(
          (message) => message.messageId,
        ),
        messageCount: buffer.length,
        text,
      });
      totalChars += text.length;
      buffer =
        retainOverlap && overlapMessages > 0
          ? buffer.slice(-overlapMessages)
          : [];
      bufferChars = bufferTextLength(buffer);
      bufferHasNewMessages = false;
    };

    outer: while (
      chunks.length < params.limitChunks &&
      !truncatedByCharBudget
    ) {
      const messages = params.includeCovered
        ? this.store.getMessagesForEmbedding({
            chatId,
            afterId: cursor,
            limit: fetchLimit,
          })
        : this.store.getMessagesNeedingEmbedding({
            chatId,
            namespace: this.namespace,
            model: this.backend.model,
            dimensions: this.backend.dimensions,
            afterId: cursor,
            limit: fetchLimit,
          });
      if (messages.length === 0) {
        break;
      }

      for (const message of messages) {
        const formatted = formatMessageForChunk(
          message,
          this.config.embeddings.chunkMaxChars,
        );
        let additionalChars =
          formatted.length + (buffer.length > 0 ? 1 : 0);
        if (
          buffer.length > 0 &&
          bufferChars + additionalChars >
            this.config.embeddings.chunkMaxChars
        ) {
          if (bufferHasNewMessages) {
            flush(false);
          } else {
            buffer = [];
            bufferChars = 0;
          }
          additionalChars = formatted.length;
        }
        if (chunks.length >= params.limitChunks) {
          break;
        }
        if (
          totalChars + bufferChars + additionalChars >
            this.config.embeddings.maxCharsPerRun
        ) {
          truncatedByCharBudget = true;
          break outer;
        }
        cursor = message.messageId;
        buffer.push(message);
        bufferHasNewMessages = true;
        bufferChars += additionalChars;
        if (
          buffer.length >=
          this.config.embeddings.chunkMessages
        ) {
          flush(true);
        }
      }
      if (messages.length < fetchLimit) {
        break;
      }
    }
    if (bufferHasNewMessages) {
      flush(false);
    }
    return {
      chunks: chunks.slice(0, params.limitChunks),
      truncatedByCharBudget,
    };
  }
}

function throwIfVectorAborted(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException(
          "Embedding indexing was aborted.",
          "AbortError",
        );
  }
}
