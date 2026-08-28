import type {
  KeywordSearchHit,
  LiveTranscriptResult,
  MessageStore,
  StoredMessage,
} from "../store.js";
import type {
  ChannelFusedHit,
  HybridSearchHit,
  RetrievalChannelInput,
  VectorRerankResult,
  VectorSearchHit,
} from "../vector-rag.js";
import type { JsonEventLogger } from "./worker.js";
import { selectCausalDigests } from "./read-tools/week-causal-proof.js";
import {
  causalSafeHits,
  causalSafeMessages,
} from "./read-tools/vector-causal-filter.js";
import type {
  BotFindMessagesQuery,
  BotReadSliceRequest,
  BotReadToolCache,
  CachedChatSearchResult,
  CachedDigestResult,
  DigestCacheQuery,
  RetrievalChannelState,
  RetrievalChannelStatus,
} from "./read-tools.js";

const SEARCH_CANDIDATE_MULTIPLIER = 3;
const MAX_SEARCH_CANDIDATES = 24;
const MAX_DIGEST_ROWS = 100;
/** Hard ceiling for the optional ColBERT late-interaction rerank window. */
const MAX_RERANK_TOP_K = 32;

export interface BotVectorSearchResult {
  /** Dense channel state only. Sparse below is independent of this flag. */
  available: boolean;
  hits: VectorSearchHit[];
  /**
   * Learned sparse channel state and hits, reported independently of the
   * dense `available` flag: a dense-only failure (candidate cap, corrupt
   * vectors) can leave sparse usable, and vice versa.
   */
  sparseAvailable?: boolean;
  sparseHits?: VectorSearchHit[];
}

export interface BotVectorSearchPort {
  search(params: {
    chatId: string;
    query: string;
    limit?: number;
    includeMessages?: boolean;
    /**
     * Exclusive upper bound requested for dense and sparse retrieval. The
     * cache re-enforces it locally: rows at or above it are dropped before
     * fusion/rerank and output even if the port ignores the bound.
     */
    beforeId?: number;
    signal?: AbortSignal;
  }): Promise<BotVectorSearchResult>;
  /**
   * Declares whether the backend has a learned sparse channel. The local
   * BGE-M3 backend reports true; the external dense-only provider reports
   * false, which surfaces as "unsupported" rather than a failure.
   */
  supportsSparse?: boolean;
  /** Legacy two-channel RRF retained for backwards-compatible callers. */
  hybrid?(
    keywordHits: KeywordSearchHit[],
    vectorHits: VectorSearchHit[],
    limit: number,
  ): HybridSearchHit[];
  /** Deterministic N-channel RRF over named bm25/dense/sparse channels. */
  fuseChannels?(
    channels: readonly RetrievalChannelInput[],
    limit: number,
  ): ChannelFusedHit[];
  /** Optional bounded ColBERT rerank; non-fatal by contract. */
  rerank?(params: {
    query: string;
    candidates: string[];
    signal?: AbortSignal;
  }): Promise<VectorRerankResult>;
}

/** Structural shape shared by legacy hybrid and channel fusion hits. */
type FusedHitShape = {
  messageId?: number;
  startMessageId?: number;
  endMessageId?: number;
};

/**
 * Direct adapter over the canonical SQLite/FTS/vector cache.
 *
 * The bot deliberately does not call its own MCP server. This keeps one set of
 * storage/search semantics while avoiding a loopback protocol hop and another
 * place to configure credentials.
 *
 * Retrieval fuses three independent ranked channels (BM25, BGE-M3 dense,
 * BGE-M3 learned sparse) through deterministic reciprocal-rank fusion, then
 * optionally applies a bounded ColBERT late-interaction rerank over the top-K.
 * The exact `keyword_search`/`read_chat_slice` paths remain provider-free.
 */
export class CanonicalBotReadCache implements BotReadToolCache {
  readonly #store: MessageStore;
  readonly #vector: BotVectorSearchPort | undefined;
  readonly #logger: JsonEventLogger | undefined;
  readonly #botSenderId: string | undefined;
  readonly #rerankMaxCandidates: number;

