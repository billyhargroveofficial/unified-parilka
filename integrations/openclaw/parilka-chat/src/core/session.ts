import {
  AGENT_ID_ENV,
  CHAT_ID_ENV,
  DEFAULT_AGENT_ID,
  DEFAULT_MCP_HTTP_URL,
  MCP_URL_ENV,
  REQUIRED_CHANNEL,
  WRITE_SENDERS_ENV,
  type PluginEnv,
  type TurnIdentity,
} from "./types.js";

const LOOPBACK_HOST = "127.0.0.1";
const MIN_PORT = 1_024;
const MAX_PORT = 65_535;

export class SessionRejectedError extends Error {
  readonly code = "session_rejected";
  constructor(message = "session rejected") {
    super(message);
    this.name = "SessionRejectedError";
  }
}

export function parseCsvIds(raw: string | undefined): Set<string> {
  if (!raw || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => normalizeSenderId(value))
      .filter((value) => value.length > 0),
  );
}

export function normalizeSenderId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^(?:telegram:|tg:)/iu, "");
}

export function normalizeChatId(raw: string): string {
  return raw.trim().replace(/^telegram:/iu, "");
}

export function loadPluginEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PluginEnv {
  const chatId = normalizeChatId(env[CHAT_ID_ENV] ?? "");
  if (!chatId) {
    throw new SessionRejectedError(`${CHAT_ID_ENV} is required`);
  }
  const agentId = (env[AGENT_ID_ENV] ?? DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
  return {
    chatId,
    agentId,
    writeSenderIds: parseCsvIds(env[WRITE_SENDERS_ENV]),
    mcpUrl: (env[MCP_URL_ENV] ?? DEFAULT_MCP_HTTP_URL).trim() || DEFAULT_MCP_HTTP_URL,
  };
}

export function parseLoopbackMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PARILKA_MCP_HTTP_URL must be a valid URL.");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK_HOST ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !Number.isSafeInteger(port) ||
    port < MIN_PORT ||
    port > MAX_PORT
  ) {
    throw new Error(
      "PARILKA_MCP_HTTP_URL must be an uncredentialed " +
        "http://127.0.0.1:<port>/mcp URL without query or fragment.",
    );
  }
  return url;
}

export function assertAllowedTurn(
  env: PluginEnv,
  turn: Pick<TurnIdentity, "agentId" | "channel" | "chatId">,
): void {
  if (turn.agentId !== env.agentId) {
    throw new SessionRejectedError("agent mismatch");
  }
  if (turn.channel !== REQUIRED_CHANNEL) {
    throw new SessionRejectedError("channel mismatch");
  }
  if (normalizeChatId(turn.chatId) !== env.chatId) {
    throw new SessionRejectedError("chat mismatch");
  }
}

export function isAllowedWriter(env: PluginEnv, senderId: string | undefined): boolean {
  if (!senderId) return false;
  return env.writeSenderIds.has(normalizeSenderId(senderId));
}
