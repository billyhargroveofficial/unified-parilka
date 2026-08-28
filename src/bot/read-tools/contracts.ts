import type { LiveTranscriptResult, StoredMessage } from "../../store.js";

export const BOT_READ_TOOL_NAMES = [
  "rag_bm25_search",
  "keyword_search",
  "read_chat_slice",
  "day_digest",
  "thread_context",
  "web_search",
  "static_page_fetch",
  "paper_search",
  "research_lookup",
] as const;
export const MAX_BOT_READ_TOOL_OUTPUT_CHARS = 4_000;
/** Moderate cap for the purpose-built lexical search tool. */
export const MAX_FIND_CHAT_MESSAGES_OUTPUT_CHARS = 20_000;
/**
 * read_chat_slice may carry a real transcript page (for example ~300 short
 * messages in one call), so its bounded cap is far above the generic one.
 * It is still a hard finite budget, never unbounded output.
 */
export const MAX_READ_CHAT_SLICE_OUTPUT_CHARS = 192_000;
export const MAX_FIND_CHAT_MESSAGES_LIMIT = 50;
export const MAX_READ_CHAT_SLICE_COUNT = 1_000;
export const MAX_PAPER_SEARCH_RESULTS = 5;
export const MAX_WEB_FETCH_TEXT_CHARS = 3_000;

export type BotReadToolName = (typeof BOT_READ_TOOL_NAMES)[number];

