import { allowedKeys, isCacheToolName } from "./schemas.js";
import {
  SessionRejectedError,
  assertAllowedTurn,
} from "./session.js";
import type { SourceMessageLedger } from "./source-message.js";
import {
  INVALID_ARGS,
  PROTOCOL_ERROR,
  SESSION_REJECTED,
  type DispatchResult,
  type McpToolCaller,
  type PluginEnv,
} from "./types.js";

export function genericError(message: string): DispatchResult {
  return {
    ok: false,
    text: JSON.stringify({ error: message }),
  };
}

export function successPayload(payload: unknown): DispatchResult {
  return {
    ok: true,
    text: JSON.stringify(payload),
  };
}

export async function dispatchCacheTool(options: {
  name: string;
  args: unknown;
  env: PluginEnv;
  ledger: SourceMessageLedger;
  mcp: McpToolCaller;
  sessionKey?: string;
  runId?: string;
  signal?: AbortSignal;
}): Promise<DispatchResult> {
  if (!isCacheToolName(options.name)) {
    return genericError(INVALID_ARGS);
  }

  const identity =
    options.ledger.remember(options.sessionKey, options.runId) ??
    options.ledger.remember(undefined, undefined);
  if (!identity) {
    return genericError(SESSION_REJECTED);
  }
  try {
    assertAllowedTurn(options.env, identity);
  } catch (error) {
    if (error instanceof SessionRejectedError) {
      return genericError(SESSION_REJECTED);
    }
    throw error;
  }

  if (options.args == null || typeof options.args !== "object" || Array.isArray(options.args)) {
    return genericError(INVALID_ARGS);
  }
  const raw = options.args as Record<string, unknown>;
  const allowed = allowedKeys(options.name);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    return genericError(INVALID_ARGS);
  }

  const injected = {
    ...raw,
    source_message_id: identity.messageId,
  };
  options.ledger.recordToolCall(identity.sessionKey, identity.runId);

  try {
    const payload = await options.mcp.callTool(options.name, injected, options.signal);
    if (payload == null || typeof payload !== "object") {
      return genericError(PROTOCOL_ERROR);
    }
    return successPayload(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return genericError(`${PROTOCOL_ERROR}: ${message.slice(0, 80)}`);
  }
}
