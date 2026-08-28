import { StoreCore } from "./core.js";
import { rowToEmbeddingChunk } from "./mappers.js";
import { toSqlValues } from "./sqlite-utils.js";
import {
  MAX_SPARSE_QUERY_TERMS,
  MAX_SPARSE_TERMS_PER_CHUNK,
  normalizeSparseTerms,
} from "./validation.js";
import type {
  SparseChunkScore,
  SparseTerm,
  StoredEmbeddingChunk,
} from "./types.js";

/** Scored parent chunk hydrated for retrieval evidence. */
export type SparseChunkHit = {
  chunk: StoredEmbeddingChunk;
  score: number;
};

/**
 * Hydration IN-clause batch. Keeps bound variables far below the SQLite
 * limit even when the configured candidate limit is large.
 */
const SPARSE_HYDRATION_BATCH = 500;

/**
 * Method module installed on MessageStore.prototype.
 *
 * Learned sparse postings always belong to one parent
 * `message_embedding_chunks` row; the parent namespace/model/dimensions pin
 * the tokenizer and weight contract, so this module never stores or reads a
 * posting without its parent chunk identity.
 */
export abstract class SparsePostingsMethods extends StoreCore {
  declare protected getEmbeddingChunkMessageIdsLocked: (
    chunkId: number,
  ) => number[];

  /**
   * Learned sparse retrieval primitive: bounded posting-list lookup joined
   * against current (non-dirty) parent chunks of one chat/namespace/model.
   * The SQL dot product never scans the whole corpus; it touches only the
   * posting rows of the bounded query term set. Window clauses mirror the
   * dense path's coarse overlap filters so an out-of-window high score can
   * never starve in-window candidates.
   */
  getSparseTermPostings(params: {
    chatId: string;
    namespace: string;
    model: string;
    dimensions: number;
    terms: readonly SparseTerm[];
    limit: number;
    beforeId?: number;
    afterId?: number;
  }): SparseChunkScore[] {
    if (params.terms.length > MAX_SPARSE_QUERY_TERMS) {
      throw new Error(
        `Sparse posting lookup accepts at most ${MAX_SPARSE_QUERY_TERMS} query terms.`,
      );
    }
    const terms = normalizeSparseTerms(
      params.terms,
      MAX_SPARSE_QUERY_TERMS,
    );
    if (terms.length === 0) {
      return [];
    }
    if (
      !Number.isSafeInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > 1_000_000
    ) {
      throw new Error(
        "Sparse posting lookup limit must be a safe integer between 1 and 1000000.",
      );
    }
    const valuePlaceholders = terms
      .map(() => "(?, ?)")
      .join(", ");
    const values: unknown[] = [];
    for (const term of terms) {
      values.push(term.tokenId, term.weight);
    }
    values.push(
      params.chatId,
      params.namespace,
      params.model,
      params.dimensions,
    );
    let windowClauses = "";
    if (params.beforeId != null) {
      windowClauses += " AND c.start_message_id < ?";
      values.push(params.beforeId);
    }
    if (params.afterId != null) {
      windowClauses += " AND c.end_message_id > ?";
      values.push(params.afterId);
    }
    values.push(params.limit);
    const rows = this.db
      .prepare(
        `WITH query_terms(token_id, weight) AS (VALUES ${valuePlaceholders})
         SELECT t.chunk_id AS chunk_id, SUM(t.weight * q.weight) AS score
         FROM message_embedding_sparse_terms t
         JOIN query_terms q ON q.token_id = t.token_id
         JOIN message_embedding_chunks c ON c.id = t.chunk_id
         WHERE c.chat_id = ?
           AND c.embedding_namespace = ?
           AND c.embedding_model = ?
           AND c.embedding_dimensions = ?
           AND c.dirty_at IS NULL${windowClauses}
         GROUP BY t.chunk_id
         ORDER BY score DESC, t.chunk_id ASC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map((row) => ({
      chunkId: Number(row.chunk_id),
      score: Number(row.score),
    }));
  }

  /**
   * Sparse retrieval read path: bounded posting lookup followed by parent
   * chunk hydration. Only current (non-dirty) parent chunks of the exact
   * chat/namespace/model/dimensions are returned, highest score first with
   * chunk id as the deterministic tie-break. Hydration runs in bounded id
   * batches so a large candidate limit can never exceed the SQLite bound
   * variable count, and posting order is preserved across batches.
   */
  searchSparseChunks(params: {
    chatId: string;
    namespace: string;
    model: string;
    dimensions: number;
    terms: readonly SparseTerm[];
    limit: number;
    beforeId?: number;
    afterId?: number;
  }): SparseChunkHit[] {
    const postings = this.getSparseTermPostings(params);
    if (postings.length === 0) {
      return [];
    }
    const byId = new Map<number, Record<string, unknown>>();
    for (
      let offset = 0;
      offset < postings.length;
      offset += SPARSE_HYDRATION_BATCH
    ) {
      const batch = postings.slice(
        offset,
        offset + SPARSE_HYDRATION_BATCH,
      );
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT * FROM message_embedding_chunks
           WHERE id IN (${placeholders})
             AND chat_id = ?
             AND embedding_namespace = ?
             AND embedding_model = ?
             AND embedding_dimensions = ?
             AND dirty_at IS NULL`,
        )
        .all(
          ...toSqlValues([
            ...batch.map((posting) => posting.chunkId),
            params.chatId,
            params.namespace,
            params.model,
            params.dimensions,
          ]),
        ) as Record<string, unknown>[];
      for (const row of rows) {
        byId.set(Number(row.id), row);
      }
    }
    return postings.flatMap((posting) => {
      const row = byId.get(posting.chunkId);
      if (!row) {
        return [];
      }
      const chunk = rowToEmbeddingChunk(row);
      return [
        {
          chunk: {
            ...chunk,
            messageIds:
              this.getEmbeddingChunkMessageIdsLocked(chunk.id),
          },
          score: posting.score,
        },
      ];
    });
  }

  /**
   * Replaces the learned sparse postings of one parent chunk. Always
   * deleting first keeps the invariant that postings never outlive their
   * parent chunk and never mix across namespaces or backends.
   */
  protected replaceEmbeddingSparseTermsLocked(
    chunkId: number,
    sparseTerms: readonly SparseTerm[] | undefined,
  ): void {
    this.db
      .prepare(
        "DELETE FROM message_embedding_sparse_terms WHERE chunk_id = ?",
      )
      .run(chunkId);
    if (!sparseTerms || sparseTerms.length === 0) {
      return;
    }
    const terms = normalizeSparseTerms(
      sparseTerms,
      MAX_SPARSE_TERMS_PER_CHUNK,
    );
    const stmt = this.db.prepare(
      `INSERT INTO message_embedding_sparse_terms (chunk_id, token_id, weight)
       VALUES (?, ?, ?)`,
    );
    for (const term of terms) {
      stmt.run(chunkId, term.tokenId, term.weight);
    }
  }
}

export type SparsePostingsApi = Pick<
  SparsePostingsMethods,
  "getSparseTermPostings" | "searchSparseChunks"
>;