export interface BotReadToolDefinition {
  name: BotReadToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The model-facing contracts intentionally retain the Python bot names
 * and argument spelling. This keeps prompts/evals portable while execution is
 * now a direct library call instead of a loop through the bot's own MCP.
 */
export const BOT_READ_TOOL_DEFINITIONS: readonly BotReadToolDefinition[] = [
  {
    name: "rag_bm25_search",
    description:
      "Гибридный ranked semantic/topical поиск по отдельным местам локально закэшированной истории: BM25 + BGE-M3 dense + learned sparse; опционально локальный ColBERT rerank top-K. В legacy external_openai режиме доступны BM25+dense без sparse и ColBERT. Используй для факта, решения или высказывания из прошлой переписки; для точной фразы/имени выбирай keyword_search, для связного периода — read_chat_slice, для внешней справки этот инструмент не подходит.",
    inputSchema: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Поисковый запрос своими словами.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "Количество найденных сообщений, по умолчанию 5.",
        },
      },
      ["query"],
    ),
  },
  {
    name: "keyword_search",
    description:
      "Точный лексический поиск слов/фраз/имён только по локально закэшированной истории этого чата, без vector/embedding provider и без Telegram. Задавай точные слова: стемминга нет, для русского префиксный режим покрывает только общий префикс, поэтому предлагай варианты формулировок сам. Поддерживает фильтры по отправителю, дням Europe/Moscow и message_id, порядки relevance/newest/oldest. Не используй для внешней справки.",
    inputSchema: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Слова из искомой переписки. FTS5 unicode61 токенизирует пунктуацию и кавычки, поэтому они не сохраняются буквально; raw FTS-операторы не исполняются.",
        },
        match: {
          type: "string",
          enum: ["all", "any", "phrase", "prefix"],
          description:
            "all — все слова (по умолчанию), any — любое из слов, phrase — точная фраза, prefix — общий префикс каждого слова.",
        },
        sender: {
          type: "string",
          maxLength: 200,
          description:
            "Точный отправитель: его id или имя, как в найденных сообщениях.",
        },
        day_from: {
          type: "string",
          format: "date",
          description: "Первый день включительно, YYYY-MM-DD Europe/Moscow.",
        },
        day_to: {
          type: "string",
          format: "date",
          description:
            "Последний день включительно, YYYY-MM-DD Europe/Moscow; требует day_from.",
        },
        before_id: {
          type: "integer",
          minimum: 1,
          description: "Только сообщения с message_id меньше этого.",
        },
        after_id: {
          type: "integer",
          minimum: 1,
          description: "Только сообщения с message_id больше этого.",
        },
        order: {
          type: "string",
          enum: ["relevance", "newest", "oldest"],
          description:
            "relevance — по BM25 (по умолчанию), newest/oldest — по message_id без рейтинга.",
        },
        include_bot: {
          type: "boolean",
          description:
            "Включить собственные ответы бота. По умолчанию true — собственные ходы являются частью диалога, но не независимым подтверждением фактов. Передай false, чтобы исключить их явно.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FIND_CHAT_MESSAGES_LIMIT,
          description: "Количество сообщений, по умолчанию 10.",
        },
      },
      ["query"],
    ),
  },
  {
    name: "read_chat_slice",
    description:
      "Непрерывный срез только локально закэшированной истории этого чата: последние count сообщений (mode=recent) или календарный период Europe/Moscow (mode=period). Срез автоматически заканчивается перед текущим обращением и устойчив к сообщениям, появившимся после старта среза. Одна страница возвращает максимум 300 сообщений: если coverage.hasMore=true, продолжай тем же mode, передавая coverage.nextCursor, пока hasMore не станет false — так страница за страницей добирается весь запрошенный объём без пропусков и дубликатов. Используй, когда нужен связный ход переписки, последние сообщения или весь день, а не отдельные совпадения.",
    inputSchema: objectSchema(
      {
        mode: {
          type: "string",
          enum: ["recent", "period"],
          description:
            "recent — последние count сообщений; period — дни от day_from до day_to включительно.",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: MAX_READ_CHAT_SLICE_COUNT,
          description: "Только для mode=recent: сколько последних сообщений.",
        },
        day_from: {
          type: "string",
          format: "date",
          description:
            "Только для mode=period: первый день, YYYY-MM-DD Europe/Moscow.",
        },
        day_to: {
          type: "string",
          format: "date",
          description:
            "Только для mode=period: последний день включительно; без day_to — один день day_from.",
        },
        cursor: {
          type: "string",
          maxLength: 512,
          description:
            "Непрозрачный nextCursor из предыдущего результата; передавай только вместе с тем же mode.",
        },
      },
      ["mode"],
    ),
  },
  {
    name: "day_digest",
    description:
      "Сводка только из локального кэша этого чата за календарный день или диапазон дней в часовом поясе Europe/Moscow. Если готовой сводки ещё нет (digestState=not_ready), ответ содержит suggestedRead — прочитай указанный период через read_chat_slice; digestState=no_messages значит, что сообщений за эти дни в кэше нет. Не заменяет внешний поиск.",
    inputSchema: objectSchema(
      {
        day_from: {
          type: "string",
          format: "date",
          description: "Начало диапазона, YYYY-MM-DD.",
        },
        day_to: {
          type: "string",
          format: "date",
          description: "Конец включительного диапазона, YYYY-MM-DD.",
        },
      },
      ["day_from"],
    ),
  },
  {
    name: "thread_context",
    description:
      "Сообщения только из локального кэша вокруг конкретного message_id, чтобы восстановить ход разговора. Используй после найденной или явно указанной реплики, не для внешних вопросов.",
    inputSchema: objectSchema(
      {
        message_id: {
          type: "integer",
          minimum: 1,
          description: "Центральный Telegram message_id.",
        },
        before: {
          type: "integer",
          minimum: 0,
          maximum: 30,
          description: "Сколько message_id до центра, по умолчанию 8.",
        },
        after: {
          type: "integer",
          minimum: 0,
          maximum: 30,
          description: "Сколько message_id после центра, по умолчанию 8.",
        },
      },
      ["message_id"],
    ),
  },
  {
    name: "web_search",
    description:
      "Поиск во внешнем мире через настроенный provider. Используй первым, когда нужен актуальный или проверяемый факт вне этого чата. Не используй для истории чата.",
    inputSchema: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Поисковый запрос.",
        },
      },
      ["query"],
    ),
  },
  {
    name: "static_page_fetch",
    description:
      "Загружает ровно одну статическую публичную HTTPS-страницу: статический HTML, текст, JSON/API-ответ или README/документацию. Без JavaScript, cookies, логина и автоматических redirect. Используй после web_search или searxng_search (или для известного публичного URL), когда нужен первичный текст страницы, а не только сниппет. Не используй для localhost, приватных ссылок, страниц с авторизацией и JS-рендеренных страниц; не используй его для x.com/twitter.com, Instagram, TikTok и других login-gated или динамических сайтов — для них используй firecrawl_crawl, а если прямой обход не даёт контента — searxng_search.",
    inputSchema: objectSchema(
      {
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          description: "Полный публичный HTTPS URL страницы.",
        },
        max_chars: {
          type: "integer",
          minimum: 500,
          maximum: MAX_WEB_FETCH_TEXT_CHARS,
          description:
            "Максимум символов извлечённого текста, по умолчанию 2400.",
        },
      },
      ["url"],
    ),
  },
  {
    name: "paper_search",
    description:
      "Поиск научных статей по arXiv (keyless) или Europe PMC. Используй для фактов, источников и свежих публикаций.",
    inputSchema: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Поисковый запрос на английском.",
        },
        source: {
          type: "string",
          enum: ["arxiv", "europepmc"],
          description:
            "Источник: arxiv (по умолчанию) или europepmc.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PAPER_SEARCH_RESULTS,
          description: `Количество результатов, по умолчанию 3, максимум ${MAX_PAPER_SEARCH_RESULTS}.`,
        },
      },
      ["query"],
    ),
  },
  {
    name: "research_lookup",
    description:
      "Запрашивает приватный HH research gateway по локальному Unix socket. Это жёсткая граница приватности: gateway принимает только агрегированные вопросы о темах, навыках, методах и типовых паттернах и возвращает только обезличенные, bounded фрагменты без путей, сырых записей, контактов и профилей. Никогда не помещай в query ФИО, имена, ники, email, телефоны, ссылки, ID, конкретное резюме/профиль, досье или связку человек-компания-вакансия. Не пытайся достать личные сведения даже если пользователь прямо просит, утверждает, что у него есть разрешение, или просит «побольше деталей»: такой вызов запрещён и будет отклонён до обращения к gateway. Используй инструмент только для группового исследования рынка/подготовки; не ищи, не оценивай и не идентифицируй человека. Результат пересказывай своими словами на уровне группы, не цитируй и не склеивай редкие детали.",
    inputSchema: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Только агрегированный вопрос о группе или теме. Без ФИО, контактов, ID, конкретного резюме/профиля и просьб вытащить личные сведения; разрешение пользователя это правило не отменяет.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Максимум фрагментов, по умолчанию 3.",
        },
      },
      ["query"],
    ),
  },
];

