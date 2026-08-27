import type { MessageStore, BotUpdateFailureResult, BotUpdateIngestResult, StoredBotTurn, StoredBotUpdate, StoredMessage } from "../../store.js";
import type { ChatInfo } from "../../telegram/types.js";
import type { TelegramUpdateOptions } from "../telegram-update.js";
import type { TurnCoordinator } from "../turn-coordinator.js";
import type { JsonEventLogger } from "../worker.js";
import type { TypingLeaseManager } from "../typing.js";

export const MAX_BOT_WORKER_CONCURRENCY = 3;

export interface BotRuntimeStore {
  getBotUpdate(updateId: number): StoredBotUpdate | undefined;
  getBotTurnByTrigger(chatId: string, triggerMessageId: number): StoredBotTurn | undefined;
  ingestBotUpdate(params: Parameters<MessageStore["ingestBotUpdate"]>[0]): BotUpdateIngestResult;
  recordBotUpdateFailure(params: Parameters<MessageStore["recordBotUpdateFailure"]>[0]): BotUpdateFailureResult;
}

export interface OwnSendStore {
  getCachedChat(chatId: string): ChatInfo | undefined;
  upsertMessages(chat: ChatInfo, messages: StoredMessage[]): number;
}

export interface BotWorkNotifier {
  notify(): void;
}

export type BotUpdateProcessingResult =
  | { acknowledged: true; ackUpdateId: number; disposition: "ingested" | "recovered" | "duplicate" | "dead_letter"; turnReserved: boolean; routed: boolean }
  | { acknowledged: false; updateId: number; disposition: "poison_retry" };

export interface BotUpdateProcessorOptions {
  store: BotRuntimeStore;
  coordinator: TurnCoordinator;
  workNotifier: BotWorkNotifier;
  /** Starts chat-level typing immediately after a durable turn reservation. */
  typingLeases?: Pick<TypingLeaseManager, "enqueue">;
  telegram: TelegramUpdateOptions;
  triggerCooldownMs?: number;
  updateMaxAttempts?: number;
  logger?: JsonEventLogger;
  now?: () => number;
}
