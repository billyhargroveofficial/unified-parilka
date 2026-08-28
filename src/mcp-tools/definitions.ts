import type { ToolDef } from "./contracts.js";
import { BOT_READ_TOOL_DEFINITIONS } from "../bot/read-tools.js";
import type { BotReadToolDefinition } from "../bot/read-tools.js";

export const TOOL_NAMES = [
  "get_config",
  "get_status",
  "resolve_chat",
  "get_chat_info",
  "sync_history",
  "read_history",
  "search_messages",
  "semantic_search_messages",
  "index_embeddings",
  "get_thread_context",
  "preview_message",
  "send_message",
  "reply_to_message",
  "rag_bm25_search",
  "keyword_search",
  "read_chat_slice",
  "day_digest",
  "thread_context",
] as const;

export type TelegramToolName = (typeof TOOL_NAMES)[number];

export function listToolDefinitions(): ToolDef[] {
  return [
    {
      name: "get_config",
      description:
        "Return redacted Telegram Parilka MCP configuration and safety state.",
      inputSchema: objectSchema({}),
    },
    {
      name: "get_status",
      description:
        "Return cache-only service health, sync, daemon, and embedding coverage status.",
      inputSchema: objectSchema({
        chat: stringProp(
          "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
        ),
      }),
    },
    {
      name: "resolve_chat",
      description:
        "Resolve the configured or provided Telegram chat and cache its input peer.",
      inputSchema: objectSchema({
        chat: stringProp(
          "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
        ),
        refresh: boolProp("Force a Telegram peer cache refresh."),
      }),
    },
    {
      name: "get_chat_info",
      description:
        "Resolve chat info plus local cache statistics.",
      inputSchema: objectSchema({
        chat: stringProp(
          "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
        ),
      }),
    },
    {
      name: "sync_history",
      description:
        "Sync Telegram history into local SQLite cache. Use this manually; normally run sync-daemon in the background.",
      inputSchema: objectSchema({
        chat: stringProp(
          "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
        ),
        mode: enumProp(
          ["both", "recent", "backfill"],
          "Sync direction. recent fetches messages above newest cached ID; backfill fetches older messages.",
        ),
        limit: numberProp(
          "Messages to fetch. Max TELEGRAM_MAX_SYNC_LIMIT.",
          1,
          500000,
        ),
        batch_size: numberProp(
          "Telegram page size.",
          1,
          1000,
        ),
        offset_id: numberProp(
          "Start older-than this message ID. 0 means latest.",
          0,
        ),
        commit_cursor: boolProp(
          "Allow an explicit offset_id backfill to advance daemon cursor state.",
        ),
        reset_backfill_exhausted: boolProp(
          "Clear backfill exhausted state and allow backfill to run again.",
        ),
      }),
    },
    {
      name: "read_history",
      description:
        "Read messages from the local SQLite cache.",
      inputSchema: objectSchema({
        chat: stringProp(
          "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
        ),
        limit: numberProp("Messages to return.", 1, 500),
        before_id: numberProp(
          "Only messages older than this message ID.",
          1,
        ),
        after_id: numberProp(
          "Only messages newer than this message ID.",
          1,
        ),
        order: enumProp(
          ["asc", "desc"],
          "Message order.",
        ),
      }),
    },
    {
      name: "search_messages",
      description:
        "Search cached Telegram messages with keyword FTS, vector cosine search, and hybrid candidates.",
      inputSchema: objectSchema(
        {
          chat: stringProp(
            "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
          ),
          query: stringProp("Search query."),
          limit: numberProp(
            "Candidates per search channel.",
            1,
            200,
          ),
          keyword_limit: numberProp(
            "Keyword FTS candidates to return.",
            1,
            200,
          ),
          vector_limit: numberProp(
            "Vector chunks to return.",
            1,
            50,
          ),
          hybrid_limit: numberProp(
            "Hybrid candidates to return.",
            1,
            100,
          ),
          before_id: numberProp(
            "Only messages older than this message ID.",
            1,
          ),
          after_id: numberProp(
            "Only messages newer than this message ID.",
            1,
          ),
        },
        ["query"],
      ),
    },
    {
      name: "semantic_search_messages",
      description:
        "Vector/cosine search over indexed cached Telegram message chunks.",
      inputSchema: objectSchema(
        {
          chat: stringProp(
            "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
          ),
          query: stringProp("Semantic search query."),
          limit: numberProp(
            "Vector chunks to return.",
            1,
            50,
          ),
          before_id: numberProp(
            "Only chunks older than this message ID.",
            1,
          ),
          after_id: numberProp(
            "Only chunks newer than this message ID.",
            1,
          ),
          include_messages: boolProp(
            "Include source messages for each returned chunk.",
          ),
        },
        ["query"],
      ),
    },
    {
      name: "index_embeddings",
      description:
        "Index cached Telegram messages into vector chunks for semantic search.",
      inputSchema: objectSchema({
        chat: stringProp(
          "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
        ),
        limit_chunks: numberProp(
          "Chunks to embed in this run.",
          1,
          5000,
        ),
        after_message_id: numberProp(
          "Start indexing messages after this ID.",
          0,
        ),
        rebuild: boolProp(
          "Delete existing chunks for the configured model/dimensions before indexing.",
        ),
        estimate_only: boolProp(
          "Return privacy/cost estimate without calling the embedding API.",
        ),
        confirm_estimate: boolProp(
          "Confirm the first-run estimate and allow external embedding API calls.",
        ),
      }),
    },
    {
      name: "get_thread_context",
      description:
        "Return cached messages around a message ID.",
      inputSchema: objectSchema(
        {
          chat: stringProp(
            "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
          ),
          message_id: numberProp(
            "Center message ID.",
            1,
          ),
          before: numberProp(
            "Approximate number of message IDs before center.",
            0,
            500,
          ),
          after: numberProp(
            "Approximate number of message IDs after center.",
            0,
            500,
          ),
        },
        ["message_id"],
      ),
    },
    {
      name: "preview_message",
      description:
        "Validate a Telegram send without sending anything and return a short-lived, one-shot payload capability. This is not human approval.",
      inputSchema: objectSchema(
        {
          chat: stringProp(
            "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
          ),
          text: stringProp("Message text."),
          parse_mode: enumProp(
            ["none", "html", "markdown"],
            "Client-side parse mode.",
          ),
          reply_to_message_id: numberProp(
            "Message ID to reply to.",
            1,
          ),
          link_preview: boolProp("Enable link preview."),
          silent: boolProp("Send silently."),
        },
        ["text"],
      ),
    },
    {
      name: "send_message",
      description:
        "Send or dry-run a Telegram message with allowlist, approval, dedupe, and throttling.",
      inputSchema: objectSchema(
        {
          chat: stringProp(
            "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
          ),
          text: stringProp("Message text."),
          parse_mode: enumProp(
            ["none", "html", "markdown"],
            "Client-side parse mode. Default none.",
          ),
          reply_to_message_id: numberProp(
            "Message ID to reply to.",
            1,
          ),
          link_preview: boolProp("Enable link preview."),
          silent: boolProp("Send silently."),
          dry_run: boolProp("Force dry run."),
          approval_id: stringProp(
            "Short-lived one-shot payload capability returned by preview_message; not human approval. Required for live sends unless admin bypass is enabled.",
          ),
          dedupe_key: stringProp(
            "Optional caller-provided idempotency key.",
          ),
        },
        ["text"],
      ),
    },
    {
      name: "reply_to_message",
      description:
        "Convenience wrapper around send_message with required reply_to_message_id.",
      inputSchema: objectSchema(
        {
          chat: stringProp(
            "Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID.",
          ),
          message_id: numberProp(
            "Message ID to reply to.",
            1,
          ),
          text: stringProp("Reply text."),
          parse_mode: enumProp(
            ["none", "html", "markdown"],
            "Client-side parse mode. Default none.",
          ),
          link_preview: boolProp("Enable link preview."),
          silent: boolProp("Send silently."),
          dry_run: boolProp("Force dry run."),
          approval_id: stringProp(
            "Short-lived one-shot payload capability returned by preview_message; not human approval. Required for live sends unless admin bypass is enabled.",
          ),
          dedupe_key: stringProp(
            "Optional caller-provided idempotency key.",
          ),
        },
        ["message_id", "text"],
      ),
    },
    ...cacheOnlyToolDefs(),
  ];
}