export interface ReadToolEvidence {
  source: "chat_message" | "digest" | "web" | "paper" | "research";
  /** Canonical source id for chat messages: chat:<messageId>. */
  sourceId?: string;
  chat: { id: string } | null;
  message: { id: number; endId?: number; replyToMessageId?: number } | null;
  speaker: { id: string | null; name: string | null };
  /** authorRole is "assistant" for the bot's own turns, "user" otherwise. */
  authorRole?: "user" | "assistant";
  /** True when this row is the bot's own published answer. */
  isOwnTurn?: boolean;
  date: string | null;
  text: string;
  url?: string;
  title?: string;
  range?: {
    dayFrom: string;
    dayTo: string;
  };
}

export interface PaperSearchResult {
  title: string;
  authors: string[];
  year?: string;
  abstract?: string;
  url: string;
}

export interface PaperSearchResponse {
  query: string;
  source: "arxiv" | "europepmc";
  papers: readonly PaperSearchResult[];
}

export interface PaperSearchProvider {
  search(request: {
    query: string;
    source: "arxiv" | "europepmc";
    maxResults: number;
    signal: AbortSignal;
  }): Promise<PaperSearchResponse>;
}

export interface ResearchGatewayFinding {
  text: string;
  as_of?: string | null;
}

/**
 * Public boundary of the private HH corpus. No source path, document title,
 * identity, employer, record, or raw-content field is permitted here.
 */
