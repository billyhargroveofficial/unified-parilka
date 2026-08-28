import { publicFailure } from "../errors.js";
import { stringify } from "../json.js";
import type { BotReadToolResult } from "../bot/read-tools.js";
import type { ToolContent } from "./contracts.js";

export function jsonTool(payload: unknown): ToolContent {
  return {
    content: [{ type: "text", text: stringify(payload) }],
    ...(isFailedToolPayload(payload) ? { isError: true } : {}),
  };
}

/**
 * MCP envelope for the five cache-only bot-read tools. Boundary failures —
 * a missing/invalid `source_message_id` (rejected by the registry before
 * this point) or invalid tool arguments — keep MCP `isError` via `jsonTool`.
 * Typed operational BotRead failures (`cache_error`, `provider_unavailable`,
 * `provider_error`, `timeout`, `aborted`) are the deliberate
 * exception: they stay a normal successful MCP response carrying the
 * `{ok:false, tool, error:{code…}, evidence:[]}` envelope, so Hermes reads a
 * structured error instead of an opaque protocol error.
 */
export function jsonCacheReadResult(payload: BotReadToolResult): ToolContent {
  if (!payload.ok && isBoundaryFailure(payload)) {
    return jsonTool(payload);
  }
  return {
    content: [{ type: "text", text: stringify(payload) }],
  };
}

function isBoundaryFailure(
  payload: Extract<BotReadToolResult, { ok: false }>,
): boolean {
  return (
    payload.error.code === "invalid_arguments" ||
    payload.error.code === "unknown_tool"
  );
}

export function toolFailure(error: unknown): ToolContent {
  return jsonTool(publicFailure(error));
}

export function throwIfToolAborted(
  signal: AbortSignal | undefined,
): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException(
        "MCP tool request was cancelled.",
        "AbortError",
      );
}

function isFailedToolPayload(
  payload: unknown,
): payload is { ok: false } {
  return (
    payload != null &&
    typeof payload === "object" &&
    "ok" in payload &&
    payload.ok === false
  );
}
