import type { ChatInfo } from "../telegram/types.js";
import { LEGACY_EMBEDDING_NAMESPACE } from "./constants.js";
import type {
  BotDurableStatus,
  BotTurnProgressState,
  DaemonStatus,
  DreamPublicationStatus,
  MaintenanceJob,
  MaintenanceJobStatus,
  SendOutboxStatus,
  StoredBotTurn,
  StoredBotUpdate,
  StoredDayDigest,
  StoredDreamPublication,
  StoredDigestRollup,
  StoredEmbeddingChunk,
  StoredMessage,
  StoredSendOutboxItem,
  SyncState,
} from "./types.js";

export function rowToStoredMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    messageId: Number(row.message_id),
    date: row.date == null ? undefined : String(row.date),
    senderId: row.sender_id == null ? undefined : String(row.sender_id),
    senderName: row.sender_name == null ? undefined : String(row.sender_name),
    text: String(row.text ?? ""),
    replyToMessageId: row.reply_to_message_id == null ? undefined : Number(row.reply_to_message_id),
    topicId: row.topic_id == null ? undefined : Number(row.topic_id),
    rawJson: row.raw_json == null ? undefined : String(row.raw_json),
    deletedAt: row.deleted_at == null ? undefined : String(row.deleted_at),
  };
}

export function rowToChatInfo(row: Record<string, unknown>): ChatInfo {
  return {
    chatId: String(row.chat_id),
    requested: String(row.chat_id),
    title: row.title == null ? undefined : String(row.title),
    username: row.username == null ? undefined : String(row.username),
    kind: row.kind == null ? "Cached" : String(row.kind),
    isForum: row.is_forum === 1,
  };
}

export function chatAliases(chat: ChatInfo): string[] {
  const aliases = new Set<string>([normalizeChatAlias(chat.chatId), normalizeChatAlias(chat.requested)]);
  if (chat.username) {
    aliases.add(normalizeChatAlias(chat.username));
    aliases.add(normalizeChatAlias(`@${chat.username}`));
  }
  return [...aliases].filter(Boolean);
}

export function normalizeChatAlias(chat: string): string {
  const trimmed = chat.trim();
  if (trimmed.startsWith("@")) {
    return trimmed.toLowerCase();
  }
  if (/^[a-zA-Z0-9_]{5,}$/.test(trimmed)) {
    return `@${trimmed.toLowerCase()}`;
  }
  return trimmed;
}

