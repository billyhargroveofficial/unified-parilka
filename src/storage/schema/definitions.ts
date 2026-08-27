import { StoreCore } from "../core.js";
import { LEGACY_EMBEDDING_NAMESPACE } from "../constants.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class SchemaDefinitionMethods extends StoreCore {
declare protected ensureColumn: (
    table: string,
    column: string,
    definition: string,
  ) => void;

  protected applyBaseSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        title TEXT,
        username TEXT,
        kind TEXT,
        is_forum INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_aliases (
        alias TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        date TEXT,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT NOT NULL DEFAULT '',
        reply_to_message_id INTEGER,
        topic_id INTEGER,
        raw_json TEXT,
        deleted_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(chat_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        chat_id TEXT PRIMARY KEY,
        oldest_message_id INTEGER,
        newest_message_id INTEGER,
        next_backfill_offset_id INTEGER,
        recent_catchup_min_id INTEGER,
        recent_catchup_next_offset_id INTEGER,
        recent_catchup_newest_id INTEGER,
        synced_count INTEGER NOT NULL DEFAULT 0,
        last_recent_sync_at TEXT,
        last_backfill_at TEXT,
        backfill_exhausted_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history_jobs (
        job_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        target_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        batches INTEGER NOT NULL DEFAULT 0,
        messages_seen INTEGER NOT NULL DEFAULT 0,
        messages_upserted INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS daemon_status (
        service TEXT PRIMARY KEY,
        last_started_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

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

      CREATE TABLE IF NOT EXISTS message_embedding_chunks (
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

      CREATE TABLE IF NOT EXISTS message_embedding_chunk_messages (
        chunk_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(chunk_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS message_embedding_sparse_terms (
        chunk_id INTEGER NOT NULL,
        token_id INTEGER NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY(chunk_id, token_id)
      ) WITHOUT ROWID;

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        sender_name,
        content='messages',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text, sender_name)
        VALUES (new.id, new.text, new.sender_name);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
        VALUES ('delete', old.id, old.text, old.sender_name);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
        VALUES ('delete', old.id, old.text, old.sender_name);
        INSERT INTO messages_fts(rowid, text, sender_name)
        VALUES (new.id, new.text, new.sender_name);
      END;

      CREATE TRIGGER IF NOT EXISTS embedding_chunks_ad AFTER DELETE ON message_embedding_chunks BEGIN
        DELETE FROM message_embedding_chunk_messages WHERE chunk_id = old.id;
      END;

      CREATE INDEX IF NOT EXISTS idx_messages_chat_message_id ON messages(chat_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(chat_id, sender_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunks_lookup
        ON message_embedding_chunks(chat_id, embedding_namespace, embedding_model, embedding_dimensions);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunks_range
        ON message_embedding_chunks(chat_id, embedding_namespace, start_message_id, end_message_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunk_messages_lookup
        ON message_embedding_chunk_messages(chat_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunk_messages_chunk_position
        ON message_embedding_chunk_messages(chunk_id, position);
      CREATE INDEX IF NOT EXISTS idx_embedding_sparse_terms_lookup
        ON message_embedding_sparse_terms(token_id, chunk_id);
      CREATE INDEX IF NOT EXISTS idx_send_outbox_chat_status
        ON send_outbox(chat_id, status, expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_send_outbox_user_status
        ON send_outbox(chat_id, user_key, status, expires_at_ms);

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
      CREATE INDEX IF NOT EXISTS idx_chat_aliases_chat_id
        ON chat_aliases(chat_id);
    `);
    this.applyMaintenanceSchema();
    this.ensureColumn("sync_state", "next_backfill_offset_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_min_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_next_offset_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_newest_id", "INTEGER");
    this.ensureColumn("sync_state", "last_recent_sync_at", "TEXT");
    this.ensureColumn("sync_state", "last_backfill_at", "TEXT");
    this.ensureColumn("sync_state", "backfill_exhausted_at", "TEXT");
    this.ensureColumn("sync_state", "last_error", "TEXT");
    this.ensureColumn("messages", "date", "TEXT");
    this.ensureColumn("messages", "sender_id", "TEXT");
    this.ensureColumn("messages", "sender_name", "TEXT");
    this.ensureColumn("messages", "reply_to_message_id", "INTEGER");
    this.ensureColumn("messages", "topic_id", "INTEGER");
    this.ensureColumn("messages", "raw_json", "TEXT");
    this.ensureColumn("messages", "deleted_at", "TEXT");
    this.ensureColumn("messages", "updated_at", "TEXT");
    this.ensureColumn("message_embedding_chunks", "dirty_at", "TEXT");
  }

  protected applyMaintenanceSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_object_versions (
        object_name TEXT PRIMARY KEY,
        object_type TEXT NOT NULL,
        object_version INTEGER NOT NULL,
        object_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS maintenance_jobs (
        name TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
        reason TEXT,
        details_json TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
  }

  protected applyDigestQueryIndex(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_digest_date
        ON messages(chat_id, date, message_id)
        WHERE deleted_at IS NULL AND date IS NOT NULL;
    `);
  }
}
