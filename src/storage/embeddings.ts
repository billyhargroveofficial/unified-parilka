import type { EmbeddingChunkVector } from "../embeddings.js";
import {
  assertEmbeddingChunkMaxChars,
  embeddingSourceEquals,
  fingerprintEmbeddingSource,
  renderEmbeddingChunkSource,
} from "../embedding-source.js";
import { StoreCore } from "./core.js";
import {
  rowToEmbeddingChunk,
  rowToStoredMessage,
} from "./mappers.js";
import { normalizeChunkMessageIds, toSqlValues } from "./sqlite-utils.js";
import {
  MAX_SPARSE_TERMS_PER_CHUNK,
  normalizeSparseTerms,
} from "./validation.js";
import type {
  EmbeddingChunkCommitResult,
  MaintenanceJobName,
  SparseTerm,
  StaleEmbeddingChunkReason,
  StoredEmbeddingChunk,
  StoredMessage,
} from "./types.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class EmbeddingMethods extends StoreCore {
declare protected assertMaintenanceJobReady: (
    name: MaintenanceJobName,
    message: string,
  ) => void;
  declare protected replaceEmbeddingSparseTermsLocked: (
    chunkId: number,
    sparseTerms: readonly SparseTerm[] | undefined,
  ) => void;

  getEmbeddingCursor(params: { chatId: string; namespace: string; model: string; dimensions?: number }): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(end_message_id) AS cursor
         FROM message_embedding_chunks
         WHERE chat_id = ? AND embedding_namespace = ? AND embedding_model = ? AND (? IS NULL OR embedding_dimensions = ?)`,
      )
      .get(params.chatId, params.namespace, params.model, params.dimensions ?? null, params.dimensions ?? null) as
      | Record<string, unknown>
      | undefined;
    return row?.cursor == null ? undefined : Number(row.cursor);
  }

  /**
   * Compatibility primitive for trusted migration/test data.
   *
   * Provider-produced vectors must use commitEmbeddingChunksIfCurrent so an
   * edit during the network request cannot be committed as a clean chunk.
   */
  upsertEmbeddingChunks(chunks: EmbeddingChunkVector[]): number {
    if (chunks.length === 0) {
      return 0;
    }
    return this.immediateTransaction("upsertEmbeddingChunks", () => {
      for (const chunk of chunks) {
        this.upsertEmbeddingChunkLocked(
          chunk,
          normalizeChunkMessageIds(chunk.messageIds, chunk.startMessageId, chunk.endMessageId),
        );
      }
      return chunks.length;
    });
  }

  /**
   * Atomically verifies provider inputs against current message rows and
   * commits only vectors whose canonical source is still byte-identical.
   *
   * The BEGIN IMMEDIATE boundary prevents a message edit/delete from
   * committing between the source re-read and chunk/membership writes.
   */
  commitEmbeddingChunksIfCurrent(
    chunks: EmbeddingChunkVector[],
    chunkMaxChars: number,
  ): EmbeddingChunkCommitResult {
    assertEmbeddingChunkMaxChars(chunkMaxChars);
    validateEmbeddingCommitBatch(chunks);
    if (chunks.length === 0) {
      return {
        committedChunks: 0,
        committedMessages: 0,
        staleRanges: [],
      };
    }

    return this.immediateTransaction(
      "commitEmbeddingChunksIfCurrent",
      () => {
        let committedChunks = 0;
        let committedMessages = 0;
        let nextAfterMessageId: number | undefined;
        let cursorBlocked = false;
        const staleRanges: EmbeddingChunkCommitResult["staleRanges"] = [];

        for (const chunk of chunks) {
          const current = this.readEmbeddingSourceLocked(chunk);
          const staleReason = embeddingChunkStaleReason(
            chunk,
            current,
            chunkMaxChars,
          );
          if (staleReason) {
            staleRanges.push({
              chatId: chunk.chatId,
              startMessageId: chunk.startMessageId,
              endMessageId: chunk.endMessageId,
              reason: staleReason,
            });
            cursorBlocked = true;
            continue;
          }

          this.upsertEmbeddingChunkLocked(chunk, chunk.messageIds);
          committedChunks += 1;
          committedMessages += chunk.messageCount;
          if (!cursorBlocked) {
            nextAfterMessageId = chunk.endMessageId;
          }
        }

        return {
          committedChunks,
          committedMessages,
          staleRanges,
          ...(nextAfterMessageId === undefined
            ? {}
            : { nextAfterMessageId }),
        };
      },
    );
  }

  deleteEmbeddingChunks(params: { chatId: string; namespace?: string; model?: string; dimensions?: number }): number {
    const clauses = ["chat_id = ?"];
    const values: unknown[] = [params.chatId];
    if (params.namespace != null) {
      clauses.push("embedding_namespace = ?");
      values.push(params.namespace);
    }
    if (params.model != null) {
      clauses.push("embedding_model = ?");
      values.push(params.model);
    }
    if (params.dimensions != null) {
      clauses.push("embedding_dimensions = ?");
      values.push(params.dimensions);
    }
    return this.writeWithRetry("deleteEmbeddingChunks", () => {
      const result = this.db.prepare(`DELETE FROM message_embedding_chunks WHERE ${clauses.join(" AND ")}`).run(...toSqlValues(values));
      return Number(result.changes ?? 0);
    });
  }

  deleteDirtyEmbeddingChunks(params: { chatId: string; namespace: string; model: string; dimensions?: number }): number {
    const clauses = ["chat_id = ?", "embedding_namespace = ?", "embedding_model = ?", "dirty_at IS NOT NULL"];
    const values: unknown[] = [params.chatId, params.namespace, params.model];
    if (params.dimensions != null) {
      clauses.push("embedding_dimensions = ?");
      values.push(params.dimensions);
    }
    return this.writeWithRetry("deleteDirtyEmbeddingChunks", () => {
      const result = this.db.prepare(`DELETE FROM message_embedding_chunks WHERE ${clauses.join(" AND ")}`).run(...toSqlValues(values));
      return Number(result.changes ?? 0);
    });
  }

  deleteDirtyEmbeddingChunksForRanges(params: {
    chatId: string;
    namespace: string;
    model: string;
    dimensions?: number;
    ranges: Array<{ startMessageId: number; endMessageId: number }>;
  }): number {
    if (params.ranges.length === 0) {
      return 0;
    }
    return this.immediateTransaction("deleteDirtyEmbeddingChunksForRanges", () => {
      let deleted = 0;
      const clauses = [
        "chat_id = ?",
        "embedding_namespace = ?",
        "embedding_model = ?",
        "dirty_at IS NOT NULL",
        "start_message_id <= ?",
        "end_message_id >= ?",
      ];
      if (params.dimensions != null) {
        clauses.push("embedding_dimensions = ?");
      }
      const stmt = this.db.prepare(`DELETE FROM message_embedding_chunks WHERE ${clauses.join(" AND ")}`);
      for (const range of params.ranges) {
        const values: unknown[] = [params.chatId, params.namespace, params.model, range.endMessageId, range.startMessageId];
        if (params.dimensions != null) {
          values.push(params.dimensions);
        }
        const result = stmt.run(...toSqlValues(values));
        deleted += Number(result.changes ?? 0);
      }
      return deleted;
    });
  }

  deleteDirtyEmbeddingChunksForMessages(params: {
    chatId: string;
    namespace: string;
    model: string;
    dimensions?: number;
    messageIds: number[];
  }): number {
    const messageIds = [...new Set(params.messageIds)];
    if (messageIds.length === 0) {
      return 0;
    }
    return this.immediateTransaction("deleteDirtyEmbeddingChunksForMessages", () => {
      let deleted = 0;
      const clauses = [
        "chat_id = ?",
        "embedding_namespace = ?",
        "embedding_model = ?",
        "dirty_at IS NOT NULL",
        `id IN (
          SELECT chunk_id
          FROM message_embedding_chunk_messages
          WHERE chat_id = ? AND message_id = ?
        )`,
      ];
      if (params.dimensions != null) {
        clauses.push("embedding_dimensions = ?");
      }
      const stmt = this.db.prepare(`DELETE FROM message_embedding_chunks WHERE ${clauses.join(" AND ")}`);
      for (const messageId of messageIds) {
        const values: unknown[] = [params.chatId, params.namespace, params.model, params.chatId, messageId];
        if (params.dimensions != null) {
          values.push(params.dimensions);
        }
        const result = stmt.run(...toSqlValues(values));
        deleted += Number(result.changes ?? 0);
      }
      return deleted;
    });
  }

  getEmbeddingChunks(params: {
    chatId: string;
    namespace: string;
    model: string;
    dimensions?: number;
    beforeId?: number;
    afterId?: number;
    includeDirty?: boolean;
    limit?: number;
  }): StoredEmbeddingChunk[] {
    const clauses = ["chat_id = ?", "embedding_namespace = ?", "embedding_model = ?"];
    const values: unknown[] = [params.chatId, params.namespace, params.model];
    if (params.dimensions != null) {
      clauses.push("embedding_dimensions = ?");
      values.push(params.dimensions);
    }
    if (params.beforeId != null) {
      clauses.push("start_message_id < ?");
      values.push(params.beforeId);
    }
    if (params.afterId != null) {
      clauses.push("end_message_id > ?");
      values.push(params.afterId);
    }
    if (!params.includeDirty) {
      clauses.push("dirty_at IS NULL");
    }
    const limitClause = params.limit == null ? "" : "LIMIT ?";
    if (params.limit != null) {
      values.push(params.limit);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM message_embedding_chunks
         WHERE ${clauses.join(" AND ")}
         ORDER BY start_message_id ASC
         ${limitClause}`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map((row) => {
      const chunk = rowToEmbeddingChunk(row);
      return { ...chunk, messageIds: this.getEmbeddingChunkMessageIdsLocked(chunk.id) };
    });
  }

  getEmbeddingStats(chatId: string, params: { namespace?: string } = {}): Array<Record<string, unknown>> {
    const clauses = ["chat_id = ?"];
    const values: unknown[] = [chatId];
    if (params.namespace != null) {
      clauses.push("embedding_namespace = ?");
      values.push(params.namespace);
    }
    const rows = this.db
      .prepare(
        `SELECT
           embedding_namespace AS namespace,
           embedding_model AS model,
           embedding_dimensions AS dimensions,
           COUNT(*) AS chunks,
           MIN(start_message_id) AS oldest_message_id,
           MAX(end_message_id) AS newest_message_id,
           SUM(message_count) AS indexed_messages,
           SUM(CASE WHEN dirty_at IS NOT NULL THEN 1 ELSE 0 END) AS dirty_chunks,
           MAX(updated_at) AS updated_at
         FROM message_embedding_chunks
         WHERE ${clauses.join(" AND ")}
         GROUP BY embedding_namespace, embedding_model, embedding_dimensions
         ORDER BY updated_at DESC`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...row,
      ...this.getEmbeddingCoverageStats({
        chatId,
        namespace: String(row.namespace),
        model: String(row.model),
        dimensions: Number(row.dimensions),
      }),
    }));
  }

  getEmbeddingCoverageStats(params: {
    chatId: string;
    namespace: string;
    model: string;
    dimensions?: number;
  }): Record<string, number> {
    const values = [
      params.chatId,
      params.namespace,
      params.model,
      params.dimensions ?? null,
      params.dimensions ?? null,
    ] as const;
    const cache = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE chat_id = ? AND length(trim(text)) > 0 AND deleted_at IS NULL`,
      )
      .get(params.chatId) as Record<string, unknown> | undefined;
    const indexed = this.db
      .prepare(
        `SELECT COUNT(DISTINCT m.id) AS count
         FROM messages m
         WHERE m.chat_id = ?
           AND length(trim(m.text)) > 0
           AND m.deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM message_embedding_chunk_messages cm
             JOIN message_embedding_chunks c ON c.id = cm.chunk_id
             WHERE cm.chat_id = m.chat_id
               AND cm.message_id = m.message_id
               AND c.embedding_namespace = ?
               AND c.embedding_model = ?
               AND (? IS NULL OR c.embedding_dimensions = ?)
               AND c.dirty_at IS NULL
           )`,
      )
      .get(...values) as Record<string, unknown> | undefined;
    const uncovered = this.db
      .prepare(
        `WITH uncovered AS (
           SELECT
             m.message_id,
             LAG(m.message_id) OVER (ORDER BY m.message_id ASC) AS previous_message_id
           FROM messages m
           WHERE m.chat_id = ?
             AND length(trim(m.text)) > 0
             AND m.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM message_embedding_chunk_messages cm
               JOIN message_embedding_chunks c ON c.id = cm.chunk_id
               WHERE cm.chat_id = m.chat_id
                 AND cm.message_id = m.message_id
                 AND c.embedding_namespace = ?
                 AND c.embedding_model = ?
                 AND (? IS NULL OR c.embedding_dimensions = ?)
                 AND c.dirty_at IS NULL
             )
         )
         SELECT
           COUNT(*) AS messages,
           COALESCE(SUM(
             CASE
               WHEN previous_message_id IS NULL OR message_id != previous_message_id + 1 THEN 1
               ELSE 0
             END
           ), 0) AS ranges
         FROM uncovered`,
      )
      .get(...values) as Record<string, unknown> | undefined;
    const dirty = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM message_embedding_chunks
         WHERE chat_id = ? AND embedding_namespace = ? AND embedding_model = ? AND (? IS NULL OR embedding_dimensions = ?) AND dirty_at IS NOT NULL`,
      )
      .get(...values) as Record<string, unknown> | undefined;

    return {
      cache_messages: Number(cache?.count ?? 0),
      indexed_messages: Number(indexed?.count ?? 0),
      uncovered_messages: Number(uncovered?.messages ?? 0),
      uncovered_ranges: Number(uncovered?.ranges ?? 0),
      dirty_chunks: Number(dirty?.count ?? 0),
    };
  }

  protected upsertEmbeddingChunkLocked(
    chunk: EmbeddingChunkVector,
    messageIds: number[],
  ): void {
    this.db
      .prepare(
        `INSERT INTO message_embedding_chunks (
           chat_id, start_message_id, end_message_id, message_count, text,
           embedding_namespace, embedding_model, embedding_dimensions, embedding, content_hash, dirty_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))
         ON CONFLICT(chat_id, start_message_id, end_message_id, embedding_namespace)
         DO UPDATE SET
           message_count = excluded.message_count,
           text = excluded.text,
           embedding_model = excluded.embedding_model,
           embedding_dimensions = excluded.embedding_dimensions,
           embedding = excluded.embedding,
           content_hash = excluded.content_hash,
           dirty_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        chunk.chatId,
        chunk.startMessageId,
        chunk.endMessageId,
        chunk.messageCount,
        chunk.text,
        chunk.namespace,
        chunk.model,
        chunk.dimensions,
        chunk.embedding,
        chunk.contentHash,
      );
    const row = this.db
      .prepare(
        `SELECT id
         FROM message_embedding_chunks
         WHERE chat_id = ?
           AND start_message_id = ?
           AND end_message_id = ?
           AND embedding_namespace = ?`,
      )
      .get(
        chunk.chatId,
        chunk.startMessageId,
        chunk.endMessageId,
        chunk.namespace,
      ) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("Failed to read embedding chunk id after upsert.");
    }
    const chunkId = Number(row.id);
    this.replaceEmbeddingChunkMessagesLocked(
      chunkId,
      chunk.chatId,
      messageIds,
    );
    this.replaceEmbeddingSparseTermsLocked(
      chunkId,
      chunk.sparseTerms,
    );
  }

  protected readEmbeddingSourceLocked(
    chunk: EmbeddingChunkVector,
  ): Array<StoredMessage | undefined> {
    const statement = this.db.prepare(
      `SELECT *
       FROM messages
       WHERE chat_id = ? AND message_id = ?`,
    );
    return chunk.messageIds.map((messageId) => {
      const row = statement.get(
        chunk.chatId,
        messageId,
      ) as Record<string, unknown> | undefined;
      return row ? rowToStoredMessage(row) : undefined;
    });
  }

  protected replaceEmbeddingChunkMessagesLocked(chunkId: number, chatId: string, messageIds: number[]): void {
    this.db.prepare("DELETE FROM message_embedding_chunk_messages WHERE chunk_id = ?").run(chunkId);
    const stmt = this.db.prepare(
      `INSERT INTO message_embedding_chunk_messages (chunk_id, chat_id, message_id, position)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [position, messageId] of messageIds.entries()) {
      stmt.run(chunkId, chatId, messageId, position);
    }
  }

  protected getEmbeddingChunkMessageIdsLocked(chunkId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT message_id
         FROM message_embedding_chunk_messages
         WHERE chunk_id = ?
         ORDER BY position ASC`,
      )
      .all(chunkId) as Record<string, unknown>[];
    return rows.map((row) => Number(row.message_id));
  }
}

function validateEmbeddingCommitBatch(
  chunks: readonly EmbeddingChunkVector[],
): void {
  const first = chunks[0];
  let previousStartMessageId: number | undefined;
  let previousEndMessageId: number | undefined;

  for (const [chunkIndex, chunk] of chunks.entries()) {
    if (
      first &&
      (chunk.chatId !== first.chatId ||
        chunk.namespace !== first.namespace ||
        chunk.model !== first.model ||
        chunk.dimensions !== first.dimensions)
    ) {
      throw new Error(
        "Embedding commit batch must use one chat, namespace, model, and dimension count.",
      );
    }
    if (
      previousStartMessageId != null &&
      (chunk.startMessageId <= previousStartMessageId ||
        chunk.endMessageId <= (previousEndMessageId ?? 0))
    ) {
      throw new Error(
        "Embedding commit chunks must be ordered by strictly increasing ranges.",
      );
    }
    validateEmbeddingChunkShape(chunk, chunkIndex);
    previousStartMessageId = chunk.startMessageId;
    previousEndMessageId = chunk.endMessageId;
  }
}

function validateEmbeddingChunkShape(
  chunk: EmbeddingChunkVector,
  chunkIndex: number,
): void {
  if (chunk.messageIds.length === 0) {
    throw new Error(`Embedding chunk ${chunkIndex} has no message ids.`);
  }
  for (const [messageIndex, messageId] of chunk.messageIds.entries()) {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error(
        `Embedding chunk ${chunkIndex} message ids must be positive safe integers.`,
      );
    }
    if (
      messageIndex > 0 &&
      messageId <= chunk.messageIds[messageIndex - 1]!
    ) {
      throw new Error(
        `Embedding chunk ${chunkIndex} message ids must be unique and strictly ascending.`,
      );
    }
  }
  if (
    chunk.messageCount !== chunk.messageIds.length ||
    chunk.startMessageId !== chunk.messageIds[0] ||
    chunk.endMessageId !== chunk.messageIds.at(-1)
  ) {
    throw new Error(
      `Embedding chunk ${chunkIndex} count and range must exactly match message ids.`,
    );
  }
  if (chunk.sparseTerms !== undefined) {
    normalizeSparseTerms(
      chunk.sparseTerms,
      MAX_SPARSE_TERMS_PER_CHUNK,
    );
  }
}

function embeddingChunkStaleReason(
  chunk: EmbeddingChunkVector,
  rows: readonly (StoredMessage | undefined)[],
  chunkMaxChars: number,
): StaleEmbeddingChunkReason | undefined {
  if (rows.some((message) => message == null)) {
    return "missing_message";
  }
  const messages = rows as StoredMessage[];
  if (messages.some((message) => message.deletedAt != null)) {
    return "deleted_message";
  }
  const currentSource = renderEmbeddingChunkSource(
    messages,
    chunkMaxChars,
  );
  if (
    !embeddingSourceEquals(currentSource, chunk.text) ||
    fingerprintEmbeddingSource(currentSource) !== chunk.contentHash
  ) {
    return "source_changed";
  }
  return undefined;
}

export type EmbeddingApi = Pick<
  EmbeddingMethods,
  | "getEmbeddingCursor"
  | "upsertEmbeddingChunks"
  | "commitEmbeddingChunksIfCurrent"
  | "deleteEmbeddingChunks"
  | "deleteDirtyEmbeddingChunks"
  | "deleteDirtyEmbeddingChunksForRanges"
  | "deleteDirtyEmbeddingChunksForMessages"
  | "getEmbeddingChunks"
  | "getEmbeddingStats"
  | "getEmbeddingCoverageStats"
>;
