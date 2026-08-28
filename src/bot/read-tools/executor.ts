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
  type PaperSearchProvider,
  type ResearchGatewayProvider,
  type WebFetchProvider,
  type WebSearchProvider,
} from "./contracts.js";
import {
  failure,
  normalizeReadToolError,
} from "./payload.js";
import {
  executePaperSearch,
  DEFAULT_PAPER_RATE_LIMIT_MS,
  DEFAULT_PAPER_TIMEOUT_MS,
} from "./paper-executor.js";
import { executeResearchLookup } from "./research-executor.js";
import {
  dayDigestArgsSchema,
  keywordSearchArgsSchema,
  paperSearchArgsSchema,
  ragBm25SearchArgsSchema,
  readChatSliceArgsSchema,
  researchLookupArgsSchema,
  threadContextArgsSchema,
  webFetchArgsSchema,
  webSearchArgsSchema,
} from "./schemas.js";
import {
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  executeWebFetch,
  PublicWebFetchProvider,
} from "./web-fetch-executor.js";
import { executeWebSearch } from "./web-executor.js";

const DEFAULT_CHAT_SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_WEB_TIMEOUT_MS = 60_000;
const MAX_WEB_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RESEARCH_GATEWAY_TIMEOUT_MS = 20_000;

export class BotReadTools {
  readonly #cacheContext: CacheExecutorContext;
  readonly #webSearch: WebSearchProvider | undefined;
  readonly #webFetch: WebFetchProvider;
  readonly #paperSearch: PaperSearchProvider | undefined;
  readonly #researchGateway: ResearchGatewayProvider | undefined;
  readonly #webSearchTimeoutMs: number;
  readonly #webFetchTimeoutMs: number;
  readonly #paperSearchTimeoutMs: number;
  readonly #paperSearchRateLimitMs: number;
  readonly #researchGatewayTimeoutMs: number;

  constructor(options: BotReadToolsOptions) {
    const chatId = requireNonEmpty(options.chatId, "chatId");
    const cache = options.cache;
    this.#webSearch = options.webSearch;
    this.#webFetch = options.webFetch ?? new PublicWebFetchProvider();
    this.#paperSearch = options.paperSearch;
    this.#researchGateway = options.researchGateway;
    const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    assertTimeZone(timeZone);
    const chatSearchTimeoutMs = boundedPositiveInteger(
      options.chatSearchTimeoutMs ?? DEFAULT_CHAT_SEARCH_TIMEOUT_MS,
      MAX_WEB_TIMEOUT_MS,
      "chatSearchTimeoutMs",
    );
    this.#webSearchTimeoutMs = boundedPositiveInteger(
      options.webSearchTimeoutMs ?? DEFAULT_WEB_TIMEOUT_MS,
      MAX_WEB_TIMEOUT_MS,
      "webSearchTimeoutMs",
    );
    this.#webFetchTimeoutMs = boundedPositiveInteger(
      options.webFetchTimeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS,
      MAX_WEB_TIMEOUT_MS,
      "webFetchTimeoutMs",
    );
    this.#paperSearchTimeoutMs = boundedPositiveInteger(
      options.paperSearchTimeoutMs ?? DEFAULT_PAPER_TIMEOUT_MS,
      MAX_WEB_TIMEOUT_MS,
      "paperSearchTimeoutMs",
    );
    this.#paperSearchRateLimitMs = boundedPositiveInteger(
      options.paperSearchRateLimitMs ?? DEFAULT_PAPER_RATE_LIMIT_MS,
      60_000,
      "paperSearchRateLimitMs",
    );
    this.#researchGatewayTimeoutMs = boundedPositiveInteger(
      options.researchGatewayTimeoutMs ?? DEFAULT_RESEARCH_GATEWAY_TIMEOUT_MS,
      MAX_WEB_TIMEOUT_MS,
      "researchGatewayTimeoutMs",
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
        case "web_search":
          return await executeWebSearch(
            this.#webSearch,
            webSearchArgsSchema.parse(rawArgs ?? {}),
            this.#webSearchTimeoutMs,
            options.signal,
          );
        case "static_page_fetch":
          return await executeWebFetch(
            this.#webFetch,
            webFetchArgsSchema.parse(rawArgs ?? {}),
            this.#webFetchTimeoutMs,
            options.signal,
          );
        case "paper_search":
          return await executePaperSearch(
            this.#paperSearch,
            paperSearchArgsSchema.parse(rawArgs ?? {}),
            this.#paperSearchTimeoutMs,
            this.#paperSearchRateLimitMs,
            options.signal,
          );
        case "research_lookup":
          return await executeResearchLookup(
            this.#researchGateway,
            researchLookupArgsSchema.parse(rawArgs ?? {}),
            this.#researchGatewayTimeoutMs,
            options.signal,
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
