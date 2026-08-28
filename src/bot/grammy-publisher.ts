import type { Api } from "grammy";
import { GrammyError, HttpError } from "grammy";
import {
  splitTelegramText,
  TELEGRAM_TEXT_LIMIT_UTF16,
} from "./telegram-publication.js";
import type {
  BotTurnPublisher,
  TelegramPublishRequest,
  TelegramPublisherResult,
} from "./worker.js";

export interface GrammySendMessageOptions {
  reply_parameters: {
    message_id: number;
    allow_sending_without_reply: false;
  };
  link_preview_options?: { is_disabled: true };
}

export interface GrammyRichMessageOptions {
  reply_parameters: {
    message_id: number;
    allow_sending_without_reply: false;
  };
}

export interface GrammyRichMessagePayload {
  markdown: string;
  skip_entity_detection: true;
}

export interface GrammyRichMessageSendInput {
  chatId: string;
  richMessage: GrammyRichMessagePayload;
  /**
   * Canonical visible plain text. The durable adapter records it as the
   * acknowledged message text because a rich ACK carries `rich_message`,
   * not `text`.
   */
  plainText: string;
  options: GrammyRichMessageOptions;
  signal: AbortSignal;
}

/**
 * The publisher only needs two Bot API operations. Keeping this port narrower
 * than grammY's Api makes delivery behavior straightforward to test.
 */
export interface GrammyBotApiPort {
  sendRichMessage(input: GrammyRichMessageSendInput): Promise<unknown>;
  sendMessage(
    chatId: string,
    text: string,
    options: GrammySendMessageOptions,
    signal: AbortSignal,
  ): Promise<unknown>;
}

type PublisherFailure = Extract<
  TelegramPublisherResult,
  { ok: false }
>["error"];

interface TelegramRejection {
  errorCode: number;
  description?: string;
  retryAfterMs?: number;
}

const MAX_RETRY_AFTER_MS = 15 * 60_000;

const TIMEOUT_CODES = new Set([
  "ABORT_ERR",
  "ERR_ABORTED",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT",
  "UND_ERR_SOCKET",
]);

/**
 * Only a definitive parser-related Bot API 400 before any ACK may open the
 * classic plain fallback, and it may do so exactly once. Timeout, network,
 * aborted signal, malformed ACK, partial delivery and post-ACK failures never
 * trigger a resend.
 */
const RICH_PARSE_REJECTION_PATTERN =
  /can't parse (?:markdown|rich message|entities)|invalid rich message/iu;

/**
 * Publishes one prepared publication. The primary path is a single native
 * `sendRichMessage({ markdown, skip_entity_detection: true })`; the classic
 * `sendMessage` remains only for whole-message plain publications and the
 * one-shot parser-related 400 fallback.
 */
export class GrammyBotTurnPublisher implements BotTurnPublisher {
  readonly #api: GrammyBotApiPort;

  constructor(api: GrammyBotApiPort) {
    this.#api = api;
  }

