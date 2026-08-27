import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import {
  CodexSubscriptionAuthStore,
  redactCodexSubscriptionSecrets,
  type CodexSubscriptionAuthSnapshot,
} from "./codex-subscription-auth.js";
import type { ResponsesCreateRequest, ResponsesStreamTransport } from "./contracts.js";

export const CODEX_SUBSCRIPTION_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const MAX_ERROR_BODY_CHARS = 4096;
const MAX_SSE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SSE_PENDING_CHARS = 512 * 1024;
const MAX_SSE_LINE_CHARS = 256 * 1024;
const MAX_SSE_EVENT_CHARS = 512 * 1024;
const MAX_SSE_OUTPUT_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_SSE_OUTPUT_ITEMS = 128;
const MAX_SSE_ANNOTATIONS = 512;

export interface CodexSubscriptionTransportOptions {
  readonly auth: CodexSubscriptionAuthStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly originator?: string;
  readonly userAgent?: string;
  readonly sessionId?: string;
  /** Kept for composition compatibility; caller owns the turn-level timeout. */
  readonly timeoutMs?: number;
}

export class CodexSubscriptionTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSubscriptionTransportError";
  }
}

/**
 * Raw direct Responses transport for a ChatGPT/Codex subscription. It does
 * not start `codex`, connect to app-server, or retain conversation state.
 */
export class CodexSubscriptionResponsesTransport implements ResponsesStreamTransport {
  readonly #auth: CodexSubscriptionAuthStore;
  readonly #fetch: typeof globalThis.fetch;
  readonly #url: string;
  readonly #originator: string;
  readonly #userAgent: string;
  readonly #sessionId: string;

  constructor(options: CodexSubscriptionTransportOptions) {
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#url = normalizeResponsesUrl(options.baseUrl ?? CODEX_SUBSCRIPTION_RESPONSES_URL);
    this.#originator = options.originator ?? "parilka-unified";
    this.#userAgent = options.userAgent ?? "parilka-unified/1.0";
    this.#sessionId = options.sessionId ?? crypto.randomUUID();
  }

  async create(
    request: ResponsesCreateRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<AsyncIterable<ResponseStreamEvent>> {
    const wireRequest = codexSubscriptionRequest(request);
    const body = JSON.stringify(wireRequest);
    let snapshot = await this.#auth.snapshot(options.signal);
    let response = await this.#post(body, snapshot, options.signal);
    if (response.status === 401) {
      // Exactly one refresh/replay protects against a revoked-but-not-yet-expired
      // bearer without turning a bad credential into an unbounded retry loop.
      await discard(response);
      snapshot = await this.#auth.recoverAfterUnauthorized(snapshot.accessToken, options.signal);
      response = await this.#post(body, snapshot, options.signal);
    }
    if (!response.ok) {
      const errorBody = await boundedResponseText(response, MAX_ERROR_BODY_CHARS, options.signal);
      throw new CodexSubscriptionTransportError(
        `Codex subscription Responses HTTP ${response.status}: ${redactCodexSubscriptionSecrets(errorBody, [snapshot.accessToken])}`,
      );
    }
    if (!response.body) throw new CodexSubscriptionTransportError("Codex subscription Responses returned an empty stream.");
    return parseCodexSubscriptionSse(response.body, options.signal, serviceTierFromRequest(wireRequest));
  }

  async #post(body: string, auth: CodexSubscriptionAuthSnapshot, signal: AbortSignal): Promise<Response> {
    try {
      return await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "OpenAI-Beta": "responses=experimental",
          Authorization: `Bearer ${auth.accessToken}`,
          ...(auth.accountId === undefined ? {} : { "ChatGPT-Account-ID": auth.accountId }),
          originator: this.#originator,
          "User-Agent": this.#userAgent,
          "session-id": this.#sessionId,
          "x-client-request-id": this.#sessionId,
        },
        body,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      throw new CodexSubscriptionTransportError(`Codex subscription transport failed: ${redactCodexSubscriptionSecrets(error instanceof Error ? error.message : String(error), [auth.accessToken])}`);
    }
  }
}