  constructor(options: {
    store: MessageStore;
    vector?: BotVectorSearchPort;
    logger?: JsonEventLogger;
    /** Durable sender id of this bot's own published messages. */
    botSenderId?: string;
    /** 0 (default) disables the optional ColBERT top-K rerank. */
    rerankMaxCandidates?: number;
  }) {
    this.#store = options.store;
    this.#vector = options.vector;
    this.#logger = options.logger;
    this.#botSenderId = options.botSenderId;
    this.#rerankMaxCandidates = Math.max(
      0,
      Math.min(
        options.rerankMaxCandidates ?? 0,
        MAX_RERANK_TOP_K,
      ),
    );
  }

  async search(params: {
    chatId: string;
    query: string;
    limit: number;
    signal: AbortSignal;
    beforeId?: number;
  }): Promise<CachedChatSearchResult> {
    throwIfAborted(params.signal);
    const candidateLimit = Math.min(
      MAX_SEARCH_CANDIDATES,
      Math.max(params.limit, params.limit * SEARCH_CANDIDATE_MULTIPLIER),
    );

    // Channel 1: BM25 full-text. Independent of any embedding backend.
    const degradedChannels: string[] = [];
    const channels: RetrievalChannelStatus = {
      bm25: "ok",
      dense: "disabled",
      sparse: "disabled",
      rerank: "skipped",
    };
    let keywordHits: KeywordSearchHit[] = [];
    let keywordAvailable = true;
    try {
      keywordHits = this.#store.searchWithRank({
        chatId: params.chatId,
        query: params.query,
        limit: candidateLimit,
        ...(params.beforeId === undefined ? {} : { beforeId: params.beforeId }),
      });
    } catch (error) {
      keywordAvailable = false;
      channels.bm25 = "failed";
      degradedChannels.push("keyword_failed");
      this.#log("warn", "bot.read_cache.keyword_failed", {
        code: error instanceof Error ? (error as Error & { code?: string }).code ?? error.name : "unknown",
      });
    }
    throwIfAborted(params.signal);

    if (!this.#vector) {
      degradedChannels.push("semantic_disabled");
      if (!keywordAvailable) {
        throw new Error("No chat search channel is available.");
      }
      return {
        messages: keywordHits
          .slice(0, params.limit)
          .map((hit) => hit.message),
        mode: "keyword",
        degradedChannels,
        channels,
      };
    }

    // Channels 2 + 3: one encode pass yields dense and learned sparse. The
    // channels degrade independently: a dense-only outage (candidate cap,
    // corrupt vectors) leaves sparse usable, and vice versa.
    let vectorHits: VectorSearchHit[] = [];
    let sparseHits: VectorSearchHit[] = [];
    let denseAvailable = false;
    let sparseAvailable = false;
    try {
      const vector = await this.#vector.search({
        chatId: params.chatId,
        query: params.query,
        limit: candidateLimit,
        includeMessages: true,
        signal: params.signal,
        ...(params.beforeId === undefined
          ? {}
          : { beforeId: params.beforeId }),
      });
      throwIfAborted(params.signal);
      denseAvailable = vector.available === true;
      vectorHits = denseAvailable
        ? causalSafeHits(vector.hits, params.beforeId)
        : [];
      if (!denseAvailable) {
        channels.dense = "unavailable";
        degradedChannels.push("dense_unavailable");
      } else {
        channels.dense = "ok";
      }
      // Sparse is never gated on dense availability: the search result
      // reports it independently.
      sparseAvailable = vector.sparseAvailable === true;
      sparseHits = sparseAvailable
        ? causalSafeHits(vector.sparseHits ?? [], params.beforeId)
        : [];
      channels.sparse = this.#sparseChannelState(
        vector.sparseHits !== undefined,
        sparseAvailable,
        degradedChannels,
      );
      if (!denseAvailable && !sparseAvailable) {
        degradedChannels.push("semantic_unavailable");
      }
    } catch (error) {
      throwIfAborted(params.signal);
      channels.dense = "failed";
      degradedChannels.push("semantic_failed");
      degradedChannels.push("dense_failed");
      if (this.#vector.supportsSparse === true) {
        channels.sparse = "failed";
        degradedChannels.push("sparse_failed");
      } else {
        channels.sparse =
          this.#vector.supportsSparse === false
            ? "unsupported"
            : "failed";
      }
      this.#log("warn", "bot.read_cache.semantic_failed", {
        code: error instanceof Error ? (error as Error & { code?: string }).code ?? error.name : "unknown",
      });
    }

    const anyVector = denseAvailable || sparseAvailable;
    if (!keywordAvailable && !anyVector) {
      throw new Error("No chat search channel is available.");
    }
    if (!anyVector) {
      return {
        messages: keywordHits
          .slice(0, params.limit)
          .map((hit) => hit.message),
        mode: "keyword",
        degradedChannels,
        channels,
      };
    }

    // The first-stage pool is hydrated up to max(output limit, configured
    // rerank top-K) so a late rerank can still promote a candidate that sits
    // just outside the requested output window; the final slice happens only
    // after rerank.
    const poolLimit = this.#firstStagePoolLimit(params.limit);

    if (!keywordAvailable) {
      // BM25 is down, but dense and sparse are still fused through RRF
      // instead of a dense-first concatenation.
      const messages = causalSafeMessages(
        this.#vector.fuseChannels
          ? hydrateFusedMessages({
              ranked: this.#vector.fuseChannels(
                [
                  { channel: "dense", hits: vectorHits },
                  { channel: "sparse", hits: sparseHits },
                ],
                candidateLimit,
              ),
              keywordHits: [],
              chunkHits: [...vectorHits, ...sparseHits],
              limit: poolLimit,
            })
          : uniqueVectorMessages(
              [...vectorHits, ...sparseHits],
              poolLimit,
            ),
        params.beforeId,
      );
      channels.rerank = await this.#maybeRerank(
        params,
        messages,
        channels,
        degradedChannels,
      );
      return {
        messages: messages.slice(0, params.limit),
        mode: "semantic",
        degradedChannels,
        channels,
      };
    }

    const chunkHits = [...vectorHits, ...sparseHits];
    let pool: StoredMessage[];
    if (this.#vector.fuseChannels) {
      const ranked = this.#vector.fuseChannels(
        buildChannelInputs(keywordHits, vectorHits, sparseHits),
        candidateLimit,
      );
      pool = hydrateFusedMessages({
        ranked,
        keywordHits,
        chunkHits,
        limit: poolLimit,
      });
    } else if (this.#vector.hybrid && denseAvailable) {
      const ranked = this.#vector.hybrid(
        keywordHits,
        vectorHits,
        candidateLimit,
      );
      pool = hydrateFusedMessages({
        ranked,
        keywordHits,
        chunkHits,
        limit: poolLimit,
      });
    } else {
      // Dense is down and no N-channel fusion exists; BM25 evidence and the
      // surviving sparse chunks still hydrate through the fill path.
      pool = hydrateFusedMessages({
        ranked: [],
        keywordHits,
        chunkHits,
        limit: poolLimit,
      });
    }

    // Output-boundary cutoff: an injected port may ignore `beforeId`; rows at
    // or above it never reach rerank or the result.
    pool = causalSafeMessages(pool, params.beforeId);

    channels.rerank = await this.#maybeRerank(
      params,
      pool,
      channels,
      degradedChannels,
    );

    return {
      messages: pool.slice(0, params.limit),
      mode: "hybrid",
      degradedChannels,
      channels,
    };
  }

  #firstStagePoolLimit(limit: number): number {
    if (
      this.#rerankMaxCandidates === 0 ||
      this.#vector?.rerank === undefined
    ) {
      return limit;
    }
    return Math.max(limit, this.#rerankMaxCandidates);
  }

  /**
   * Sparse channel state, independent of dense availability. Declared
   * support drives explicit degradation tokens; ports that do not declare
   * support keep the conservative legacy inference.
   */
  #sparseChannelState(
    sparseReported: boolean,
    sparseAvailable: boolean,
    degradedChannels: string[],
  ): RetrievalChannelState {
    if (this.#vector?.supportsSparse === false) {
      return "unsupported";
    }
    if (this.#vector?.supportsSparse === true) {
      if (sparseAvailable) {
        return "ok";
      }
      degradedChannels.push("sparse_unavailable");
      return "unavailable";
    }
    if (sparseAvailable) {
      return "ok";
    }
    if (sparseReported) {
      degradedChannels.push("sparse_unavailable");
      return "unavailable";
    }
    return "unsupported";
  }

  /**
   * Optional bounded ColBERT rerank over the first-stage top-K. Any failure,
   * timeout, or malformed score keeps the first-stage order and records a
   * degraded rerank channel instead of failing the search.
   */
  async #maybeRerank(
    params: { query: string; signal: AbortSignal },
    messages: StoredMessage[],
    channels: RetrievalChannelStatus,
    degradedChannels: string[],
  ): Promise<RetrievalChannelState> {
    if (
      this.#rerankMaxCandidates === 0 ||
      this.#vector?.rerank === undefined ||
      messages.length < 2
    ) {
      return "skipped";
    }
    const topK = Math.min(
      this.#rerankMaxCandidates,
      MAX_RERANK_TOP_K,
      messages.length,
    );
    const candidates = messages
      .slice(0, topK)
      .map((message) => message.text);
    let outcome: VectorRerankResult;
    try {
      outcome = await this.#vector.rerank({
        query: params.query,
        candidates,
        signal: params.signal,
      });
      throwIfAborted(params.signal);
    } catch (error) {
      throwIfAborted(params.signal);
      degradedChannels.push("rerank_failed");
      this.#log("warn", "bot.read_cache.rerank_failed", {
        code: error instanceof Error ? (error as Error & { code?: string }).code ?? error.name : "unknown",
      });
      return "failed";
    }
    if (
      !outcome.available ||
      outcome.scores === undefined ||
      outcome.scores.length !== topK ||
      outcome.scores.some((score) => !Number.isFinite(score))
    ) {
      degradedChannels.push("rerank_unavailable");
      return "unavailable";
    }
    const scores = outcome.scores;
    const order = [...Array(topK).keys()].sort(
      (left, right) =>
        scores[right]! - scores[left]! || left - right,
    );
    const reranked = order.map((index) => messages[index]!);
    messages.splice(0, topK, ...reranked);
    return "ok";
  }

  /**
   * Strictly cache-only lexical search: it never touches the vector port or
   * any embedding provider. The bot's own turns are included by default and
   * excluded only when the caller passes includeBot: false.
   */
  findMessages(params: BotFindMessagesQuery): readonly StoredMessage[] {
    const excludeSenderIds =
      params.includeBot === false && this.#botSenderId !== undefined
        ? [this.#botSenderId]
        : [];
    return this.#store
      .searchLexical({
        chatId: params.chatId,
        query: params.query,
        match: params.match,
        ...(params.sender === undefined ? {} : { sender: params.sender }),
        ...(excludeSenderIds.length === 0 ? {} : { excludeSenderIds }),
        ...(params.startInclusive === undefined
          ? {}
          : { dateFromInclusive: params.startInclusive }),
        ...(params.endExclusive === undefined
          ? {}
          : { dateToExclusive: params.endExclusive }),
        ...(params.beforeId === undefined ? {} : { beforeId: params.beforeId }),
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        order: params.order,
        limit: params.limit,
      })
      .map((hit) => hit.message);
  }

  readSlice(params: BotReadSliceRequest): LiveTranscriptResult {
    return this.#store.getLiveTranscript(params);
  }

  getThreadContext(params: {
    chatId: string;
    messageId: number;
    before: number;
    after: number;
    beforeId?: number;
  }): readonly StoredMessage[] {
    return this.#store.getThreadContext(params);
  }

  getDigests(params: DigestCacheQuery): CachedDigestResult {
    if (params.preferWeekly) {
      const weeks = this.#store.getDigestRollups({
        chatId: params.chatId,
        kind: "week",
        dayFrom: params.dayFrom,
        dayTo: params.dayTo,
        limit: MAX_DIGEST_ROWS,
      });
      if (weeks.length > 0) {
        if (params.sourceMessageId === undefined) {
          return {
            digests: weeks.map((digest) => ({
              kind: "week",
              period: digest.period,
              dayFrom: digest.dayFrom,
              dayTo: digest.dayTo,
              text: digest.text,
            })),
          };
        }
        // Under the trigger bound, proven weeks win and safe day digests
        // outside them are kept, up to the digest row limit; see
        // selectCausalDigests.
        const selected = selectCausalDigests(
          weeks,
          params,
          this.#store,
        );
        if (selected !== undefined) {
          return { digests: selected };
        }
      }
    }

    const dayDigests = this.#store.getDayDigests({
      chatId: params.chatId,
      dayFrom: params.dayFrom,
      dayTo: params.dayTo,
      limit: MAX_DIGEST_ROWS,
    });
    const sourceMessageId = params.sourceMessageId;
    const safeDayDigests =
      sourceMessageId === undefined
        ? dayDigests
        : dayDigests.filter(
            (digest) => digest.endMessageId < sourceMessageId,
          );
    return {
      digests: safeDayDigests.map((digest) => ({
        kind: "day",
        period: digest.day,
        dayFrom: digest.day,
        dayTo: digest.day,
        text: digest.text,
        startMessageId: digest.startMessageId,
        endMessageId: digest.endMessageId,
      })),
    };
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...fields });
    } catch {
      // Observability must never break read-cache fallback behavior.
    }
  }
}