  async publish(
    request: TelegramPublishRequest,
  ): Promise<TelegramPublisherResult> {
    if (!isValidRequest(request)) {
      return failure(0, {
        kind: "unknown",
        code: "INVALID_PUBLISH_REQUEST",
      });
    }

    if (request.publication.mode === "plain") {
      return this.#publishPlain(
        request,
        request.publication.plainText,
      );
    }
    return this.#publishRich(request);
  }

  async #publishRich(
    request: TelegramPublishRequest,
  ): Promise<TelegramPublisherResult> {
    if (request.publication.mode !== "rich") {
      return failure(0, {
        kind: "unknown",
        code: "INVALID_PUBLISH_REQUEST",
      });
    }
    const { markdown, plainText } = request.publication;
    if (request.signal.aborted) {
      return failure(0, { kind: "timeout", code: "ABORTED" });
    }

    let response: unknown;
    try {
      response = await this.#api.sendRichMessage({
        chatId: request.chatId,
        richMessage: { markdown, skip_entity_detection: true },
        plainText,
        options: richOptions(request.replyToMessageId),
        signal: request.signal,
      });
    } catch (error) {
      if (isRichParseRejection(error)) {
        return this.#publishPlain(request, plainText);
      }
      return classifyThrownFailure(error, request.signal, 0);
    }

    const rejection = readTelegramRejection(response);
    if (rejection) {
      if (isRichParseRejectionCode(
        rejection.errorCode,
        rejection.description,
      )) {
        return this.#publishPlain(request, plainText);
      }
      return classifyTelegramRejection(rejection, 0);
    }

    const messageId = readMessageId(response);
    if (messageId === undefined) {
      return ambiguousOrPartialFailure(0, {
        kind: "unknown",
        code: "MALFORMED_SUCCESS_RESPONSE",
      });
    }

    return { ok: true, chunksSent: 1, telegramMessageId: messageId };
  }

  async #publishPlain(
    request: TelegramPublishRequest,
    plainText: string,
  ): Promise<TelegramPublisherResult> {
    const chunks = splitTelegramText(
      plainText,
      request.publication.maxChunkUtf16,
    );
    const baseOptions: GrammySendMessageOptions = {
      reply_parameters: {
        message_id: request.replyToMessageId,
        allow_sending_without_reply: false,
      },
      link_preview_options: { is_disabled: true },
    };

    let chunksSent = 0;
    let firstMessageId: number | undefined;

    for (const chunk of chunks) {
      if (request.signal.aborted) {
        return ambiguousOrPartialFailure(chunksSent, {
          kind: "timeout",
          code: "ABORTED",
        });
      }

      let response: unknown;
      try {
        response = await this.#api.sendMessage(
          request.chatId,
          chunk,
          baseOptions,
          request.signal,
        );
      } catch (error) {
        return classifyThrownFailure(error, request.signal, chunksSent);
      }

      const rejection = readTelegramRejection(response);
      if (rejection) {
        return classifyTelegramRejection(rejection, chunksSent);
      }

      const messageId = readMessageId(response);
      if (messageId === undefined) {
        return ambiguousOrPartialFailure(chunksSent, {
          kind: "unknown",
          code: "MALFORMED_SUCCESS_RESPONSE",
        });
      }

      chunksSent += 1;
      firstMessageId ??= messageId;
    }

    return {
      ok: true,
      chunksSent,
      ...(firstMessageId === undefined
        ? {}
        : { telegramMessageId: firstMessageId }),
    };
  }
}

/**
 * Adapts a real grammY Api without exposing the rest of it to the publisher.
 */
export function createGrammyBotTurnPublisher(
  api: Pick<Api, "sendRichMessage" | "sendMessage">,
): GrammyBotTurnPublisher {
  return new GrammyBotTurnPublisher({
    sendRichMessage: (input) =>
      api.sendRichMessage(
        input.chatId,
        input.richMessage as unknown as Parameters<Api["sendRichMessage"]>[1],
        input.options as unknown as Parameters<Api["sendRichMessage"]>[2],
        // grammY 1.45 declares the fourth argument with abort-controller's
        // structural shim, while Node exposes the native, runtime-compatible
        // signal used by the worker.
        input.signal as unknown as Parameters<Api["sendRichMessage"]>[3],
      ),
    sendMessage: (chatId, text, options, signal) =>
      api.sendMessage(
        chatId,
        text,
        options as unknown as Parameters<Api["sendMessage"]>[2],
        signal as unknown as Parameters<Api["sendMessage"]>[3],
      ),
  });
}

function richOptions(replyToMessageId: number): GrammyRichMessageOptions {
  return {
    reply_parameters: {
      message_id: replyToMessageId,
      allow_sending_without_reply: false,
    },
  };
}

function classifyThrownFailure(
  error: unknown,
  signal: AbortSignal,
  chunksSent: number,
): TelegramPublisherResult {
  if (error instanceof HttpError) {
    return ambiguousOrPartialFailure(
      chunksSent,
      classifyTransportFailure(error.error, signal, true),
    );
  }

  const rejection =
    error instanceof GrammyError
      ? {
          errorCode: error.error_code,
          ...retryAfterFromParameters(error.parameters),
        }
      : readTelegramRejection(error);
  if (rejection) {
    return classifyTelegramRejection(rejection, chunksSent);
  }

  return ambiguousOrPartialFailure(
    chunksSent,
    classifyTransportFailure(error, signal, false),
  );
}

function classifyTelegramRejection(
  rejection: TelegramRejection,
  chunksSent: number,
): TelegramPublisherResult {
  if (chunksSent > 0) {
    return partialFailure(chunksSent);
  }

  const errorCode = rejection.errorCode;
  const hasSafeCode =
    Number.isSafeInteger(errorCode) &&
    errorCode >= 100 &&
    errorCode <= 599;
  return failure(0, {
    kind: "telegram_rejected",
    code: hasSafeCode
      ? `TELEGRAM_${String(errorCode)}`
      : "TELEGRAM_REJECTED",
    retryable:
      errorCode === 429 || (errorCode >= 500 && errorCode <= 599),
    ...(
      rejection.retryAfterMs == null
        ? {}
        : { retryAfterMs: rejection.retryAfterMs }
    ),
  });
}

