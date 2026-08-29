import { z } from "zod";
import { ok, ToolError } from "../errors.js";
import {
  emptySchema,
  type TelegramToolContext,
  type ToolCallOptions,
  type ToolContent,
} from "./contracts.js";
import {
  getThreadContext,
  indexEmbeddings,
  readHistory,
  searchMessages,
  semanticSearchMessages,
} from "./read-handlers.js";
import {
  jsonCacheReadResult,
  jsonTool,
  throwIfToolAborted,
  toolFailure,
} from "./response.js";
import {
  previewMessage,
  replyToMessage,
  sendMessage,
} from "./send-handlers.js";
import {
  getChatInfo,
  getStatus,
  resolveChat,
  safeConfig,
  syncHistory,
} from "./sync-health-handlers.js";

/**
 * Explicit dispatch for the fixed 18-tool MCP surface.
 *
 * This is deliberately a switch rather than a generic plugin registry:
 * adding a tool requires an intentional definition and handler branch.
 */
export async function callTelegramTool(
  context: TelegramToolContext,
  name: string,
  rawArgs: unknown,
  options: ToolCallOptions = {},
): Promise<ToolContent> {
  try {
    throwIfToolAborted(options.signal);
    switch (name) {
      case "get_config":
        emptySchema.parse(rawArgs ?? {});
        return jsonTool(ok({ config: safeConfig(context) }));
      case "get_status":
        return jsonTool(getStatus(context, rawArgs));
      case "resolve_chat":
        return jsonTool(
          await resolveChat(context, rawArgs, options.signal),
        );
      case "get_chat_info":
        return jsonTool(
          await getChatInfo(context, rawArgs, options.signal),
        );
      case "sync_history":
        return jsonTool(
          await syncHistory(
            context,
            rawArgs,
            options.signal,
          ),
        );
      case "read_history":
        return jsonTool(
          await readHistory(context, rawArgs),
        );
      case "search_messages":
        return jsonTool(
          await searchMessages(
            context,
            rawArgs,
            options.signal,
          ),
        );
      case "semantic_search_messages":
        return jsonTool(
          await semanticSearchMessages(
            context,
            rawArgs,
            options.signal,
          ),
        );
      case "index_embeddings":
        return jsonTool(
          await indexEmbeddings(
            context,
            rawArgs,
            options.signal,
          ),
        );
      case "get_thread_context":
        return jsonTool(
          await getThreadContext(context, rawArgs),
        );
      case "preview_message":
        return jsonTool(
          await previewMessage(context, rawArgs, options.signal),
        );
      case "send_message":
        return jsonTool(
          await sendMessage(context, rawArgs, options.signal),
        );
      case "reply_to_message":
        return jsonTool(
          await replyToMessage(context, rawArgs, options.signal),
        );
      case "rag_bm25_search":
      case "keyword_search":
      case "read_chat_slice":
      case "day_digest":
      case "thread_context":
        return await cacheReadTool(
          context,
          name as typeof CACHE_READ_TOOLS[number],
          rawArgs,
          options.signal,
        );
      default:
        throw new ToolError({
          category: "internal",
          retryable: false,
          message: `Unknown tool: ${name}`,
        });
    }
  } catch (error) {
    return toolFailure(error);
  }
}

const CACHE_READ_TOOLS = [
  "rag_bm25_search",
  "keyword_search",
  "read_chat_slice",
  "day_digest",
  "thread_context",
] as const;

const sourceMessageIdSchema = z
  .object({
    source_message_id: z.number().int().positive().safe(),
  })
  .passthrough();

/**
 * Extract and remove the application-owned source_message_id from raw
 * arguments, then delegate to BotReadTools. The sourceMessageId is the
 * exclusive upper bound for every cache-local read: the tool can never
 * return the trigger message or anything above it.
 *
 * Error contract: a missing/invalid source_message_id fails here and
 * surfaces as an MCP protocol error, and invalid tool arguments keep MCP
 * isError. Typed operational BotRead failures pass through jsonCacheReadResult
 * as a normal MCP response with the structured {ok:false, error:{code…}}
 * envelope so the trusted plugin can act on the code instead of an opaque error.
 */
async function cacheReadTool(
  context: TelegramToolContext,
  name: string,
  rawArgs: unknown,
  signal: AbortSignal | undefined,
): Promise<ToolContent> {
  const args = rawArgs != null && typeof rawArgs === "object"
    ? { ...(rawArgs as Record<string, unknown>) }
    : {};
  const parsed = sourceMessageIdSchema.parse(args);
  const sourceMessageId = parsed.source_message_id;
  delete args.source_message_id;
  const result = await context.botReadTools.callTool(
    name,
    args,
    { sourceMessageId, signal },
  );
  return jsonCacheReadResult(result);
}