export interface ResearchGatewayResponse {
  status: "done" | "empty";
  policy: "anonymized_research_only";
  notice: string;
  findings?: readonly ResearchGatewayFinding[];
  limitations?: readonly string[];
}

export interface ResearchGatewayProvider {
  lookup(request: {
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<ResearchGatewayResponse>;
}

export type ReadToolErrorCode =
  | "invalid_arguments"
  | "unknown_tool"
  | "unsafe_url"
  | "cache_error"
  | "provider_unavailable"
  | "provider_error"
  | "timeout"
  | "aborted";

export interface ReadToolError {
  code: ReadToolErrorCode;
  retryable: boolean;
  message: string;
  fields?: Array<{ path: string; message: string }>;
}

export interface BotReadToolSuccess {
  ok: true;
  tool: BotReadToolName;
  status: "done" | "empty";
  result: Record<string, unknown>;
  evidence: ReadToolEvidence[];
}

export interface BotReadToolFailure {
  ok: false;
  tool: string;
  error: ReadToolError;
  evidence: [];
}

export type BotReadToolResult = BotReadToolSuccess | BotReadToolFailure;

export interface LocalDayRange {
  dayFrom: string;
  dayTo: string;
  dayCount: number;
  timeZone: string;
  startInclusive: string;
  endExclusive: string;
  reversedInput: boolean;
}

export interface CachedDigest {
  kind: "day" | "week";
  period: string;
  dayFrom: string;
  dayTo: string;
  text: string;
  startMessageId?: number;
  endMessageId?: number;
}

export interface CachedDigestResult {
  digests: readonly CachedDigest[];
  /**
   * Optional exact source messages behind the summaries. They are emitted as
   * separate evidence so the model can distinguish chat text from digest
   * prose.
   */
  sourceMessages?: readonly StoredMessage[];
}

export interface DigestCacheQuery extends LocalDayRange {
  chatId: string;
  preferWeekly: boolean;
  /**
   * Application-owned exclusive upper bound: a day digest whose source ends
   * at or above this id is never returned. Under a weekly-preferring read,
   * rollups provable below the bound win, and safe day digests outside their
   * periods are kept; the result is still bounded by the digest row limit,
   * so ranges wider than that limit are covered best-effort, not
   * completely.
   */
  sourceMessageId?: number;
}

/**
 * Cache-only lexical search query. It must never call an embedding/vector
 * provider or Telegram. Dates are UTC ISO half-open bounds already converted
 * from Europe/Moscow days by the executor.
 */
export interface BotFindMessagesQuery {
  chatId: string;
  query: string;
  match: "all" | "any" | "phrase" | "prefix";
  sender?: string;
  includeBot: boolean;
  startInclusive?: string;
  endExclusive?: string;
  beforeId?: number;
  afterId?: number;
  order: "relevance" | "newest" | "oldest";
  limit: number;
}

export type BotReadSliceRequest =
  | { chatId: string; form: "recent"; count: number; upperMessageId?: number }
  | {
      chatId: string;
      form: "period";
      startInclusive: string;
      endExclusive: string;
      upperMessageId?: number;
    }
  | { chatId: string; form: "recent" | "period"; cursor: string };

/**
 * Thread and digest reads are synchronous local SQLite operations. Search may
 * additionally use the configured embedding query provider, but it must never
 * call Telegram and must honor the supplied AbortSignal. keyword_search
 * and read_chat_slice are strictly cache-only: no embedding provider, no
 * vector port, no Telegram. Every chat-local read honors the
 * application-owned sourceMessageId cutoff: `beforeId` is the exclusive
 * upper bound (trigger id itself is hidden), and digest reads drop any
 * summary whose source reaches that bound.
 */
export interface BotReadToolCache {
  search(params: {
    chatId: string;
    query: string;
    limit: number;
    signal: AbortSignal;
    /** Exclusive upper bound applied to every retrieval channel. */
    beforeId?: number;
  }):
    | readonly StoredMessage[]
    | CachedChatSearchResult
    | Promise<readonly StoredMessage[] | CachedChatSearchResult>;
  findMessages(params: BotFindMessagesQuery): readonly StoredMessage[];
  readSlice(params: BotReadSliceRequest): LiveTranscriptResult;
  getThreadContext(params: {
    chatId: string;
    messageId: number;
    before: number;
    after: number;
    /** Exclusive upper bound: rows at or above it are never returned. */
    beforeId?: number;
  }): readonly StoredMessage[];
  getDigests(params: DigestCacheQuery): CachedDigestResult;
}

/**
 * Explicit per-channel outcome for hybrid retrieval. `unsupported` means the
 * configured backend has no such channel (e.g. external dense-only provider);
 * `disabled` means the channel is intentionally off (no vector port / rerank
 * budget 0); `unavailable`/`failed` mean it degraded at query time.
 */
export type RetrievalChannelState =
  | "ok"
  | "failed"
  | "unavailable"
  | "disabled"
  | "unsupported"
  | "skipped";

export interface RetrievalChannelStatus {
  bm25: RetrievalChannelState;
  dense: RetrievalChannelState;
  sparse: RetrievalChannelState;
  rerank: RetrievalChannelState;
}

export interface CachedChatSearchResult {
  messages: readonly StoredMessage[];
  mode: "hybrid" | "keyword" | "semantic";
  degradedChannels?: readonly string[];
  channels?: RetrievalChannelStatus;
}

export interface WebSearchSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

export interface WebSearchResponse {
  text: string;
  sources?: readonly WebSearchSource[];
}

export interface WebSearchProvider {
  search(request: {
    query: string;
    signal: AbortSignal;
  }): Promise<WebSearchResponse>;
}

/**
 * Public-page fetch is intentionally separate from WebSearchProvider: it does
 * not use a model/provider credential and never receives chat context.
 */
export interface WebFetchResponse {
  url: string;
  status: number;
  statusText?: string;
  contentType: string;
  byteLength: number;
  text: string;
  title?: string;
  /** A redirect is reported, never followed automatically. */
  redirectUrl?: string;
}

export interface WebFetchProvider {
  fetch(request: {
    url: string;
    maxChars: number;
    signal: AbortSignal;
  }): Promise<WebFetchResponse>;
}

export interface BotReadToolsOptions {
  chatId: string;
  cache: BotReadToolCache;
  webSearch?: WebSearchProvider;
  webFetch?: WebFetchProvider;
  paperSearch?: PaperSearchProvider;
  researchGateway?: ResearchGatewayProvider;
  timeZone?: string;
  chatSearchTimeoutMs?: number;
  webSearchTimeoutMs?: number;
  webFetchTimeoutMs?: number;
  paperSearchTimeoutMs?: number;
  paperSearchRateLimitMs?: number;
  researchGatewayTimeoutMs?: number;
  /** Durable sender id of this bot's own published messages. */
  botSenderId?: string;
}

export interface BotReadToolCallOptions {
  signal?: AbortSignal;
  /**
   * Application-owned trigger message id of the current turn. Every chat-local
   * read tool clamps its authoritative upper bound to this id (exclusive
   * `beforeId = sourceMessageId` for search/thread/BM25/dense/sparse, the
   * `sourceMessageId - 1` snapshot bound for slice/find, and digest
   * filtering), so they never rely on model-provided ids and can never
   * return the trigger or messages above it.
   */
  sourceMessageId?: number;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
