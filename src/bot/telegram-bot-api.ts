import type { GrammyRichMessageSendInput, GrammySendMessageOptions } from "./grammy-publisher.js";
import { TELEGRAM_RICH_TEXT_LIMIT_UTF8 } from "./telegram-publication.js";
import type { TelegramBotApiPort } from "./runtime/grammy-adapters.js";
import type { OwnSendStore } from "./runtime/contracts.js";
import {
  asRecord,
  botApiDate,
  normalizeExpectedUsername,
  positiveSafeInteger,
  positiveTelegramId,
  stringifyUpdate,
  telegramId,
} from "./runtime/helpers.js";
import type { ChatInfo } from "../telegram/types.js";
import type { StoredMessage } from "../store.js";

const DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface TelegramFetchInit {
  readonly method: "POST" | "GET";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly redirect?: "error";
  readonly signal: AbortSignal;
}

export type TelegramFetch = (
  input: URL | string,
  init: TelegramFetchInit,
) => Promise<Response>;

export interface NativeTelegramBotApiOptions {
  /** Bot token. It is used only while constructing request URLs and never logged. */
  token: string;
  /** Mandatory injection keeps all tests offline and makes proxy routing explicit. */
  fetch: TelegramFetch;
  /** Dedicated lane for getUpdates so a long poll cannot block UI or delivery. */
  pollFetch?: TelegramFetch;
  /** Optional owner cleanup for production connection pools. */
  close?: () => Promise<void>;
  baseUrl?: string;
  maxResponseBytes?: number;
  ownSends: {
    store: OwnSendStore;
    botId: string;
    botUsername: string;
  };
}

/** A machine-readable transport error. Its message intentionally has no URL or token. */
export class TelegramBotApiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "TelegramBotApiError";
    this.code = code;
  }
}

/**
 * A definitive Bot API rejection. The publisher deliberately consumes this
 * shape to distinguish a parser rejection from ambiguous transport delivery.
 */
export class TelegramBotApiRejectedError extends TelegramBotApiError {
  readonly ok = false;
  readonly error_code: number;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;

  constructor(
    errorCode: number,
    description: string,
    parameters?: Record<string, unknown>,
  ) {
    super(`TELEGRAM_${String(errorCode)}`);
    this.name = "TelegramBotApiRejectedError";
    this.error_code = errorCode;
    this.description = description;
    this.parameters = parameters;
  }
}

/**
 * Narrow native Bot API transport used by the durable runtime. It owns no
 * polling loop and exposes no framework API surface.
 */
export class NativeTelegramBotApi implements TelegramBotApiPort {
  readonly #token: string;
  readonly #fetch: TelegramFetch;
  readonly #pollFetch: TelegramFetch;
  readonly #closeOwner: (() => Promise<void>) | undefined;
  readonly #baseUrl: URL;
  readonly #maxResponseBytes: number;
  readonly #ownSends: NativeTelegramBotApiOptions["ownSends"];
  readonly #botId: string;
  readonly #botUsername: string;
  #closePromise: Promise<void> | undefined;

  constructor(options: NativeTelegramBotApiOptions) {
    if (typeof options.token !== "string" || options.token.length === 0 || options.token.length > 4_096 || /[\r\n]/u.test(options.token)) {
      throw new TypeError("Telegram bot token must be a non-empty single-line value.");
    }
    if (typeof options.fetch !== "function") {
      throw new TypeError("Telegram Bot API fetch must be provided.");
    }
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#pollFetch = options.pollFetch ?? options.fetch;
    if (typeof this.#pollFetch !== "function") {
      throw new TypeError("Telegram Bot API poll fetch must be a function.");
    }
    if (options.close !== undefined && typeof options.close !== "function") {
      throw new TypeError("Telegram Bot API close owner must be a function.");
    }
    this.#closeOwner = options.close;
    this.#baseUrl = parseBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#maxResponseBytes = boundedResponseBytes(options.maxResponseBytes);
    this.#ownSends = options.ownSends;
    this.#botId = positiveTelegramId(options.ownSends.botId, "botId");
    this.#botUsername = normalizeExpectedUsername(options.ownSends.botUsername);
  }

