import type { ChatInfo } from "../../telegram/types.js";
import type { StoredMessage } from "../../store.js";
import {
  GrammyBotTurnPublisher,
  type GrammyBotApiPort,
} from "../grammy-publisher.js";
import type { ToolProgressBotApiPort } from "../tool-progress.js";
import type { OwnSendStore } from "./contracts.js";
import type {
  BotApiLongPollerOptions,
  TelegramLongPollingApiPort,
} from "./long-poller.js";
import {
  asRecord,
  botApiDate,
  BotRuntimeProtocolError,
  normalizeExpectedUsername,
  positiveSafeInteger,
  positiveTelegramId,
  stringifyUpdate,
  telegramId,
} from "./helpers.js";

/**
 * Minimal Bot API surface required by the durable runtime. An implementation
 * may use native fetch, but no framework types or framework runtime are part
 * of this boundary.
 */
export interface TelegramBotApiPort extends GrammyBotApiPort {
  /** Sends a validated, presentation-only message that never enters the corpus. */
  sendTransientMessage(
    chatId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  sendChatAction(chatId: string, signal: AbortSignal): Promise<void>;
  getMe(signal: AbortSignal): Promise<unknown>;
  deleteWebhook(
    options: { drop_pending_updates: false },
    signal: AbortSignal,
  ): Promise<unknown>;
  getUpdates(
    options: {
      offset?: number;
      timeout: number;
      limit: number;
      allowed_updates: readonly ("message" | "edited_message")[];
    },
    signal: AbortSignal,
  ): Promise<unknown>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  deleteMessage(
    chatId: string,
    messageId: number,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export function createTelegramLongPollingApi(
  api: Pick<TelegramBotApiPort, "getMe" | "deleteWebhook" | "getUpdates">,
): TelegramLongPollingApiPort {
  return {
    getMe: (signal) => api.getMe(signal),
    deleteWebhook: (options, signal) => api.deleteWebhook(options, signal),
    getUpdates: (options, signal) => api.getUpdates(options, signal),
  };
}

export interface DurableTelegramPublisherOptions {
  store: OwnSendStore;
  botId: string;
  botUsername: string;
}

/**
 * Records every acknowledged outgoing message before delivery control returns
 * to the worker. A recording error after dispatch remains an unknown-delivery
 * fence and cannot trigger an automatic resend.
 */
export function createDurableTelegramBotTurnPublisher(
  api: Pick<TelegramBotApiPort, "sendRichMessage" | "sendMessage">,
  options: DurableTelegramPublisherOptions,
): GrammyBotTurnPublisher {
  const botId = positiveTelegramId(options.botId, "botId");
  const botUsername = normalizeExpectedUsername(options.botUsername);
  const port: GrammyBotApiPort = {
    async sendRichMessage(input) {
      const response = await api.sendRichMessage(input);
      recordOwnSend(options.store, {
        response,
        requestedChatId: input.chatId,
        text: input.plainText,
        replyToMessageId: input.options.reply_parameters.message_id,
        botId,
        botUsername,
      });
      return response;
    },
    async sendMessage(chatId, text, sendOptions, signal) {
      const response = await api.sendMessage(chatId, text, sendOptions, signal);
      const replyToMessageId = sendOptions?.reply_parameters.message_id;
      if (replyToMessageId === undefined) {
        throw new BotRuntimeProtocolError("OWN_SEND_REQUEST_MALFORMED");
      }
      recordOwnSend(options.store, {
        response,
        requestedChatId: chatId,
        text,
        replyToMessageId,
        botId,
        botUsername,
      });
      return response;
    },
  };
  return new GrammyBotTurnPublisher(port);
}

/** Best-effort adapter for the presentation-only progress message. */
export function createToolProgressTelegramBotApiPort(
  api: Pick<
    TelegramBotApiPort,
    "sendTransientMessage" | "sendChatAction" | "editMessageText" | "deleteMessage"
  >,
): ToolProgressBotApiPort {
  return {
    async sendMessage(chatId, text, signal) {
      try {
        const message = await api.sendTransientMessage(
          chatId,
          text,
          signal,
        );
        const messageId = positiveSafeInteger(asRecord(message)?.message_id);
        if (messageId === undefined) return { ok: false };
        pulseTypingAfterProgress(api, chatId, signal);
        return { ok: true, messageId };
      } catch {
        return { ok: false };
      }
    },
    async editMessageText(chatId, messageId, text, signal) {
      try {
        await api.editMessageText(chatId, messageId, text, signal);
        pulseTypingAfterProgress(api, chatId, signal);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async deleteMessage(chatId, messageId, signal) {
      try {
        await api.deleteMessage(chatId, messageId, signal);
        return { ok: true };
      } catch (error) {
        // Deletion is idempotent presentation cleanup. Telegram's definitive
        // "not found" means the bubble is already absent and the durable fence
        // must be cleared instead of retried forever.
        if (telegramMessageAlreadyAbsent(error)) {
          return { ok: true };
        }
        // A known permanent refusal (for example a message outside Telegram's
        // deletion window) cannot be repaired by the next worker loop. Retire
        // only the terminal presentation fence; delivery state is untouched.
        return telegramMessageCannotBeDeleted(error)
          ? { ok: false, terminal: true }
          : { ok: false };
      }
    },
  };
}

/**
 * Telegram clears a native chat action as soon as the bot sends or edits a
 * message. Re-pulse it after each visible progress update so the header keeps
 * saying that the bot is typing while the model continues to work. This is
 * deliberately fire-and-forget: presentation polish cannot add turn latency
 * or change the durable progress result.
 */
function pulseTypingAfterProgress(
  api: Pick<TelegramBotApiPort, "sendChatAction">,
  chatId: string,
  signal: AbortSignal,
): void {
  try {
    void api.sendChatAction(chatId, signal).catch(() => undefined);
  } catch {
    // A synchronous test double or adapter failure is presentation-only too.
  }
}

function telegramMessageAlreadyAbsent(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const rejected = error as { error_code?: unknown; description?: unknown };
  return rejected.error_code === 400 &&
    typeof rejected.description === "string" &&
    rejected.description.trim().toLocaleLowerCase("en-US").endsWith("message to delete not found");
}

function telegramMessageCannotBeDeleted(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const rejected = error as { error_code?: unknown; description?: unknown };
  if (rejected.error_code !== 400 || typeof rejected.description !== "string") {
    return false;
  }
  const description = rejected.description.trim().toLocaleLowerCase("en-US");
  return description.endsWith("message can't be deleted") ||
    description.endsWith("message can't be deleted for everyone");
}

export function botRuntimeOptions(
  input: Readonly<{
    botId: string;
    botUsername: string;
    initialOffset?: number;
    pollTimeoutSec: number;
    pollLimit: number;
    pollBackoffInitialMs: number;
    pollBackoffMaxMs: number;
  }>,
): Pick<
  BotApiLongPollerOptions,
  | "expectedBotId"
  | "expectedBotUsername"
  | "initialOffset"
  | "pollTimeoutSec"
  | "pollLimit"
  | "backoffInitialMs"
  | "backoffMaxMs"
> {
  return {
    expectedBotId: input.botId,
    expectedBotUsername: input.botUsername,
    ...(input.initialOffset === undefined ? {} : { initialOffset: input.initialOffset }),
    pollTimeoutSec: input.pollTimeoutSec,
    pollLimit: input.pollLimit,
    backoffInitialMs: input.pollBackoffInitialMs,
    backoffMaxMs: input.pollBackoffMaxMs,
  };
}

function recordOwnSend(
  store: OwnSendStore,
  input: {
    response: unknown;
    requestedChatId: string;
    text: string;
    replyToMessageId: number;
    botId: string;
    botUsername: string;
  },
): void {
  const response = asRecord(input.response);
  const messageId = positiveSafeInteger(response?.message_id);
  const responseChat = asRecord(response?.chat);
  const responseChatId = telegramId(responseChat?.id);
  if (
    !response ||
    messageId === undefined ||
    responseChatId === undefined ||
    responseChatId !== input.requestedChatId
  ) {
    throw new BotRuntimeProtocolError("OWN_SEND_RESPONSE_MALFORMED");
  }
  const responseSenderId = telegramId(asRecord(response.from)?.id);
  if (responseSenderId !== undefined && responseSenderId !== input.botId) {
    throw new BotRuntimeProtocolError("OWN_SEND_IDENTITY_MISMATCH");
  }

  const cachedChat = store.getCachedChat(input.requestedChatId);
  const chat: ChatInfo = cachedChat ?? {
    chatId: input.requestedChatId,
    requested: input.requestedChatId,
    kind: typeof responseChat?.type === "string" ? responseChat.type : "unknown",
    ...(typeof responseChat?.title === "string" ? { title: responseChat.title } : {}),
    ...(typeof responseChat?.username === "string" ? { username: responseChat.username } : {}),
  };
  const date = botApiDate(response.date);
  const rawJson = stringifyUpdate(response);
  const message: StoredMessage = {
    chatId: input.requestedChatId,
    messageId,
    ...(date === undefined ? {} : { date }),
    senderId: input.botId,
    senderName: input.botUsername,
    text: input.text,
    replyToMessageId: input.replyToMessageId,
    ...(rawJson === undefined ? {} : { rawJson }),
  };
  store.upsertMessages(chat, [message]);
}
