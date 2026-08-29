export const CACHE_TOOL_NAMES = [
  "rag_bm25_search",
  "keyword_search",
  "read_chat_slice",
  "day_digest",
  "thread_context",
] as const;

export type CacheToolName = (typeof CACHE_TOOL_NAMES)[number];

export const SESSION_REJECTED = "parilka-chat: session rejected";
export const INVALID_ARGS = "parilka-chat: invalid arguments";
export const PROTOCOL_ERROR = "parilka-chat: protocol error";

export const REQUIRED_CHANNEL = "telegram";
export const DEFAULT_AGENT_ID = "parilka";
export const CHAT_ID_ENV = "PARILKA_TELEGRAM_CHAT_ID";
export const AGENT_ID_ENV = "PARILKA_OPENCLAW_AGENT_ID";
export const WRITE_SENDERS_ENV = "PARILKA_BOT_MEMORY_WRITE_SENDER_IDS";
export const MCP_URL_ENV = "PARILKA_MCP_HTTP_URL";
export const DEFAULT_MCP_HTTP_URL = "http://127.0.0.1:8766/mcp";

export const MAX_SAFE_TELEGRAM_ID = 9_007_199_254_740_991;
export const VISION_MAX_IMAGES = 6;
export const DEFAULT_CONTEXT_WINDOW = 272_000;
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export const WRITE_TOOL_NAMES = new Set([
  "memory",
  "memory_store",
  "memory_write",
  "skill_manage",
  "skills",
]);

export const MANAGED_MEMORY_PREFIX = "[parilka:managed:";
export const MANAGED_SKILL_MARKERS = ["parilka-managed", "parilka-lessons", "parilka-skill-"];

export const VISION_TOOL_NAMES = new Set([
  "image",
  "view_image",
  "vision_analyze",
]);

export interface PluginEnv {
  chatId: string;
  agentId: string;
  writeSenderIds: ReadonlySet<string>;
  mcpUrl: string;
}

export interface TurnIdentity {
  agentId: string;
  channel: string;
  accountId?: string;
  chatId: string;
  senderId?: string;
  messageId: number;
  sessionKey?: string;
  runId?: string;
  botUsername?: string;
}

export interface ToolSchema {
  name: CacheToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

export interface DispatchResult {
  ok: boolean;
  text: string;
}

export interface McpToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface FooterUsage {
  model?: string;
  usedTokens?: number;
  maxTokens?: number;
  toolCalls: number;
  elapsedSeconds: number;
}