  async getMe(signal: AbortSignal): Promise<unknown> {
    return this.#call("getMe", {}, signal, (result) => requireRecord(result, "GET_ME_RESULT_MALFORMED"));
  }

  async deleteWebhook(
    options: { drop_pending_updates: false },
    signal: AbortSignal,
  ): Promise<unknown> {
    if (options.drop_pending_updates !== false) {
      throw new TelegramBotApiError("DELETE_WEBHOOK_OPTIONS_MALFORMED");
    }
    return this.#call("deleteWebhook", options, signal, (result) => {
      if (result !== true) {
        throw new TelegramBotApiError("DELETE_WEBHOOK_RESULT_MALFORMED");
      }
      return result;
    });
  }

  async getUpdates(
    options: {
      offset?: number;
      timeout: number;
      limit: number;
      allowed_updates: readonly ("message" | "edited_message")[];
    },
    signal: AbortSignal,
  ): Promise<unknown> {
    validateGetUpdates(options);
    return this.#call("getUpdates", options, signal, (result) => {
      if (!Array.isArray(result) || result.length > 100) {
        throw new TelegramBotApiError("GET_UPDATES_RESULT_MALFORMED");
      }
      return result;
    }, this.#pollFetch);
  }

  /** Resolves a private Bot API file id without exposing it to a model boundary. */
  async getFile(
    fileId: string,
    signal: AbortSignal,
  ): Promise<{ filePath: string; fileSize?: number }> {
    if (!validTelegramFileId(fileId)) {
      throw new TelegramBotApiError("GET_FILE_ID_MALFORMED");
    }
    return this.#call("getFile", { file_id: fileId }, signal, (result) => {
      const file = requireRecord(result, "GET_FILE_RESULT_MALFORMED");
      const filePath = typeof file.file_path === "string" ? file.file_path : undefined;
      if (!validTelegramFilePath(filePath)) {
        throw new TelegramBotApiError("GET_FILE_RESULT_MALFORMED");
      }
      const fileSize = file.file_size;
      if (
        fileSize !== undefined &&
        (typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize < 0)
      ) {
        throw new TelegramBotApiError("GET_FILE_RESULT_MALFORMED");
      }
      return {
        filePath,
        ...(fileSize === undefined ? {} : { fileSize }),
      };
    });
  }

  /**
   * Starts a redirect-free binary download on the existing action lane. The
   * caller owns body bounds and decoding, while this class owns the token URL.
   */
  async downloadFile(filePath: string, signal: AbortSignal): Promise<Response> {
    if (!validTelegramFilePath(filePath)) {
      throw new TelegramBotApiError("DOWNLOAD_FILE_PATH_MALFORMED");
    }
    if (signal.aborted) throw new TelegramBotApiError("ABORTED");
    try {
      const response = await this.#fetch(this.#fileUrl(filePath), {
        method: "GET",
        headers: { accept: "application/octet-stream" },
        redirect: "error",
        signal,
      });
      if (!response.ok || !response.body) {
        throw new TelegramBotApiError("TELEGRAM_FILE_HTTP");
      }
      return response;
    } catch (error) {
      if (error instanceof TelegramBotApiError) throw error;
      if (signal.aborted) throw new TelegramBotApiError("ABORTED");
      // URLs embed bot tokens; transport errors must never escape this owner.
      throw new TelegramBotApiError("TELEGRAM_FILE_TRANSPORT");
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    options: GrammySendMessageOptions | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const canonicalChatId = requireChatId(chatId);
    requireText(text, "SEND_MESSAGE_TEXT_MALFORMED");
    validateReplyOptions(options);
    const result = await this.#call(
      "sendMessage",
      compact({ chat_id: canonicalChatId, text, ...options }),
      signal,
      (value) => validateOutgoingMessage(value, canonicalChatId, this.#botId),
    );
    this.#recordOwnSend(result, canonicalChatId, text, replyMessageId(options));
    return result;
  }

  /**
   * Sends presentation-only UI (for example, a tool-progress bubble).
   * Its ACK is validated exactly like a normal own message, but it must never
   * be inserted into the chat corpus because it is deleted before the final.
   */
  async sendTransientMessage(
    chatId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const canonicalChatId = requireChatId(chatId);
    requireText(text, "SEND_TRANSIENT_MESSAGE_TEXT_MALFORMED");
    return this.#call(
      "sendMessage",
      { chat_id: canonicalChatId, text },
      signal,
      (value) => validateOutgoingMessage(value, canonicalChatId, this.#botId),
    );
  }

  async sendRichMessage(input: GrammyRichMessageSendInput): Promise<unknown> {
    const canonicalChatId = requireChatId(input.chatId);
    requireRichText(input.plainText, "SEND_RICH_MESSAGE_PLAIN_TEXT_MALFORMED");
    if (
      !input.richMessage ||
      typeof input.richMessage.markdown !== "string" ||
      !isValidRichText(input.richMessage.markdown) ||
      input.richMessage.skip_entity_detection !== true
    ) {
      throw new TelegramBotApiError("SEND_RICH_MESSAGE_PAYLOAD_MALFORMED");
    }
    validateReplyOptions(input.options);
    const result = await this.#call(
      "sendRichMessage",
      {
        chat_id: canonicalChatId,
        rich_message: input.richMessage,
        reply_parameters: input.options.reply_parameters,
      },
      input.signal,
      (value) => validateOutgoingMessage(value, canonicalChatId, this.#botId),
    );
    this.#recordOwnSend(
      result,
      canonicalChatId,
      input.plainText,
      input.options.reply_parameters.message_id,
    );
    return result;
  }

  async sendChatAction(chatId: string, signal: AbortSignal): Promise<void> {
    const canonicalChatId = requireChatId(chatId);
    await this.#call("sendChatAction", { chat_id: canonicalChatId, action: "typing" }, signal, (result) => {
      if (result !== true) {
        throw new TelegramBotApiError("SEND_CHAT_ACTION_RESULT_MALFORMED");
      }
      return result;
    });
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const canonicalChatId = requireChatId(chatId);
    requireMessageId(messageId, "EDIT_MESSAGE_ID_MALFORMED");
    requireText(text, "EDIT_MESSAGE_TEXT_MALFORMED");
    return this.#call(
      "editMessageText",
      { chat_id: canonicalChatId, message_id: messageId, text },
      signal,
      (result) => validateEditResult(result, canonicalChatId, messageId, this.#botId),
    );
  }

  async deleteMessage(
    chatId: string,
    messageId: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const canonicalChatId = requireChatId(chatId);
    requireMessageId(messageId, "DELETE_MESSAGE_ID_MALFORMED");
    return this.#call(
      "deleteMessage",
      { chat_id: canonicalChatId, message_id: messageId },
      signal,
      (result) => {
        if (result !== true) {
          throw new TelegramBotApiError("DELETE_MESSAGE_RESULT_MALFORMED");
        }
        return result;
      },
    );
  }

  close(): Promise<void> {
    this.#closePromise ??= Promise.resolve().then(async () => {
      await this.#closeOwner?.();
    });
    return this.#closePromise;
  }

  async #call<T>(
    method: string,
    payload: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    validateResult: (result: unknown) => T,
    fetch: TelegramFetch = this.#fetch,
  ): Promise<T> {
    if (signal.aborted) {
      throw new TelegramBotApiError("ABORTED");
    }
    let response: Response;
    try {
      response = await fetch(this.#requestUrl(method), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch {
      if (signal.aborted) {
        throw new TelegramBotApiError("ABORTED");
      }
      // Fetch implementations sometimes include the full request URL in their
      // own errors. That URL embeds the bot token, so never propagate it.
      throw new TelegramBotApiError("TELEGRAM_TRANSPORT");
    }

    const envelope = parseEnvelope(await readBoundedBody(response, this.#maxResponseBytes));
    if (envelope.ok === false) {
      throw new TelegramBotApiRejectedError(
        envelope.errorCode,
        envelope.description,
        envelope.parameters,
      );
    }
    if (!response.ok) {
      throw new TelegramBotApiError(`TELEGRAM_HTTP_${String(response.status)}`);
    }
    return validateResult(envelope.result);
  }

  #requestUrl(method: string): URL {
    // `method` is an internal literal, never request-provided text.
    const url = new URL(this.#baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/bot${this.#token}/${method}`;
    return url;
  }

  #fileUrl(filePath: string): URL {
    const url = new URL(this.#baseUrl);
    url.pathname = `/file/bot${this.#token}/${filePath}`;
    return url;
  }

  #recordOwnSend(
    response: Record<string, unknown>,
    chatId: string,
    text: string,
    replyToMessageId: number | undefined,
  ): void {
    const messageId = positiveSafeInteger(response.message_id);
    const responseChat = asRecord(response.chat);
    if (messageId === undefined || telegramId(responseChat?.id) !== chatId) {
      throw new TelegramBotApiError("OWN_SEND_RESPONSE_MALFORMED");
    }
    const cachedChat = this.#ownSends.store.getCachedChat(chatId);
    const chat: ChatInfo = cachedChat ?? {
      chatId,
      requested: chatId,
      kind: typeof responseChat?.type === "string" ? responseChat.type : "unknown",
      ...(typeof responseChat?.title === "string" ? { title: responseChat.title } : {}),
      ...(typeof responseChat?.username === "string" ? { username: responseChat.username } : {}),
    };
    const date = botApiDate(response.date);
    const rawJson = stringifyUpdate(response);
    const message: StoredMessage = {
      chatId,
      messageId,
      ...(date === undefined ? {} : { date }),
      senderId: this.#botId,
      senderName: this.#botUsername,
      text,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      ...(rawJson === undefined ? {} : { rawJson }),
    };
    // A storage failure after a Bot API ACK is deliberately surfaced. The
    // durable worker must fence that unknown-delivery state rather than resend.
    this.#ownSends.store.upsertMessages(chat, [message]);
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Telegram Bot API base URL must be an absolute HTTP URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Telegram Bot API base URL must be a plain HTTP URL.");
  }
  return url;
}

function boundedResponseBytes(value: number | undefined): number {
  const bytes = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 1_024 || bytes > MAX_RESPONSE_BYTES) {
    throw new RangeError("Telegram Bot API response limit is out of range.");
  }
  return bytes;
}

