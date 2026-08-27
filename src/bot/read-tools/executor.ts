import {
  assertTimeZone,
  DEFAULT_TIME_ZONE,
} from "./calendar.js";
import {
  executeDayDigest,
  executeKeywordSearch,
  executeReadChatSlice,
  executeRagBm25Search,
  executeThreadContext,
  type CacheExecutorContext,
} from "./cache-executors.js";
import {
  BOT_READ_TOOL_DEFINITIONS,
  BOT_READ_TOOL_NAMES,
  type BotReadToolCallOptions,
  type BotReadToolDefinition,
  type BotReadToolName,
  type BotReadToolResult,
  type BotReadToolsOptions,
} from "./contracts.js";
import {
  failure,
  normalizeReadToolError,
} from "./payload.js";
import {
  dayDigestArgsSchema,
  keywordSearchArgsSchema,
  ragBm25SearchArgsSchema,
  readChatSliceArgsSchema,
  threadContextArgsSchema,
} from "./schemas.js";

const DEFAULT_CHAT_SEARCH_TIMEOUT_MS = 15_000;
const MAX_CHAT_SEARCH_TIMEOUT_MS = 5 * 60_000;

export class BotReadTools {
  readonly #cacheContext: CacheExecutorContext;

  constructor(options: BotReadToolsOptions) {
    const chatId = requireNonEmpty(options.chatId, "chatId");
    const cache = options.cache;
    const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    assertTimeZone(timeZone);
    const chatSearchTimeoutMs = boundedPositiveInteger(
      options.chatSearchTimeoutMs ?? DEFAULT_CHAT_SEARCH_TIMEOUT_MS,
      MAX_CHAT_SEARCH_TIMEOUT_MS,
      "chatSearchTimeoutMs",
    );
    this.#cacheContext = {
      chatId,
      cache,
      timeZone,
      chatSearchTimeoutMs,
      botSenderId: options.botSenderId,
    };
  }

  listTools(): readonly BotReadToolDefinition[] {
    return BOT_READ_TOOL_DEFINITIONS;
  }

  async callTool(
    name: string,
    rawArgs: unknown,
    options: BotReadToolCallOptions = {},
  ): Promise<BotReadToolResult> {
    if (!isBotReadToolName(name)) {
      return failure(name, {
        code: "unknown_tool",
        retryable: false,
        message: `Unknown read tool: ${name}`,
      });
    }

    try {
      switch (name) {
        case "rag_bm25_search":
          return await executeRagBm25Search(
            this.#cacheContext,
            ragBm25SearchArgsSchema.parse(rawArgs ?? {}),
            options.sourceMessageId,
            options.signal,
          );
        case "keyword_search":
          return executeKeywordSearch(
            this.#cacheContext,
            keywordSearchArgsSchema.parse(rawArgs ?? {}),
            options.sourceMessageId,
          );
        case "read_chat_slice":
          return executeReadChatSlice(
            this.#cacheContext,
            readChatSliceArgsSchema.parse(rawArgs ?? {}),
            options.sourceMessageId,
          );
        case "day_digest":
          return executeDayDigest(
            this.#cacheContext,
            dayDigestArgsSchema.parse(rawArgs ?? {}),
            options.sourceMessageId,
          );
        case "thread_context":
          return executeThreadContext(
            this.#cacheContext,
            threadContextArgsSchema.parse(rawArgs ?? {}),
            options.sourceMessageId,
          );
      }
    } catch (error) {
      return failure(name, normalizeReadToolError(error));
    }
  }
}

function isBotReadToolName(value: string): value is BotReadToolName {
  return (BOT_READ_TOOL_NAMES as readonly string[]).includes(value);
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError(`${name} must not be empty.`);
  }
  return trimmed;
}

function boundedPositiveInteger(
  value: number,
  maximum: number,
  name: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new TypeError(
      `${name} must be an integer from 1 to ${maximum}.`,
    );
  }
  return value;
}
