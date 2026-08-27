import type { ChatInfo } from "../../telegram/types.js";
import { StoreCore } from "../core.js";
import { rowToChatInfo } from "../mappers.js";
import { MAX_AUDIT_JSON_BYTES } from "../dream-audit-types.js";
import {
  DEFAULT_BOT_MAX_ATTEMPTS,
  EMBEDDING_MEMBERSHIP_INLINE_CHUNK_LIMIT,
  LEGACY_EMBEDDING_NAMESPACE,
  MANAGED_TRIGGER_DEFINITIONS,
  MAX_BOT_ATTEMPTS,
} from "../constants.js";
import type { MaintenanceJobName } from "../types.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class SchemaMigrationMethods extends StoreCore {
declare protected applyMaintenanceSchema: () => void;
  declare protected countRows: (table: string) => number;
  declare protected ensureColumn: (
    table: string,
    column: string,
    definition: string,
  ) => void;
  declare protected ensureManagedTriggerDefinition: (
    definition: (typeof MANAGED_TRIGGER_DEFINITIONS)[number],
  ) => void;
  declare protected ensureMessagesFtsDefinition: () => void;
  declare protected hasColumn: (table: string, column: string) => boolean;
  declare protected replaceEmbeddingChunkMessagesLocked: (
    chunkId: number,
    chatId: string,
    messageIds: number[],
  ) => void;
  declare protected upsertChatLocked: (chat: ChatInfo) => void;
  declare protected upsertMaintenanceJob: (
    name: MaintenanceJobName,
    status: "pending" | "completed",
    reason?: string,
    details?: Record<string, unknown>,
  ) => void;

  protected applyBackfillExhaustedMigration(): void {
    this.ensureColumn("sync_state", "backfill_exhausted_at", "TEXT");
  }

  protected applyChatAliasMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_aliases (
        alias TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_aliases_chat_id
        ON chat_aliases(chat_id);
    `);
    const chats = this.db.prepare("SELECT * FROM chats").all() as Record<string, unknown>[];
    for (const row of chats) {
      this.upsertChatLocked(rowToChatInfo(row));
    }
  }

  protected applyMessageReconciliationMigration(): void {
    this.ensureColumn("messages", "deleted_at", "TEXT");
    this.ensureColumn("message_embedding_chunks", "dirty_at", "TEXT");
  }

  protected applyDaemonStatusMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_status (
        service TEXT PRIMARY KEY,
        last_started_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  }

  protected applyEmbeddingChunkMembershipMigration(): void {
    this.applyMaintenanceSchema();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_embedding_chunk_messages (
        chunk_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(chunk_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_embedding_chunk_messages_lookup
        ON message_embedding_chunk_messages(chat_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunk_messages_chunk_position
        ON message_embedding_chunk_messages(chunk_id, position);
      CREATE TRIGGER IF NOT EXISTS embedding_chunks_ad AFTER DELETE ON message_embedding_chunks BEGIN
        DELETE FROM message_embedding_chunk_messages WHERE chunk_id = old.id;
      END;
    `);
    const chunkCount = this.countRows("message_embedding_chunks");
    if (chunkCount > EMBEDDING_MEMBERSHIP_INLINE_CHUNK_LIMIT) {
      const maxChunk = this.db
        .prepare(
          "SELECT COALESCE(MAX(id), 0) AS max_chunk_id FROM message_embedding_chunks",
        )
        .get() as Record<string, unknown>;
      const snapshot = this.db
        .prepare("SELECT datetime('now') AS captured_at")
        .get() as Record<string, unknown>;
      this.upsertMaintenanceJob(
        "embedding_chunk_membership_backfill",
        "pending",
        "Embedding chunk membership backfill is too large for startup migration.",
        {
          chunkCount,
          targetMaxChunkId: Number(maxChunk.max_chunk_id ?? 0),
          lastChunkId: 0,
          processedChunks: 0,
          sourceSnapshotAt: String(snapshot.captured_at),
          inlineLimit: EMBEDDING_MEMBERSHIP_INLINE_CHUNK_LIMIT,
          remediation: "Keep vector search disabled or run a bounded maintenance backfill before relying on vector chunk membership coverage.",
        },
      );
      return;
    }
    const chunks = this.db
      .prepare(
        `SELECT id, chat_id, start_message_id, end_message_id, message_count
         FROM message_embedding_chunks
         ORDER BY id ASC`,
      )
      .all() as Record<string, unknown>[];
    const selectMessages = this.db.prepare(
      `SELECT message_id
       FROM messages
       WHERE chat_id = ?
         AND message_id BETWEEN ? AND ?
         AND length(trim(text)) > 0
         AND deleted_at IS NULL
       ORDER BY message_id ASC
       LIMIT ?`,
    );
    for (const chunk of chunks) {
      const rows = selectMessages.all(
        String(chunk.chat_id),
        Number(chunk.start_message_id),
        Number(chunk.end_message_id),
        Math.max(1, Number(chunk.message_count ?? 1)),
      ) as Record<string, unknown>[];
      this.replaceEmbeddingChunkMessagesLocked(
        Number(chunk.id),
        String(chunk.chat_id),
        rows.map((row) => Number(row.message_id)),
      );
    }
  }

  protected applySendOutboxMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS send_outbox (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT UNIQUE,
        payload_hash TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        reply_to_message_id INTEGER,
        user_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'sending', 'sent', 'failed', 'expired')),
        telegram_message_id INTEGER,
        error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        queued_at_ms INTEGER,
        sending_at_ms INTEGER,
        sent_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS send_throttle_state (
        chat_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        next_allowed_at_ms INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(chat_id, user_key)
      );

      CREATE INDEX IF NOT EXISTS idx_send_outbox_chat_status
        ON send_outbox(chat_id, status, expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_send_outbox_user_status
        ON send_outbox(chat_id, user_key, status, expires_at_ms);
    `);
  }

  /**
   * Separates unthreaded maintenance publication from inbound bot turns and
   * the in-memory send-throttler audit rows. A `sending` row is a delivery
   * fence: recovery converts it to lost_ack rather than replaying it.
   */
  protected applyBotDreamPublicationsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_dream_publications (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        markdown TEXT NOT NULL,
        plain_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'sending', 'sent', 'failed', 'lost_ack')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        lease_owner TEXT,
        retry_not_before_ms INTEGER,
        telegram_message_id INTEGER,
        error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        sending_at_ms INTEGER,
        sent_at_ms INTEGER,
        completed_at_ms INTEGER,
        CHECK(length(trim(id)) > 0),
        CHECK(length(trim(dedupe_key)) > 0),
        CHECK(length(trim(payload_hash)) > 0),
        CHECK(length(trim(chat_id)) > 0),
        CHECK(length(trim(markdown)) > 0),
        CHECK(length(trim(plain_text)) > 0),
        CHECK(attempts >= 0),
        CHECK(max_attempts >= 1)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_dream_publications_due
        ON bot_dream_publications(chat_id, status, retry_not_before_ms, created_at_ms);
    `);
  }

  protected applyRecentCatchupMigration(): void {
    this.ensureColumn("sync_state", "recent_catchup_min_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_next_offset_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_newest_id", "INTEGER");
  }

  protected applyEmbeddingNamespaceMigration(): void {
    if (!this.hasColumn("message_embedding_chunks", "embedding_namespace")) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS embedding_chunks_ad;
        DROP INDEX IF EXISTS idx_embedding_chunks_lookup;
        DROP INDEX IF EXISTS idx_embedding_chunks_range;
        ALTER TABLE message_embedding_chunks RENAME TO message_embedding_chunks_old;
        CREATE TABLE message_embedding_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          start_message_id INTEGER NOT NULL,
          end_message_id INTEGER NOT NULL,
          message_count INTEGER NOT NULL,
          text TEXT NOT NULL,
          embedding_namespace TEXT NOT NULL DEFAULT '${LEGACY_EMBEDDING_NAMESPACE}',
          embedding_model TEXT NOT NULL,
          embedding_dimensions INTEGER NOT NULL,
          embedding BLOB NOT NULL,
          content_hash TEXT NOT NULL,
          dirty_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(chat_id, start_message_id, end_message_id, embedding_namespace)
        );
        INSERT INTO message_embedding_chunks (
          id, chat_id, start_message_id, end_message_id, message_count, text,
          embedding_namespace, embedding_model, embedding_dimensions, embedding, content_hash, dirty_at, updated_at
        )
        SELECT
          id, chat_id, start_message_id, end_message_id, message_count, text,
          '${LEGACY_EMBEDDING_NAMESPACE}', embedding_model, embedding_dimensions, embedding, content_hash, dirty_at, updated_at
        FROM message_embedding_chunks_old;
        DROP TABLE message_embedding_chunks_old;
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_embedding_chunks_lookup
        ON message_embedding_chunks(chat_id, embedding_namespace, embedding_model, embedding_dimensions);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunks_range
        ON message_embedding_chunks(chat_id, embedding_namespace, start_message_id, end_message_id);
      CREATE TRIGGER IF NOT EXISTS embedding_chunks_ad AFTER DELETE ON message_embedding_chunks BEGIN
        DELETE FROM message_embedding_chunk_messages WHERE chunk_id = old.id;
      END;
    `);
  }

  protected applyManagedSqlObjectVersionMigration(): void {
    this.applyMaintenanceSchema();
    this.ensureMessagesFtsDefinition();
    for (const definition of MANAGED_TRIGGER_DEFINITIONS) {
      this.ensureManagedTriggerDefinition(definition);
    }
  }

  protected applyBotDurabilityMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_updates (
        update_id INTEGER PRIMARY KEY,
        raw_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'drafted', 'sending', 'sent', 'skipped',
          'failed', 'lost_ack', 'dead_letter'
        )),
        addressed INTEGER NOT NULL DEFAULT 0 CHECK(addressed IN (0, 1)),
        chat_id TEXT,
        trigger_message_id INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_BOT_MAX_ATTEMPTS}
          CHECK(max_attempts BETWEEN 1 AND ${MAX_BOT_ATTEMPTS}),
        error TEXT,
        received_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        CHECK(attempts >= 0 AND attempts <= max_attempts),
        CHECK(
          (chat_id IS NULL AND trigger_message_id IS NULL)
          OR (chat_id IS NOT NULL AND trigger_message_id IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS bot_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        trigger_message_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'drafted', 'sending', 'sent', 'skipped',
          'failed', 'lost_ack', 'dead_letter'
        )),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_BOT_MAX_ATTEMPTS}
          CHECK(max_attempts BETWEEN 1 AND ${MAX_BOT_ATTEMPTS}),
        lease_owner TEXT,
        lease_expires_at_ms INTEGER,
        draft_text TEXT,
        telegram_message_id INTEGER,
        error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        UNIQUE(chat_id, trigger_message_id),
        CHECK(attempts >= 0 AND attempts <= max_attempts),
        CHECK(
          (
            status IN ('running', 'drafted')
            AND lease_owner IS NOT NULL
            AND lease_expires_at_ms IS NOT NULL
          )
          OR (
            status NOT IN ('running', 'drafted')
            AND lease_owner IS NULL
            AND lease_expires_at_ms IS NULL
          )
        )
      );

      CREATE INDEX IF NOT EXISTS idx_bot_updates_status
        ON bot_updates(status, update_id);
      CREATE INDEX IF NOT EXISTS idx_bot_turns_claim
        ON bot_turns(status, lease_expires_at_ms, created_at_ms, id);
      CREATE INDEX IF NOT EXISTS idx_bot_turns_chat_status
        ON bot_turns(chat_id, status, created_at_ms, id);
    `);
  }

  protected applyDigestCacheMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_day_digests (
        chat_id TEXT NOT NULL,
        day TEXT NOT NULL,
        start_message_id INTEGER NOT NULL,
        end_message_id INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        text TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        source_hash TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(chat_id, day),
        CHECK(start_message_id > 0),
        CHECK(end_message_id >= start_message_id),
        CHECK(message_count > 0),
        CHECK(length(trim(text)) > 0),
        CHECK(input_tokens IS NULL OR input_tokens >= 0),
        CHECK(output_tokens IS NULL OR output_tokens >= 0)
      );

      CREATE TABLE IF NOT EXISTS chat_digest_rollups (
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('week', 'month')),
        period TEXT NOT NULL,
        day_from TEXT NOT NULL,
        day_to TEXT NOT NULL,
        day_count INTEGER NOT NULL,
        text TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        source_hash TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(chat_id, kind, period),
        CHECK(day_to >= day_from),
        CHECK(day_count > 0),
        CHECK(length(trim(text)) > 0),
        CHECK(input_tokens IS NULL OR input_tokens >= 0),
        CHECK(output_tokens IS NULL OR output_tokens >= 0)
      );

      CREATE INDEX IF NOT EXISTS idx_chat_day_digests_range
        ON chat_day_digests(chat_id, day);
      CREATE INDEX IF NOT EXISTS idx_chat_digest_rollups_range
        ON chat_digest_rollups(chat_id, kind, day_from, day_to);
    `);
  }

  protected applyBotRetryBackoffMigration(): void {
    this.ensureColumn(
      "bot_turns",
      "retry_not_before_ms",
      "INTEGER",
    );
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bot_turns_due
        ON bot_turns(
          chat_id,
          status,
          retry_not_before_ms,
          created_at_ms,
          id
        );
    `);
  }

  protected applyBotToolProgressMigration(): void {
    this.ensureColumn("bot_turns", "progress_message_id", "INTEGER");
    this.ensureColumn(
      "bot_turns",
      "progress_state",
      "TEXT CHECK(progress_state IN ('none', 'dispatching', 'active', 'unknown'))",
    );
  }

  protected applyBotCodexSessionsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_codex_sessions (
        chat_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }

  protected applyBotChatMemoryMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_chat_memory (
        chat_id TEXT NOT NULL PRIMARY KEY,
        memory_text TEXT NOT NULL DEFAULT '',
        last_consolidated_message_id INTEGER,
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }

  protected applyBotChatKnowledgeMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_chat_fast_memory (
        chat_id TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        title TEXT NOT NULL,
        note TEXT NOT NULL,
        source_message_id INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(chat_id, memory_key),
        CHECK(length(trim(memory_key)) > 0),
        CHECK(length(trim(title)) > 0),
        CHECK(length(trim(note)) > 0)
      );

      CREATE TABLE IF NOT EXISTS bot_chat_lessons (
        chat_id TEXT NOT NULL,
        lesson_key TEXT NOT NULL,
        title TEXT NOT NULL,
        problem TEXT NOT NULL,
        solution TEXT NOT NULL,
        when_to_apply TEXT NOT NULL,
        source_message_id INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(chat_id, lesson_key),
        CHECK(length(trim(lesson_key)) > 0),
        CHECK(length(trim(title)) > 0),
        CHECK(length(trim(problem)) > 0),
        CHECK(length(trim(solution)) > 0),
        CHECK(length(trim(when_to_apply)) > 0)
      );

      CREATE TABLE IF NOT EXISTS bot_chat_skills (
        chat_id TEXT NOT NULL,
        skill_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        source_message_id INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(chat_id, skill_key),
        CHECK(length(trim(skill_key)) > 0),
        CHECK(length(trim(name)) > 0),
        CHECK(length(trim(description)) > 0),
        CHECK(length(trim(instructions)) > 0)
      );

      CREATE INDEX IF NOT EXISTS idx_bot_chat_fast_memory_recent
        ON bot_chat_fast_memory(chat_id, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_chat_lessons_recent
        ON bot_chat_lessons(chat_id, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_chat_skills_recent
        ON bot_chat_skills(chat_id, updated_at_ms DESC);
    `);
  }

  /**
   * Inline response actions were retired. Drop their isolated table rather
   * than retaining prompt continuations or user ownership records after the
   * feature is gone. `IF EXISTS` makes a v16 database (which never had the
   * table) and a v17/v18 database converge on the same v19 schema.
   */
  protected applyRetireBotCallbackIntentsMigration(): void {
    this.db.exec("DROP TABLE IF EXISTS bot_callback_intents;");
  }

  protected applyBotChatDreamDaysMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_chat_dream_days (
        chat_id TEXT NOT NULL,
        day TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        source_hash TEXT,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        first_message_id INTEGER,
        last_message_id INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        model TEXT,
        provider TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        PRIMARY KEY(chat_id, day)
      );

      CREATE INDEX IF NOT EXISTS idx_bot_chat_dream_days_status
        ON bot_chat_dream_days(chat_id, status, day);
      CREATE INDEX IF NOT EXISTS idx_bot_chat_dream_days_day
        ON bot_chat_dream_days(chat_id, day);
    `);
  }

  /**
   * Learned sparse postings for the local BGE-M3 backend. Each posting row
   * belongs to a parent `message_embedding_chunks` row, so the parent
   * namespace/model/dimensions already pin tokenizer and weight contract;
   * mixing tokenizers across one parent row set is impossible.
   */
  protected applyLearnedSparsePostingsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_embedding_sparse_terms (
        chunk_id INTEGER NOT NULL,
        token_id INTEGER NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY(chunk_id, token_id)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_embedding_sparse_terms_lookup
        ON message_embedding_sparse_terms(token_id, chunk_id);
    `);
    for (const definition of MANAGED_TRIGGER_DEFINITIONS) {
      this.ensureManagedTriggerDefinition(definition);
    }
  }

  /**
   * Per-day exact audit for Dream memory consolidation. Each completed day
   * records a deterministic canonical delta of every mutable layer before and
   * after the atomic commit. The audit column is bounded JSON without raw
   * prompts, secrets, or tool payloads. Failed/rejected days leave no audit
   * row; idempotent reruns do not duplicate or overwrite the original.
   */
  protected applyDreamAuditMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_chat_dream_audits (
        chat_id TEXT NOT NULL,
        day TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(chat_id, day),
        CHECK(length(trim(audit_json)) > 0),
        CHECK(length(CAST(audit_json AS BLOB)) <= ${MAX_AUDIT_JSON_BYTES})
      );
    `);
  }
}