/** Fast is a Codex UI label; the direct subscription backend uses priority. */
export function codexSubscriptionRequest(request: ResponsesCreateRequest): Record<string, unknown> {
  // The ChatGPT subscription endpoint rejects Platform-only request caps.
  // The host still enforces both limits across the stateless tool loop and
  // bounds streamed bytes/text plus final publication.
  const {
    max_output_tokens: _unsupportedMaxOutputTokens,
    max_tool_calls: _unsupportedMaxToolCalls,
    ...supported
  } = request;
  return {
    ...supported,
    service_tier: "priority",
  };
}

/**
 * The backend occasionally labels a priority completion as `default`. That is
 * compatible only when the submitted wire request was explicitly priority.
 */
export function normalizeCodexSubscriptionResponseEvent(
  event: Record<string, unknown>,
  requestServiceTier: string | undefined,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...event };
  if (normalized.type === "response.done") normalized.type = "response.completed";
  if (requestServiceTier !== "priority") return normalized;
  if (!isRecord(normalized.response)) return normalized;
  const response = { ...normalized.response };
  if (response.service_tier === "default") {
    // Preserve provider evidence for diagnostics while admitting the known
    // subscription-backend spelling to the fixed priority policy.
    response.codex_subscription_raw_service_tier = "default";
    response.service_tier = "priority";
  }
  normalized.response = response;
  return normalized;
}

export async function* parseCodexSubscriptionSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  requestServiceTier: string | undefined,
): AsyncGenerator<ResponseStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let dataLines: string[] = [];
  let eventChars = 0;
  let totalBytes = 0;
  const outputItems = new Map<string, { readonly index: number; readonly item: Record<string, unknown> }>();
  let nextOutputIndex = 0;
  let outputText = "";
  const textAnnotations: unknown[] = [];
  const appendData = (line: string): void => {
    const data = stripSseData(line);
    eventChars += data.length;
    if (eventChars > MAX_SSE_EVENT_CHARS) throw new CodexSubscriptionTransportError("Codex subscription SSE event exceeded its safe size limit.");
    dataLines.push(data);
  };
  const emit = (): ResponseStreamEvent | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];
    eventChars = 0;
    if (!data || data === "[DONE]") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new CodexSubscriptionTransportError("Codex subscription SSE contained invalid JSON.");
    }
    if (!isRecord(parsed)) throw new CodexSubscriptionTransportError("Codex subscription SSE item was not an object.");
    const normalized = normalizeCodexSubscriptionResponseEvent(parsed, requestServiceTier);
    collectOutput(normalized, outputItems, () => nextOutputIndex++, (text) => {
      if (outputText.length + text.length > MAX_SSE_OUTPUT_TEXT_CHARS) {
        throw new CodexSubscriptionTransportError("Codex subscription streamed text exceeded its safe size limit.");
      }
      outputText += text;
    }, textAnnotations);
    if (normalized.type === "response.completed") {
      normalized.response = synthesizeCompletedResponse(normalized.response, outputItems, outputText, textAnnotations);
    }
    return normalized as unknown as ResponseStreamEvent;
  };
  try {
    for (;;) {
      const next = await readWithAbort(reader, signal);
      if (next.done) {
        pending += decoder.decode();
        if (pending.length > MAX_SSE_PENDING_CHARS) throw new CodexSubscriptionTransportError("Codex subscription SSE pending data exceeded its safe size limit.");
        if (pending) {
          const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
          if (line.length > MAX_SSE_LINE_CHARS) throw new CodexSubscriptionTransportError("Codex subscription SSE line exceeded its safe size limit.");
          if (line.startsWith("data:")) appendData(line);
        }
        const event = emit();
        if (event) yield event;
        return;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_SSE_TOTAL_BYTES) throw new CodexSubscriptionTransportError("Codex subscription SSE stream exceeded its safe size limit.");
      pending += decoder.decode(next.value, { stream: true });
      if (pending.length > MAX_SSE_PENDING_CHARS) throw new CodexSubscriptionTransportError("Codex subscription SSE pending data exceeded its safe size limit.");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        let line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > MAX_SSE_LINE_CHARS) throw new CodexSubscriptionTransportError("Codex subscription SSE line exceeded its safe size limit.");
        if (line === "") {
          const event = emit();
          if (event) yield event;
        } else if (line.startsWith("data:")) {
          appendData(line);
        }
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function normalizeResponsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/u, "");
  return trimmed.endsWith("/responses") ? trimmed : `${trimmed}/responses`;
}