function validateGetUpdates(options: {
  offset?: number;
  timeout: number;
  limit: number;
  allowed_updates: readonly ("message" | "edited_message")[];
}): void {
  if (
    (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) ||
    !Number.isSafeInteger(options.timeout) || options.timeout < 0 || options.timeout > 50 ||
    !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100 ||
    !Array.isArray(options.allowed_updates) ||
    options.allowed_updates.length === 0 ||
    options.allowed_updates.some((item) => item !== "message" && item !== "edited_message")
  ) {
    throw new TelegramBotApiError("GET_UPDATES_OPTIONS_MALFORMED");
  }
}

function validateReplyOptions(options: GrammySendMessageOptions | undefined): void {
  if (options === undefined) {
    return;
  }
  if (
    !options.reply_parameters ||
    !positiveSafeInteger(options.reply_parameters.message_id) ||
    options.reply_parameters.allow_sending_without_reply !== false ||
    (options.link_preview_options !== undefined && options.link_preview_options.is_disabled !== true)
  ) {
    throw new TelegramBotApiError("SEND_MESSAGE_OPTIONS_MALFORMED");
  }
}

function replyMessageId(options: GrammySendMessageOptions | undefined): number | undefined {
  return options?.reply_parameters.message_id;
}

function requireChatId(value: string): string {
  const id = telegramId(value);
  if (id === undefined || id !== value) {
    throw new TelegramBotApiError("CHAT_ID_MALFORMED");
  }
  return id;
}

