import { BotTurnMethods, type BotTurnApi } from "./storage/bot-turns.js";
import { BotUpdateMethods, type BotUpdateApi } from "./storage/bot-updates.js";
import {
  ChatKnowledgeMethods,
  type ChatKnowledgeApi,
} from "./storage/chat-knowledge.js";
import { StoreCore } from "./storage/core.js";
import { DigestMethods, type DigestApi } from "./storage/digests.js";
import { DreamCommitMethods, type DreamCommitApi } from "./storage/dream-commit.js";
import { DreamDaysMethods, type DreamDaysApi } from "./storage/dream-days.js";
import {
  DreamPublicationsMethods,
  type DreamPublicationsApi,
} from "./storage/dream-publications.js";
import { DreamAuditMethods, type DreamAuditApi } from "./storage/dream-audit.js";
import { MemoryMethods, type MemoryApi } from "./storage/memory.js";
import { EmbeddingMethods, type EmbeddingApi } from "./storage/embeddings.js";
import { installStoreDomain } from "./storage/install-domain.js";
import { MessageMethods, type MessageApi } from "./storage/messages.js";
import { SchemaDefinitionMethods } from "./storage/schema/definitions.js";
import { SchemaLifecycleMethods } from "./storage/schema/lifecycle.js";
import { SchemaMigrationMethods } from "./storage/schema/migrations.js";
import { SchemaObjectMethods } from "./storage/schema/objects.js";
import {
  SendOutboxMethods,
  type SendOutboxApi,
} from "./storage/send-outbox.js";
import {
  SparsePostingsMethods,
  type SparsePostingsApi,
} from "./storage/sparse-postings.js";
import { StatusMethods, type StatusApi } from "./storage/status.js";
import { SyncOpsMethods, type SyncOpsApi } from "./storage/sync-ops.js";
import {
  TranscriptMethods,
  TranscriptCursorError,
  MAX_TRANSCRIPT_PAGE_ROWS,
  MAX_TRANSCRIPT_RECENT_COUNT,
  type TranscriptApi,
} from "./storage/transcript.js";
import type { MessageStoreOptions } from "./storage/types.js";

export * from "./storage/message-adapter.js";
export type * from "./storage/types.js";
export {
  TranscriptCursorError,
  MAX_TRANSCRIPT_PAGE_ROWS,
  MAX_TRANSCRIPT_RECENT_COUNT,
} from "./storage/transcript.js";
export {
  MAX_FAST_CHAT_MEMORY_ITEMS,
  MAX_CHAT_LESSONS,
  MAX_CHAT_SKILLS,
  MAX_FAST_TITLE_CHARS,
  MAX_FAST_NOTE_CHARS,
  MAX_LESSON_TITLE_CHARS,
  MAX_LESSON_FIELD_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  MAX_KNOWLEDGE_QUERY_CHARS,
} from "./storage/chat-knowledge.js";
export {
  MAX_SPARSE_QUERY_TERMS,
  MAX_SPARSE_TERMS_PER_CHUNK,
  MAX_SPARSE_TOKEN_ID,
  MAX_SPARSE_WEIGHT,
  normalizeSparseTerms,
} from "./storage/validation.js";
export {
  MAX_AUDIT_JSON_BYTES,
  type DreamAudit,
  type StoredDreamAudit,
} from "./storage/dream-audit-types.js";
export type { SparseChunkHit } from "./storage/sparse-postings.js";

export interface MessageStore
  extends MessageApi,
    BotUpdateApi,
    BotTurnApi,
    DigestApi,
    DreamDaysApi,
    DreamPublicationsApi,
    DreamCommitApi,
    DreamAuditApi,
    EmbeddingApi,
    SparsePostingsApi,
    ChatKnowledgeApi,
    MemoryApi,
    SendOutboxApi,
    SyncOpsApi,
    StatusApi,
    TranscriptApi {}

/**
 * Stable compatibility facade over domain-focused SQLite method modules.
 *
 * There is exactly one StoreCore and one DatabaseSync per MessageStore.
 * Modules contribute methods to this prototype; they are never instantiated
 * as separate stores and cannot start nested transactions independently.
 */
export class MessageStore extends StoreCore {
  declare private initializeStore: (options: MessageStoreOptions) => void;

  constructor(path: string, options: MessageStoreOptions = {}) {
    super(path, options);
    try {
      this.initializeStore(options);
    } catch (error) {
      this.close();
      throw error;
    }
  }
}

const domains = [
  SchemaDefinitionMethods,
  SchemaMigrationMethods,
  SchemaObjectMethods,
  SchemaLifecycleMethods,
  MessageMethods,
  BotUpdateMethods,
  BotTurnMethods,
  DigestMethods,
  DreamDaysMethods,
  DreamPublicationsMethods,
  DreamCommitMethods,
  DreamAuditMethods,
  EmbeddingMethods,
  SparsePostingsMethods,
  ChatKnowledgeMethods,
  MemoryMethods,
  SendOutboxMethods,
  SyncOpsMethods,
  StatusMethods,
  TranscriptMethods,
] as const;

for (const domain of domains) {
  installStoreDomain(
    MessageStore.prototype as unknown as Record<PropertyKey, unknown>,
    domain.prototype as unknown as Record<PropertyKey, unknown>,
  );
}