function serviceTierFromRequest(request: Record<string, unknown>): string | undefined {
  return typeof request.service_tier === "string" ? request.service_tier : undefined;
}

function stripSseData(line: string): string {
  const data = line.slice("data:".length);
  return data.startsWith(" ") ? data.slice(1) : data;
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (signal.aborted) {
    await reader.cancel(signal.reason).catch(() => undefined);
    throw abortError(signal);
  }
  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>>((resolveRead, rejectRead) => {
    const onAbort = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
      rejectRead(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => { signal.removeEventListener("abort", onAbort); resolveRead(result); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); rejectRead(error); },
    );
  });
}

function collectOutput(
  event: Record<string, unknown>,
  outputItems: Map<string, { readonly index: number; readonly item: Record<string, unknown> }>,
  nextIndex: () => number,
  appendText: (text: string) => void,
  textAnnotations: unknown[],
): void {
  if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && isRecord(event.item)) {
    const item = event.item;
    const key = typeof item.id === "string" && item.id ? item.id :
      typeof event.output_index === "number" ? `index:${event.output_index}` : `item:${outputItems.size}`;
    const index = typeof event.output_index === "number" && Number.isSafeInteger(event.output_index)
      ? event.output_index
      : outputItems.get(key)?.index ?? nextIndex();
    // A done item carries the complete function arguments/message annotations;
    // it must replace its earlier added placeholder, not duplicate it.
    if (!outputItems.has(key) && outputItems.size >= MAX_SSE_OUTPUT_ITEMS) {
      throw new CodexSubscriptionTransportError("Codex subscription SSE emitted too many output items.");
    }
    outputItems.set(key, { index, item: { ...item } });
  }
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") appendText(event.delta);
  if (event.type === "response.output_text.annotation.added" && event.annotation !== undefined) {
    if (textAnnotations.length >= MAX_SSE_ANNOTATIONS) throw new CodexSubscriptionTransportError("Codex subscription SSE emitted too many text annotations.");
    textAnnotations.push(event.annotation);
  }
}

function synthesizeCompletedResponse(
  rawResponse: unknown,
  outputItems: ReadonlyMap<string, { readonly index: number; readonly item: Record<string, unknown> }>,
  outputText: string,
  textAnnotations: readonly unknown[],
): Record<string, unknown> {
  if (!isRecord(rawResponse)) throw new CodexSubscriptionTransportError("Codex subscription completed event omitted its response.");
  const response = { ...rawResponse };
  const terminalOutput = Array.isArray(response.output) ? response.output : [];
  const collected = [...outputItems.values()].sort((left, right) => left.index - right.index).map(({ item }) => item);
  const output = terminalOutput.length > 0 ? terminalOutput : collected;
  if (outputText && !output.some((item) => isRecord(item) && item.type === "message" && messageHasOutputText(item))) {
    output.push({
      type: "message",
      id: "streamed-output-text",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: outputText, annotations: [...textAnnotations] }],
    });
  }
  response.output = output;
  response.output_text = typeof response.output_text === "string" && response.output_text.length > 0
    ? response.output_text
    : outputText || outputTextFromItems(output);
  return response;
}

function messageHasOutputText(item: Record<string, unknown>): boolean {
  return Array.isArray(item.content) && item.content.some((part) => isRecord(part) && part.type === "output_text");
}

function outputTextFromItems(items: readonly unknown[]): string {
  let text = "";
  for (const item of items) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return text;
}

async function boundedResponseText(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = await readWithAbort(reader, signal);
      if (next.done) return text + decoder.decode();
      const remaining = maximum - bytes;
      if (remaining <= 0) {
        await reader.cancel().catch(() => undefined);
        return `${text}…[truncated]`;
      }
      const accepted = next.value.byteLength > remaining ? next.value.subarray(0, remaining) : next.value;
      text += decoder.decode(accepted, { stream: true });
      bytes += accepted.byteLength;
      if (accepted.byteLength !== next.value.byteLength) {
        await reader.cancel().catch(() => undefined);
        return `${text}${decoder.decode()}…[truncated]`;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