function buildChannelInputs(
  keywordHits: KeywordSearchHit[],
  denseHits: VectorSearchHit[],
  sparseHits: VectorSearchHit[],
): RetrievalChannelInput[] {
  return [
    { channel: "dense", hits: denseHits },
    { channel: "sparse", hits: sparseHits },
    { channel: "bm25", hits: keywordHits },
  ];
}

function hydrateFusedMessages(params: {
  ranked: readonly FusedHitShape[];
  keywordHits: readonly KeywordSearchHit[];
  chunkHits: readonly VectorSearchHit[];
  limit: number;
}): StoredMessage[] {
  const exact = new Map<number, StoredMessage>();
  for (const hit of params.keywordHits) {
    exact.set(hit.message.messageId, hit.message);
  }
  const chunksByRange = new Map<string, readonly StoredMessage[]>();
  for (const hit of params.chunkHits) {
    chunksByRange.set(
      rangeKey(hit.chunk.startMessageId, hit.chunk.endMessageId),
      hit.messages,
    );
    for (const message of hit.messages) {
      exact.set(message.messageId, message);
    }
  }

  const output: StoredMessage[] = [];
  const seen = new Set<number>();
  const append = (message: StoredMessage | undefined): void => {
    if (
      message &&
      output.length < params.limit &&
      !seen.has(message.messageId)
    ) {
      seen.add(message.messageId);
      output.push(message);
    }
  };

  for (const hit of params.ranked) {
    if (output.length >= params.limit) {
      break;
    }
    if (hit.messageId !== undefined) {
      append(exact.get(hit.messageId));
      continue;
    }
    if (
      hit.startMessageId !== undefined &&
      hit.endMessageId !== undefined
    ) {
      for (const message of chunksByRange.get(
        rangeKey(hit.startMessageId, hit.endMessageId),
      ) ?? []) {
        append(message);
      }
    }
  }

  // A custom vector implementation can return a partial projection. Fill from
  // the exact candidates without inventing synthetic evidence.
  for (const hit of params.keywordHits) {
    append(hit.message);
  }
  for (const hit of params.chunkHits) {
    for (const message of hit.messages) {
      append(message);
    }
  }
  return output;
}

function uniqueVectorMessages(
  hits: readonly VectorSearchHit[],
  limit: number,
): StoredMessage[] {
  const output: StoredMessage[] = [];
  const seen = new Set<number>();
  for (const hit of hits) {
    for (const message of hit.messages) {
      if (!seen.has(message.messageId)) {
        seen.add(message.messageId);
        output.push(message);
        if (output.length >= limit) {
          return output;
        }
      }
    }
  }
  return output;
}

function rangeKey(startMessageId: number, endMessageId: number): string {
  return `${startMessageId}:${endMessageId}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Chat search was aborted.", "AbortError");
  }
}