function classifyTransportFailure(
  error: unknown,
  signal: AbortSignal,
  fromHttpError: boolean,
): PublisherFailure {
  if (signal.aborted) {
    return { kind: "timeout", code: "ABORTED" };
  }

  const marker = readErrorMarker(error);
  if (
    marker.name === "AbortError" ||
    marker.name === "TimeoutError" ||
    (marker.code !== undefined && TIMEOUT_CODES.has(marker.code))
  ) {
    return {
      kind: "timeout",
      code: marker.code && TIMEOUT_CODES.has(marker.code)
        ? marker.code
        : marker.name === "AbortError"
          ? "ABORTED"
          : "TIMEOUT",
    };
  }

  if (marker.code !== undefined && NETWORK_CODES.has(marker.code)) {
    return { kind: "network", code: marker.code };
  }

  if (fromHttpError) {
    return { kind: "network", code: "HTTP_ERROR" };
  }

  return { kind: "unknown", code: "UNKNOWN_ERROR" };
}

function ambiguousOrPartialFailure(
  chunksSent: number,
  error: PublisherFailure,
): TelegramPublisherResult {
  return chunksSent > 0 ? partialFailure(chunksSent) : failure(0, error);
}

function partialFailure(chunksSent: number): TelegramPublisherResult {
  return failure(chunksSent, {
    kind: "unknown",
    code: "PARTIAL_DELIVERY",
  });
}

function failure(
  chunksSent: number,
  error: PublisherFailure,
): TelegramPublisherResult {
  return { ok: false, chunksSent, error };
}

function readTelegramRejection(value: unknown): TelegramRejection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  try {
    return value.ok === false &&
        typeof value.description === "string" &&
        typeof value.error_code === "number" &&
        Number.isSafeInteger(value.error_code)
      ? {
          errorCode: value.error_code,
          description: value.description,
          ...retryAfterFromParameters(value.parameters),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function isRichParseRejection(error: unknown): boolean {
  if (!(error instanceof GrammyError)) {
    return false;
  }
  return isRichParseRejectionCode(
    error.error_code,
    error.description,
  );
}

function isRichParseRejectionCode(
  errorCode: number,
  description: string | undefined,
): boolean {
  return (
    errorCode === 400 &&
    typeof description === "string" &&
    RICH_PARSE_REJECTION_PATTERN.test(description)
  );
}

function retryAfterFromParameters(
  value: unknown,
): { retryAfterMs?: number } {
  if (!isRecord(value)) {
    return {};
  }
  try {
    const seconds = value.retry_after;
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      return {};
    }
    return {
      retryAfterMs: Math.min(
        Math.ceil(seconds * 1_000),
        MAX_RETRY_AFTER_MS,
      ),
    };
  } catch {
    return {};
  }
}

function readMessageId(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  try {
    const messageId = value.message_id;
    return typeof messageId === "number" &&
        Number.isSafeInteger(messageId) &&
        messageId > 0
      ? messageId
      : undefined;
  } catch {
    return undefined;
  }
}

function readErrorMarker(value: unknown): {
  name?: string;
  code?: string;
} {
  if (!isRecord(value)) {
    return {};
  }

  try {
    const name =
      typeof value.name === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(value.name)
        ? value.name
        : undefined;
    const code =
      typeof value.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(value.code)
        ? value.code
        : undefined;
    return {
      ...(name === undefined ? {} : { name }),
      ...(code === undefined ? {} : { code }),
    };
  } catch {
    return {};
  }
}

function isValidRequest(request: TelegramPublishRequest): boolean {
  return (
    request.chatId.trim().length > 0 &&
    Number.isSafeInteger(request.replyToMessageId) &&
    request.replyToMessageId > 0 &&
    isPublication(request.publication) &&
    request.signal != null &&
    typeof request.signal.aborted === "boolean"
  );
}

function isPublication(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const publication = value as {
    mode?: unknown;
    markdown?: unknown;
    plainText?: unknown;
    maxChunkUtf16?: unknown;
  };
  const hasValidChunkLimit =
    Number.isSafeInteger(publication.maxChunkUtf16) &&
    (publication.maxChunkUtf16 as number) >= 2 &&
    (publication.maxChunkUtf16 as number) <= TELEGRAM_TEXT_LIMIT_UTF16;
  if (publication.mode === "plain") {
    return (
      typeof publication.plainText === "string" &&
      publication.plainText.length > 0 &&
      hasValidChunkLimit
    );
  }
  if (publication.mode === "rich") {
    return (
      typeof publication.markdown === "string" &&
      publication.markdown.length > 0 &&
      typeof publication.plainText === "string" &&
      publication.plainText.length > 0 &&
      hasValidChunkLimit
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