function requireMessageId(value: number, code: string): void {
  if (positiveSafeInteger(value) === undefined) {
    throw new TelegramBotApiError(code);
  }
}

function requireText(value: string, code: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TelegramBotApiError(code);
  }
}

function validTelegramFileId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function validTelegramFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    /^[A-Za-z0-9._/-]+$/u.test(value) && !value.startsWith("/") &&
    !value.includes("//") && !value.split("/").includes("..");
}

/** Native Rich Message has a byte, rather than classic UTF-16, payload limit. */
function requireRichText(value: string, code: string): void {
  if (!isValidRichText(value)) {
    throw new TelegramBotApiError(code);
  }
}

function isValidRichText(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= TELEGRAM_RICH_TEXT_LIMIT_UTF8;
}

function validateOutgoingMessage(
  value: unknown,
  expectedChatId: string,
  expectedBotId: string,
): Record<string, unknown> {
  const message = requireRecord(value, "SEND_MESSAGE_RESULT_MALFORMED");
  if (
    positiveSafeInteger(message.message_id) === undefined ||
    telegramId(asRecord(message.chat)?.id) !== expectedChatId ||
    telegramId(asRecord(message.from)?.id) !== expectedBotId
  ) {
    throw new TelegramBotApiError("OWN_SEND_IDENTITY_MISMATCH");
  }
  return message;
}

