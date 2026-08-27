export const SQLITE_BUSY_TIMEOUT_MS = 250;

export const SQLITE_BUSY_RETRY_ATTEMPTS = 6;

export const SQLITE_BUSY_RETRY_INITIAL_MS = 25;

export const SCHEMA_VERSION = 23;

export const DEFAULT_BOT_MAX_ATTEMPTS = 3;

export const MAX_BOT_ATTEMPTS = 20;

export const MIN_BOT_LEASE_MS = 100;

export const MAX_BOT_LEASE_MS = 15 * 60_000;

export const BOT_RETRY_INITIAL_MS = 5_000;

export const BOT_RETRY_MAX_MS = 15 * 60_000;

export const BOT_DURABLE_STATUSES = [
  "queued",
  "running",
  "drafted",
  "sending",
  "sent",
  "skipped",
  "failed",
  "lost_ack",
  "dead_letter",
] as const;

export const LEGACY_EMBEDDING_NAMESPACE = "legacy";

export const FTS_REBUILD_INLINE_MESSAGE_LIMIT = 10_000;

export const EMBEDDING_MEMBERSHIP_INLINE_CHUNK_LIMIT = 1_000;

export const MESSAGES_FTS_VERSION = 1;

export const MESSAGES_FTS_SQL = `CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  sender_name,
  content='messages',
  content_rowid='id'
)`;

export const MANAGED_TRIGGER_DEFINITIONS = [
  {
    name: "messages_ai",
    version: 1,
    sql: `CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, sender_name)
      VALUES (new.id, new.text, new.sender_name);
    END`,
  },
  {
    name: "messages_ad",
    version: 1,
    sql: `CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
      VALUES ('delete', old.id, old.text, old.sender_name);
    END`,
  },
  {
    name: "messages_au",
    version: 1,
    sql: `CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
      VALUES ('delete', old.id, old.text, old.sender_name);
      INSERT INTO messages_fts(rowid, text, sender_name)
      VALUES (new.id, new.text, new.sender_name);
    END`,
  },
  {
    name: "embedding_chunks_ad",
    version: 2,
    sql: `CREATE TRIGGER embedding_chunks_ad AFTER DELETE ON message_embedding_chunks BEGIN
      DELETE FROM message_embedding_chunk_messages WHERE chunk_id = old.id;
      DELETE FROM message_embedding_sparse_terms WHERE chunk_id = old.id;
    END`,
  },
] as const;

export const RESTART_EXPIRED_SEND_ERROR = "Queued send abandoned by process restart before execution.";

export const LEGACY_UNKNOWN_DELIVERY_AFTER_RESTART_ERROR =
  "Send was in-flight during process restart; Telegram delivery state is unknown and automatic retry is refused.";

export const UNKNOWN_DELIVERY_ERROR =
  "Send dispatch did not receive a definitive Telegram acknowledgement; delivery state is unknown and automatic retry is refused.";