/**
 * Clone the model-facing BOT_READ_TOOL_DEFINITIONS for the five cache-only
 * tools and add `source_message_id` as a required positive safe integer.
 * The chat is not model-controlled: it always uses TELEGRAM_DEFAULT_CHAT_ID.
 */
function cacheOnlyToolDefs(): ToolDef[] {
  const names = new Set([
    "rag_bm25_search",
    "keyword_search",
    "read_chat_slice",
    "day_digest",
    "thread_context",
  ]);
  return BOT_READ_TOOL_DEFINITIONS.filter((def) =>
    names.has(def.name),
  ).map((def) => cacheToolDef(def));
}

function cacheToolDef(source: BotReadToolDefinition): ToolDef {
  const schema = structuredClone(
    source.inputSchema,
  ) as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown>;
  properties.source_message_id = {
    type: "integer",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    description:
      "Обязательный служебный ID сообщения-триггера текущего хода, который подставляет trusted bridge (текущий Hermes model-facing plugin скрывает его и подставляет HERMES_SESSION_MESSAGE_ID). Инструмент никогда не возвращает это сообщение или более новые.",
  };
  const required = [
    ...((schema.required as string[] | undefined) ?? []),
    "source_message_id",
  ];
  schema.required = required;
  return {
    name: source.name,
    description: source.description,
    inputSchema: schema,
  };
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

function stringProp(
  description: string,
): Record<string, unknown> {
  return { type: "string", description };
}

function boolProp(
  description: string,
): Record<string, unknown> {
  return { type: "boolean", description };
}

function numberProp(
  description: string,
  minimum?: number,
  maximum?: number,
): Record<string, unknown> {
  return {
    type: "integer",
    description,
    minimum,
    maximum,
  };
}

function enumProp(
  values: string[],
  description: string,
): Record<string, unknown> {
  return {
    type: "string",
    enum: values,
    description,
  };
}