export function optionalNumber(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

export function rowToSyncState(row: Record<string, unknown>): SyncState {
  return {
    chatId: String(row.chat_id),
    oldestMessageId: row.oldest_message_id == null ? undefined : Number(row.oldest_message_id),
    newestMessageId: row.newest_message_id == null ? undefined : Number(row.newest_message_id),
    nextBackfillOffsetId: row.next_backfill_offset_id == null ? undefined : Number(row.next_backfill_offset_id),
    recentCatchupMinId: row.recent_catchup_min_id == null ? undefined : Number(row.recent_catchup_min_id),
    recentCatchupNextOffsetId:
      row.recent_catchup_next_offset_id == null ? undefined : Number(row.recent_catchup_next_offset_id),
    recentCatchupNewestId: row.recent_catchup_newest_id == null ? undefined : Number(row.recent_catchup_newest_id),
    syncedCount: Number(row.synced_count ?? 0),
    lastRecentSyncAt: row.last_recent_sync_at == null ? undefined : String(row.last_recent_sync_at),
    lastBackfillAt: row.last_backfill_at == null ? undefined : String(row.last_backfill_at),
    backfillExhaustedAt: row.backfill_exhausted_at == null ? undefined : String(row.backfill_exhausted_at),
    lastError: row.last_error == null ? undefined : String(row.last_error),
    updatedAt: row.updated_at == null ? undefined : String(row.updated_at),
  };
}

export function rowToDaemonStatus(row: Record<string, unknown>): DaemonStatus {
  return {
    service: String(row.service),
    lastStartedAt: row.last_started_at == null ? undefined : String(row.last_started_at),
    lastSuccessAt: row.last_success_at == null ? undefined : String(row.last_success_at),
    lastFailureAt: row.last_failure_at == null ? undefined : String(row.last_failure_at),
    lastError: row.last_error == null ? undefined : String(row.last_error),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    updatedAt: row.updated_at == null ? undefined : String(row.updated_at),
  };
}

export function rowToMaintenanceJob(row: Record<string, unknown>): MaintenanceJob {
  let details: Record<string, unknown> | undefined;
  if (typeof row.details_json === "string" && row.details_json.trim() !== "") {
    try {
      const parsed = JSON.parse(row.details_json) as unknown;
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      details = { parse_error: "invalid details_json" };
    }
  }
  return {
    name: String(row.name),
    status: String(row.status) as MaintenanceJobStatus,
    reason: row.reason == null ? undefined : String(row.reason),
    details,
    updatedAt: row.updated_at == null ? undefined : String(row.updated_at),
    completedAt: row.completed_at == null ? undefined : String(row.completed_at),
  };
}

export function rowToEmbeddingChunk(row: Record<string, unknown>): StoredEmbeddingChunk {
  const dimensions = Number(row.embedding_dimensions);
  const embedding = embeddingBlobFromRow(row.embedding, dimensions);
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    namespace: String(row.embedding_namespace ?? LEGACY_EMBEDDING_NAMESPACE),
    startMessageId: Number(row.start_message_id),
    endMessageId: Number(row.end_message_id),
    messageIds: [],
    messageCount: Number(row.message_count),
    text: String(row.text ?? ""),
    model: String(row.embedding_model),
    dimensions,
    embedding,
    contentHash: String(row.content_hash),
    dirtyAt: row.dirty_at == null ? undefined : String(row.dirty_at),
    updatedAt: String(row.updated_at),
  };
}

function embeddingBlobFromRow(
  value: unknown,
  dimensions: number,
): Uint8Array {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new Error("Embedding row dimensions must be a positive safe integer.");
  }
  if (!(value instanceof Uint8Array)) {
    throw new Error("Embedding row BLOB must be a Uint8Array.");
  }
  if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Embedding row BLOB byte length must be divisible by 4.");
  }
  const actualDimensions =
    value.byteLength / Float32Array.BYTES_PER_ELEMENT;
  if (actualDimensions !== dimensions) {
    throw new Error(
      `Embedding BLOB has ${actualDimensions} dimensions but row declares ${dimensions}.`,
    );
  }
  return value;
}