function validateEditResult(
  value: unknown,
  expectedChatId: string,
  expectedMessageId: number,
  expectedBotId: string,
): unknown {
  if (value === true) {
    return value;
  }
  const message = validateOutgoingMessage(value, expectedChatId, expectedBotId);
  if (message.message_id !== expectedMessageId) {
    throw new TelegramBotApiError("EDIT_MESSAGE_RESULT_MALFORMED");
  }
  return message;
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    throw new TelegramBotApiError(code);
  }
  return record;
}

function compact(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

type SuccessEnvelope = {
  ok: true;
  result: unknown;
};

type FailureEnvelope = {
  ok: false;
  errorCode: number;
  description: string;
  parameters?: Record<string, unknown>;
};

function parseEnvelope(body: string): SuccessEnvelope | FailureEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new TelegramBotApiError("TELEGRAM_JSON_MALFORMED");
  }
  const envelope = asRecord(parsed);
  if (!envelope || typeof envelope.ok !== "boolean") {
    throw new TelegramBotApiError("TELEGRAM_ENVELOPE_MALFORMED");
  }
  if (envelope.ok === true) {
    if (!("result" in envelope)) {
      throw new TelegramBotApiError("TELEGRAM_RESULT_MISSING");
    }
    return { ok: true, result: envelope.result };
  }
  const errorCode = envelope.error_code;
  const description = envelope.description;
  if (
    typeof errorCode !== "number" ||
    !Number.isSafeInteger(errorCode) || errorCode < 100 || errorCode > 599 ||
    typeof description !== "string" || description.length > 512
  ) {
    throw new TelegramBotApiError("TELEGRAM_REJECTION_MALFORMED");
  }
  const parameters = asRecord(envelope.parameters);
  return {
    ok: false,
    errorCode,
    description,
    ...(parameters === undefined ? {} : { parameters }),
  };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new TelegramBotApiError("TELEGRAM_RESPONSE_TOO_LARGE");
  }
  if (!response.body) {
    throw new TelegramBotApiError("TELEGRAM_RESPONSE_BODY_MISSING");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        throw new TelegramBotApiError("TELEGRAM_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TelegramBotApiError("TELEGRAM_RESPONSE_ENCODING_MALFORMED");
  }
}
