import { CACHE_TOOL_NAMES, type CacheToolName, type ToolSchema } from "./types.js";

export const TOOL_SCHEMAS: Record<CacheToolName, ToolSchema> = {
  rag_bm25_search: {
    name: "rag_bm25_search",
    description:
      "Гибридный ranked semantic/topical поиск по отдельным местам локально " +
      "закэшированной истории: BM25 + BGE-M3 dense + learned sparse; " +
      "опционально локальный ColBERT rerank top-K. В legacy external_openai " +
      "режиме доступны BM25+dense без sparse и ColBERT. Используй для факта, " +
      "решения или высказывания из прошлой переписки; для точной фразы/имени " +
      "выбирай keyword_search, для связного периода — read_chat_slice, для " +
      "внешней справки этот инструмент не подходит.",
    parameters: {
      type: "object",
      properties: {
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
      required: ["query"],
      additionalProperties: false,
    },
  },
  keyword_search: {
    name: "keyword_search",
    description:
      "Точный лексический поиск слов/фраз/имён только по локально " +
      "закэшированной истории этого чата, без vector/embedding provider и " +
      "без Telegram. Задавай точные слова: стемминга нет, для русского " +
      "префиксный режим покрывает только общий префикс, поэтому предлагай " +
      "варианты формулировок сам. Поддерживает фильтры по отправителю, дням " +
      "Europe/Moscow и message_id, порядки relevance/newest/oldest. Не " +
      "используй для внешней справки.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Слова из искомой переписки. FTS5 unicode61 токенизирует " +
            "пунктуацию и кавычки, поэтому они не сохраняются буквально; " +
            "raw FTS-операторы не исполняются.",
        },
        match: {
          type: "string",
          enum: ["all", "any", "phrase", "prefix"],
          description:
            "all — все слова (по умолчанию), any — любое из слов, " +
            "phrase — точная фраза, prefix — общий префикс каждого слова.",
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
            "Последний день включительно, YYYY-MM-DD Europe/Moscow; " +
            "требует day_from.",
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
            "relevance — по BM25 (по умолчанию), newest/oldest — " +
            "по message_id без рейтинга.",
        },
        include_bot: {
          type: "boolean",
          description:
            "Включить собственные ответы бота. По умолчанию true — собственные " +
            "ходы являются частью диалога, но не независимым подтверждением " +
            "фактов. Передай false, чтобы исключить их явно.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Количество сообщений, по умолчанию 10.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  read_chat_slice: {
    name: "read_chat_slice",
    description:
      "Непрерывный срез только локально закэшированной истории этого чата: " +
      "последние count сообщений (mode=recent) или календарный период " +
      "Europe/Moscow (mode=period). Срез автоматически заканчивается перед " +
      "текущим обращением и устойчив к сообщениям, появившимся после старта " +
      "среза. Одна страница возвращает максимум 300 сообщений: если " +
      "coverage.hasMore=true, продолжай тем же mode, передавая " +
      "coverage.nextCursor, пока hasMore не станет false — так страница за " +
      "страницей добирается весь запрошенный объём без пропусков и " +
      "дубликатов. Используй, когда нужен связный ход переписки, последние " +
      "сообщения или весь день, а не отдельные совпадения.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["recent", "period"],
          description:
            "recent — последние count сообщений; period — дни от day_from " +
            "до day_to включительно.",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
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
            "Только для mode=period: последний день включительно; без " +
            "day_to — один день day_from.",
        },
        cursor: {
          type: "string",
          maxLength: 512,
          description:
            "Непрозрачный nextCursor из предыдущего результата; передавай " +
            "только вместе с тем же mode.",
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  day_digest: {
    name: "day_digest",
    description:
      "Сводка только из локального кэша этого чата за календарный день или " +
      "диапазон дней в часовом поясе Europe/Moscow. Если готовой сводки ещё " +
      "нет (digestState=not_ready), ответ содержит suggestedRead — прочитай " +
      "указанный период через read_chat_slice; digestState=no_messages " +
      "значит, что сообщений за эти дни в кэше нет. Не заменяет внешний поиск.",
    parameters: {
      type: "object",
      properties: {
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
      required: ["day_from"],
      additionalProperties: false,
    },
  },
  thread_context: {
    name: "thread_context",
    description:
      "Сообщения только из локального кэша вокруг конкретного message_id, " +
      "чтобы восстановить ход разговора. Используй после найденной или явно " +
      "указанной реплики, не для внешних вопросов.",
    parameters: {
      type: "object",
      properties: {
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
      required: ["message_id"],
      additionalProperties: false,
    },
  },
};

export const TOOL_SCHEMA_LIST: ToolSchema[] = CACHE_TOOL_NAMES.map(
  (name) => TOOL_SCHEMAS[name],
);

export function allowedKeys(name: CacheToolName): ReadonlySet<string> {
  return new Set(Object.keys(TOOL_SCHEMAS[name].parameters.properties));
}

export function isCacheToolName(name: string): name is CacheToolName {
  return (CACHE_TOOL_NAMES as readonly string[]).includes(name);
}