export function rowToSendOutboxItem(row: Record<string, unknown>): StoredSendOutboxItem {
  return {
    id: String(row.id),
    dedupeKey: row.dedupe_key == null ? undefined : String(row.dedupe_key),
    payloadHash: String(row.payload_hash),
    chatId: String(row.chat_id),
    replyToMessageId: row.reply_to_message_id == null ? undefined : Number(row.reply_to_message_id),
    userKey: String(row.user_key),
    status: String(row.status) as SendOutboxStatus,
    telegramMessageId: row.telegram_message_id == null ? undefined : Number(row.telegram_message_id),
    error: row.error == null ? undefined : String(row.error),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    queuedAtMs: row.queued_at_ms == null ? undefined : Number(row.queued_at_ms),
    sendingAtMs: row.sending_at_ms == null ? undefined : Number(row.sending_at_ms),
    sentAtMs: row.sent_at_ms == null ? undefined : Number(row.sent_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

export function rowToStoredDreamPublication(
  row: Record<string, unknown>,
): StoredDreamPublication {
  return {
    id: String(row.id),
    dedupeKey: String(row.dedupe_key),
    payloadHash: String(row.payload_hash),
    chatId: String(row.chat_id),
    markdown: String(row.markdown),
    plainText: String(row.plain_text),
    status: String(row.status) as DreamPublicationStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner == null ? undefined : String(row.lease_owner),
    retryNotBeforeMs:
      row.retry_not_before_ms == null
        ? undefined
        : Number(row.retry_not_before_ms),
    telegramMessageId:
      row.telegram_message_id == null
        ? undefined
        : Number(row.telegram_message_id),
    error: row.error == null ? undefined : String(row.error),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    sendingAtMs: row.sending_at_ms == null ? undefined : Number(row.sending_at_ms),
    sentAtMs: row.sent_at_ms == null ? undefined : Number(row.sent_at_ms),
    completedAtMs:
      row.completed_at_ms == null ? undefined : Number(row.completed_at_ms),
  };
}

export function rowToStoredBotUpdate(row: Record<string, unknown>): StoredBotUpdate {
  return {
    updateId: Number(row.update_id),
    rawJson: String(row.raw_json),
    status: String(row.status) as BotDurableStatus,
    addressed: Number(row.addressed) === 1,
    chatId: row.chat_id == null ? undefined : String(row.chat_id),
    triggerMessageId: row.trigger_message_id == null ? undefined : Number(row.trigger_message_id),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    error: row.error == null ? undefined : String(row.error),
    receivedAtMs: Number(row.received_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    completedAtMs: row.completed_at_ms == null ? undefined : Number(row.completed_at_ms),
  };
}

export function rowToStoredBotTurn(row: Record<string, unknown>): StoredBotTurn {
  return {
    id: Number(row.id),
    updateId: Number(row.update_id),
    chatId: String(row.chat_id),
    triggerMessageId: Number(row.trigger_message_id),
    status: String(row.status) as BotDurableStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner == null ? undefined : String(row.lease_owner),
    leaseExpiresAtMs: row.lease_expires_at_ms == null ? undefined : Number(row.lease_expires_at_ms),
    retryNotBeforeMs:
      row.retry_not_before_ms == null
        ? undefined
        : Number(row.retry_not_before_ms),
    draftText: row.draft_text == null ? undefined : String(row.draft_text),
    telegramMessageId: row.telegram_message_id == null ? undefined : Number(row.telegram_message_id),
    progressMessageId: row.progress_message_id == null ? undefined : Number(row.progress_message_id),
    progressState: row.progress_state == null
      ? undefined
      : String(row.progress_state) as BotTurnProgressState,
    error: row.error == null ? undefined : String(row.error),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    startedAtMs: row.started_at_ms == null ? undefined : Number(row.started_at_ms),
    completedAtMs: row.completed_at_ms == null ? undefined : Number(row.completed_at_ms),
  };
}

export function rowToStoredDayDigest(
  row: Record<string, unknown>,
): StoredDayDigest {
  return {
    chatId: String(row.chat_id),
    day: String(row.day),
    startMessageId: Number(row.start_message_id),
    endMessageId: Number(row.end_message_id),
    messageCount: Number(row.message_count),
    text: String(row.text),
    promptVersion: String(row.prompt_version),
    model: row.model == null ? undefined : String(row.model),
    inputTokens:
      row.input_tokens == null ? undefined : Number(row.input_tokens),
    outputTokens:
      row.output_tokens == null ? undefined : Number(row.output_tokens),
    sourceHash:
      row.source_hash == null ? undefined : String(row.source_hash),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function rowToStoredDigestRollup(
  row: Record<string, unknown>,
): StoredDigestRollup {
  return {
    chatId: String(row.chat_id),
    kind: String(row.kind) as StoredDigestRollup["kind"],
    period: String(row.period),
    dayFrom: String(row.day_from),
    dayTo: String(row.day_to),
    dayCount: Number(row.day_count),
    text: String(row.text),
    promptVersion: String(row.prompt_version),
    model: row.model == null ? undefined : String(row.model),
    inputTokens:
      row.input_tokens == null ? undefined : Number(row.input_tokens),
    outputTokens:
      row.output_tokens == null ? undefined : Number(row.output_tokens),
    sourceHash:
      row.source_hash == null ? undefined : String(row.source_hash),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}
