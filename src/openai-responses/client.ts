import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  OPENAI_RESPONSES_MODEL,
  OPENAI_RESPONSES_PROMPT_CACHE_KEY,
  OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER,
  OPENAI_WEB_SEARCH_TOOL,
  type EffectiveResponsesServiceTier,
  type LocalFunctionCall,
  type ResponsesCitation,
  type ResponsesCreateRequest,
  type ResponsesProgressEvent,
  type ResponsesStreamTransport,
  type ResponsesUsage,
  type ResponsesWebAction,
  type ResponsesWebProgressInput,
  type RunResponsesTurnRequest,
  type RunResponsesTurnResult,
  ResponsesTurnCancelledError,
  ResponsesTurnError,
  ResponsesTurnTimeoutError,
} from "./contracts.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_FUNCTION_CALLS = 8;
const MAX_FUNCTION_CALLS = 16;
const MAX_FUNCTION_RESULT_CHARS = 200_000;
/** Bound all local-function continuations within one Telegram turn. */
const MAX_TOTAL_FUNCTION_OUTPUT_CHARS = 96_000;
/** Never leak or partially truncate an over-budget host result into a model leg. */
const FUNCTION_OUTPUT_BUDGET_ERROR = "Local function output omitted: Responses turn output budget exhausted.";
const MAX_INPUT_TEXT_CHARS = 64_000;
const MAX_INSTRUCTIONS_CHARS = 32_000;
const MAX_IMAGE_DATA_URL_CHARS = 16 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 128_000;

/**
 * One logical Telegram turn over the stateless Codex subscription Responses
 * wire. Durable storage owns cross-turn continuity. Within a turn, each local
 * function continuation replays the original input plus every preceding model
 * output and function result; it never relies on a stored response id.
 */
export class OpenAiResponsesTurnClient {
  readonly #transport: ResponsesStreamTransport;

  constructor(transport: ResponsesStreamTransport) {
    this.#transport = transport;
  }

  async run(request: RunResponsesTurnRequest): Promise<RunResponsesTurnResult> {
    assertPlainText(request.text, "text", MAX_INPUT_TEXT_CHARS);
    assertPlainText(request.instructions, "instructions", MAX_INSTRUCTIONS_CHARS);
    assertFunctionSchemas(request.localFunctions);
    assertTextJsonSchema(request.textJsonSchema);
    assertHostedWebPolicy(request);
    const timeoutMs = boundedTimeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxFunctionCalls = boundedFunctionCalls(request.maxFunctionCalls ?? DEFAULT_MAX_FUNCTION_CALLS);
    const timeout = new AbortController();
    const signal = joinSignals(request.signal, timeout.signal);
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    let input = userInput(request.text, request.image);
    let firstLeg = true;
    let functionCalls = 0;
    const hostedWebCallIds = new Set<string>();
    let functionOutputChars = 0;
    try {
      for (;;) {
        const leg = await this.#runLeg({
          request,
          input,
          firstLeg,
          signal,
          maxFunctionCalls,
        });
        const functions = functionCallsFrom(leg.response.output);
        for (const callId of leg.hostedWebCallIds) hostedWebCallIds.add(callId);
        if (functions.length === 0) {
          const text = leg.response.output_text;
          if (text.length === 0) throw new ResponsesTurnError("Responses completed without final text.");
          return {
            responseId: leg.response.id,
            model: leg.model,
            text,
            annotations: citationsFrom(leg.response),
            functionCalls,
            completed: true,
            finishStatus: "completed",
            ...(usageFrom(leg.response) === undefined ? {} : { usage: usageFrom(leg.response) }),
            serviceTier: leg.serviceTier,
            hostedWebCalls: hostedWebCallIds.size,
          };
        }
        const callsAlreadyDispatched = functionCalls;
        functionCalls += functions.length;
        if (functionCalls > maxFunctionCalls) {
          throw new ResponsesTurnError(`Responses exceeded its ${maxFunctionCalls} local function-call limit.`);
        }
        const dispatched = await this.#dispatchFunctions(
          functions,
          request,
          signal,
          MAX_TOTAL_FUNCTION_OUTPUT_CHARS - functionOutputChars,
          maxFunctionCalls - callsAlreadyDispatched,
        );
        // The subscription wire is deliberately `store: false`: replay the
        // complete turn transcript rather than passing `previous_response_id`.
        // Response output is retained verbatim, including encrypted reasoning
        // obtained through `include`, so later legs preserve tool context.
        input = [...input, ...responseOutputInput(leg.response.output), ...dispatched.input];
        functionOutputChars += dispatched.outputChars;
        firstLeg = false;
      }
    } catch (error) {
      if (timeout.signal.aborted) throw new ResponsesTurnTimeoutError(timeoutMs);
      if (request.signal?.aborted) throw new ResponsesTurnCancelledError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #runLeg(options: {
    request: RunResponsesTurnRequest;
    input: readonly Record<string, unknown>[];
    firstLeg: boolean;
    signal: AbortSignal;
    maxFunctionCalls: number;
  }): Promise<{
    response: Response;
    model: typeof OPENAI_RESPONSES_MODEL;
    serviceTier: EffectiveResponsesServiceTier;
    hostedWebCallIds: readonly string[];
  }> {
    const thinkingCallId = `thinking:${crypto.randomUUID()}`;
    // This is deliberately before the awaited HTTP create: Telegram gets an
    // immediate status even while the upstream connection is being established.
    await progress(options.request, { type: "thinking_started", callId: thinkingCallId });
    let thinking = true;
    const activeWebSearches = new Set<string>();
    const startedWebSearches = new Set<string>();
    const completedWebSearches = new Set<string>();
    const announcedWebDetails = new Map<string, string>();
    const completeThinking = async (ok: boolean): Promise<void> => {
      if (!thinking) return;
      thinking = false;
      await progress(options.request, { type: "thinking_completed", callId: thinkingCallId, ok });
    };
    const startWebSearch = async (
      callId: string,
      action?: ResponsesWebAction,
      input?: ResponsesWebProgressInput,
      completedOk = true,
    ): Promise<void> => {
      const announced = webProgressFingerprint(action ?? "search", input);
      if (completedWebSearches.has(callId)) {
        // On the subscription wire the granular `completed` event arrives
        // before `output_item.done`, which is the first event carrying action
        // metadata. Re-label the already completed presentation item once so
        // native open_page/find_in_page never masquerade as generic search.
        if (action !== undefined && announcedWebDetails.get(callId) !== announced) {
          announcedWebDetails.set(callId, announced);
          await progress(options.request, {
            type: "hosted_web_action", callId, action,
            ...(input === undefined ? {} : { input }),
          });
          await progress(options.request, {
            type: "hosted_web_completed", callId, ok: completedOk,
          });
        }
        return;
      }
      const wasStarted = startedWebSearches.has(callId);
      if (!wasStarted) {
        startedWebSearches.add(callId);
        activeWebSearches.add(callId);
        await progress(options.request, {
          type: "hosted_web_started", callId,
          ...(action === undefined ? {} : { action }),
          ...(input === undefined ? {} : { input }),
        });
        // Missing early metadata is presented as search by the Telegram
        // projection, so remember that same fallback for late-action dedupe.
        announcedWebDetails.set(callId, announced);
      }
      if (wasStarted && action !== undefined && announcedWebDetails.get(callId) !== announced) {
        announcedWebDetails.set(callId, announced);
        if (startedWebSearches.has(callId)) {
          await progress(options.request, {
            type: "hosted_web_action", callId, action,
            ...(input === undefined ? {} : { input }),
          });
        }
      }
    };
    const completeWebSearch = async (callId: string, ok: boolean): Promise<void> => {
      if (completedWebSearches.has(callId)) return;
      await startWebSearch(callId);
      activeWebSearches.delete(callId);
      completedWebSearches.add(callId);
      await progress(options.request, { type: "hosted_web_completed", callId, ok });
    };
    let iterator: AsyncIterator<ResponseStreamEvent> | undefined;
    try {
      const stream = await this.#transport.create(
        createRequest(
          options.request,
          options.input,
          options.firstLeg,
          options.maxFunctionCalls,
        ),
        { signal: options.signal },
      );
      let completed: Response | undefined;
      let completedAdmission: {
        model: typeof OPENAI_RESPONSES_MODEL;
        serviceTier: EffectiveResponsesServiceTier;
      } | undefined;
      iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await nextWithAbort(iterator, options.signal);
        if (next.done) break;
        const event = next.value;
        if (event.type === "response.web_search_call.in_progress" || event.type === "response.web_search_call.searching") {
          await completeThinking(true);
          await startWebSearch(event.item_id);
        } else if (event.type === "response.web_search_call.completed") {
          await completeWebSearch(event.item_id, true);
        } else if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
          const web = webSearchItem(event.item);
          if (web !== undefined) {
            await completeThinking(true);
            await startWebSearch(web.callId, web.action, web.input, web.ok);
            if (event.type === "response.output_item.done") {
              await completeWebSearch(web.callId, web.ok);
            }
          }
        } else if (event.type === "response.completed") {
          // A `response.completed` event is not sufficient admission by itself:
          // reject a substituted model or a degraded effective tier before any
          // response from this leg can seed a local-function continuation.
          completedAdmission = assertCompletedResponseAdmission(event.response);
          if (options.firstLeg && options.request.hostedWebSearchPolicy === "required_first_leg" &&
            !hasHostedWebSearchCall(event.response.output)) {
            throw new ResponsesTurnError("Responses required hosted web_search on the first leg but did not return a web call.");
          }
          completed = event.response;
          // Some transports omit granular web stream events. The terminal
          // output still contains hosted call records, so project those into
          // the same safe Telegram lifecycle rather than hiding a real tool.
          await completeThinking(true);
          for (const item of event.response.output) {
            const web = webSearchItem(item);
            if (web === undefined) continue;
            await startWebSearch(web.callId, web.action, web.input, web.ok);
            await completeWebSearch(web.callId, web.ok);
          }
        } else if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
          throw new ResponsesTurnError(`Responses stream ended with ${event.type}.`);
        }
      }
      await completeThinking(true);
      if (!completed || !completedAdmission) {
        throw new ResponsesTurnError("Responses stream ended without response.completed.");
      }
      return {
        response: completed,
        ...completedAdmission,
        hostedWebCallIds: [...startedWebSearches],
      };
    } catch (error) {
      await completeThinking(false);
      for (const callId of [...activeWebSearches]) {
        await completeWebSearch(callId, false);
      }
      throw error;
    } finally {
      try { await iterator?.return?.(); } catch { /* aborting a stream is best effort */ }
    }
  }

  async #dispatchFunctions(
    calls: readonly ResponseFunctionToolCall[],
    request: RunResponsesTurnRequest,
    signal: AbortSignal,
    remainingOutputChars: number,
    maxPotentialOutputCalls: number,
  ): Promise<{ input: readonly Record<string, unknown>[]; outputChars: number }> {
    const allowed = new Set(request.localFunctions.map((tool) => tool.name));
    const outputs: Record<string, unknown>[] = [];
    let outputChars = 0;
    for (const [index, call] of calls.entries()) {
      const callId = call.call_id;
      const name = call.name;
      let result: { success: boolean; text: string };
      if (!allowed.has(name)) {
        // An unknown model-supplied name gets a bounded tool output but never
        // appears in Telegram as if the host had accepted a real tool call.
        result = { success: false, text: "Unknown local function." };
      } else {
        const parsedCall = parseFunctionCall(call);
        await progress(request, {
          type: "local_function_started",
          callId,
          name,
          arguments: parsedCall.arguments,
        });
        try {
          result = await request.dispatcher.dispatch(parsedCall, signal);
          assertFunctionResult(result);
        } catch {
          result = { success: false, text: "Local function failed." };
        }
      }
      const laterPotentialCalls = maxPotentialOutputCalls - index - 1;
      if (laterPotentialCalls < 0) {
        throw new ResponsesTurnError("Responses local function-call accounting is invalid.");
      }
      // Reserve one fixed failure output for every currently possible later
      // call. A large result therefore cannot starve a sibling/future call of
      // a deterministic function_call_output and kill the entire Telegram turn.
      const availableForCurrent = remainingOutputChars - outputChars -
        laterPotentialCalls * FUNCTION_OUTPUT_BUDGET_ERROR.length;
      if (availableForCurrent < FUNCTION_OUTPUT_BUDGET_ERROR.length) {
        throw new ResponsesTurnError("Responses local function-output reservation is invalid.");
      }
      const emitted = result.text.length <= availableForCurrent - FUNCTION_OUTPUT_BUDGET_ERROR.length
        ? result
        : { success: false, text: FUNCTION_OUTPUT_BUDGET_ERROR };
      if (allowed.has(name)) {
        await progress(request, {
          type: "local_function_completed",
          callId,
          name,
          ok: emitted.success,
        });
      }
      outputChars += emitted.text.length;
      outputs.push({
        type: "function_call_output",
        call_id: callId,
        output: emitted.text,
      });
    }
    return { input: outputs, outputChars };
  }
}

function createRequest(
  request: RunResponsesTurnRequest,
  input: readonly Record<string, unknown>[],
  firstLeg: boolean,
  maxFunctionCalls: number,
): ResponsesCreateRequest {
  return {
    model: OPENAI_RESPONSES_MODEL,
    service_tier: OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER,
    reasoning: { effort: request.effort },
    store: false,
    stream: true,
    prompt_cache_key: OPENAI_RESPONSES_PROMPT_CACHE_KEY,
    instructions: request.instructions,
    input,
    tools: request.hostedWebSearch === false
      ? [...request.localFunctions]
      : [OPENAI_WEB_SEARCH_TOOL, ...request.localFunctions],
    include: request.hostedWebSearch === false
      ? ["reasoning.encrypted_content"] as const
      : ["reasoning.encrypted_content", "web_search_call.action.sources"] as const,
    ...(request.hostedWebSearchPolicy === "required_first_leg" && firstLeg
      ? { tool_choice: { type: "allowed_tools" as const, mode: "required" as const, tools: [{ type: "web_search" as const }] as const } }
      : {}),
    max_tool_calls: maxFunctionCalls,
    parallel_tool_calls: false,
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: boundedOutputTokens(request.maxOutputTokens) }),
    ...(request.textJsonSchema === undefined ? {} : { text: { format: jsonSchemaFormat(request.textJsonSchema) } }),
  };
}

function assertHostedWebPolicy(request: RunResponsesTurnRequest): void {
  if (request.hostedWebSearch === false && request.hostedWebSearchPolicy !== undefined) {
    throw new ResponsesTurnError("Responses hosted web policy cannot require a disabled hosted tool.");
  }
  if (request.hostedWebSearchPolicy !== undefined &&
    request.hostedWebSearchPolicy !== "available" && request.hostedWebSearchPolicy !== "required_first_leg") {
    throw new ResponsesTurnError("Responses hosted web policy is invalid.");
  }
}

function userInput(text: string, image: RunResponsesTurnRequest["image"]): readonly Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [{ type: "input_text", text }];
  if (image !== undefined) {
    if (!/^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[A-Za-z0-9+/=]+$/iu.test(image.dataUrl) || image.dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
      throw new ResponsesTurnError("Responses image input must be a bounded image data URL.");
    }
    content.push({ type: "input_image", image_url: image.dataUrl, detail: image.detail ?? "auto" });
  }
  return [{ role: "user", content }];
}

function functionCallsFrom(items: readonly ResponseOutputItem[]): ResponseFunctionToolCall[] {
  return items.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");
}

/**
 * The transport-normalized output is already provider wire data. Preserve it
 * as-is in the next stateless leg; serializing individual variants here would
 * risk dropping encrypted reasoning or a hosted-tool record needed by Codex.
 */
function responseOutputInput(items: readonly ResponseOutputItem[]): readonly Record<string, unknown>[] {
  return items.map((item) => item as unknown as Record<string, unknown>);
}

function webSearchItem(item: ResponseOutputItem): {
  callId: string;
  action?: ResponsesWebAction;
  input?: ResponsesWebProgressInput;
  ok: boolean;
} | undefined {
  if (item.type !== "web_search_call" || typeof item.id !== "string") return undefined;
  const action = recordAction(item.action);
  const input = webProgressInput(item.action);
  const status = item.status;
  return {
    callId: item.id,
    ...(action === undefined ? {} : { action }),
    ...(input === undefined ? {} : { input }),
    ok: status !== "failed",
  };
}

function hasHostedWebSearchCall(items: readonly ResponseOutputItem[]): boolean {
  return items.some((item) => item.type === "web_search_call");
}

function recordAction(value: unknown): ResponsesWebAction | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const type = (value as { type?: unknown }).type;
  return type === "search" || type === "open_page" || type === "find_in_page" ? type : undefined;
}

function webProgressInput(value: unknown): ResponsesWebProgressInput | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const action = value as {
    type?: unknown;
    query?: unknown;
    queries?: unknown;
    url?: unknown;
    pattern?: unknown;
  };
  if (action.type === "search") {
    const queries = Array.isArray(action.queries)
      ? action.queries.filter((query): query is string => typeof query === "string")
      : [];
    const legacy = typeof action.query === "string" ? [action.query] : [];
    const query = boundedProgressText([...queries, ...legacy].join(" / "), 512);
    return query === undefined ? undefined : { query };
  }
  if (action.type === "open_page") {
    const url = boundedProgressText(action.url, 2_048);
    return url === undefined ? undefined : { url };
  }
  if (action.type === "find_in_page") {
    const pattern = boundedProgressText(action.pattern, 512);
    const url = boundedProgressText(action.url, 2_048);
    if (pattern === undefined && url === undefined) return undefined;
    return {
      ...(pattern === undefined ? {} : { pattern }),
      ...(url === undefined ? {} : { url }),
    };
  }
  return undefined;
}

function boundedProgressText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  return Array.from(normalized).slice(0, maximum).join("");
}

function webProgressFingerprint(
  action: ResponsesWebAction,
  input: ResponsesWebProgressInput | undefined,
): string {
  return JSON.stringify([action, input?.query, input?.url, input?.pattern]);
}

function parseFunctionCall(call: ResponseFunctionToolCall): LocalFunctionCall {
  try {
    return { callId: call.call_id, name: call.name, arguments: JSON.parse(call.arguments) };
  } catch {
    return { callId: call.call_id, name: call.name, arguments: undefined };
  }
}

function citationsFrom(response: Response): readonly ResponsesCitation[] {
  const citations: ResponsesCitation[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      for (const annotation of content.annotations) {
        if (annotation.type === "url_citation" && validCitation(annotation)) {
          citations.push({
            startIndex: annotation.start_index,
            endIndex: annotation.end_index,
            title: annotation.title,
            url: annotation.url,
          });
        }
      }
    }
  }
  return citations;
}

/**
 * The public Luna page currently lists only the `gpt-5.6-luna` alias, not a
 * dated snapshot. Accept that exact response identity only: prefix matching
 * would silently admit Terra, Sol, or an unreviewed future snapshot.
 *
 * The subscription transport normalizes its Fast lane to the exact `priority`
 * wire value. Reject every other value on every function-loop leg, not merely
 * during daemon preflight.
 */
function assertCompletedResponseAdmission(response: Response): {
  model: typeof OPENAI_RESPONSES_MODEL;
  serviceTier: EffectiveResponsesServiceTier;
} {
  if (response.model !== OPENAI_RESPONSES_MODEL) {
    throw new ResponsesTurnError("Responses completed with an unexpected model.");
  }
  if (response.status !== "completed") {
    throw new ResponsesTurnError("Responses completed event carried a non-completed response.");
  }
  if (response.service_tier !== OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER) {
    throw new ResponsesTurnError("Responses completed without the required fast service tier.");
  }
  return { model: OPENAI_RESPONSES_MODEL, serviceTier: OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER };
}

function validCitation(value: { start_index: number; end_index: number; title: string; url: string }): boolean {
  return Number.isSafeInteger(value.start_index) && Number.isSafeInteger(value.end_index) &&
    value.start_index >= 0 && value.end_index >= value.start_index &&
    value.title.length > 0 && value.title.length <= 1_024 && /^https?:\/\//iu.test(value.url);
}

function usageFrom(response: Response): ResponsesUsage | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.output_tokens_details.reasoning_tokens,
    totalTokens: usage.total_tokens,
  };
}

async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new ResponsesTurnCancelledError();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new ResponsesTurnCancelledError());
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

function joinSignals(parent: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

async function progress(request: RunResponsesTurnRequest, event: ResponsesProgressEvent): Promise<void> {
  try { await request.progress?.onProgress(event); } catch { /* presentation never controls a model turn */ }
}

function assertFunctionSchemas(schemas: readonly { name: string }[]): void {
  const names = new Set<string>();
  for (const schema of schemas) {
    if (!schema || typeof schema.name !== "string" || schema.name.length === 0 || schema.name.length > 128 || names.has(schema.name)) {
      throw new ResponsesTurnError("Responses local function schemas must have unique bounded names.");
    }
    names.add(schema.name);
  }
}

function assertFunctionResult(result: { success: boolean; text: string }): void {
  if (typeof result.success !== "boolean" || typeof result.text !== "string" || result.text.length > MAX_FUNCTION_RESULT_CHARS) {
    throw new ResponsesTurnError("Responses local function result is invalid or too large.");
  }
}

function assertPlainText(value: string, name: string, limit: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > limit || /\0/u.test(value)) {
    throw new ResponsesTurnError(`Responses ${name} must be non-empty and bounded.`);
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ResponsesTurnError(`Responses timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`);
  }
  return value;
}

function boundedFunctionCalls(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FUNCTION_CALLS) {
    throw new ResponsesTurnError(`Responses maxFunctionCalls must be between 1 and ${MAX_FUNCTION_CALLS}.`);
  }
  return value;
}

function boundedOutputTokens(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OUTPUT_TOKENS) {
    throw new ResponsesTurnError(`Responses maxOutputTokens must be between 1 and ${MAX_OUTPUT_TOKENS}.`);
  }
  return value;
}

function assertTextJsonSchema(schema: RunResponsesTurnRequest["textJsonSchema"]): void {
  if (schema === undefined) return;
  if (typeof schema.name !== "string" || schema.name.length === 0 || schema.name.length > 64 ||
    schema.schema === null || typeof schema.schema !== "object") {
    throw new ResponsesTurnError("Responses textJsonSchema must have a bounded name and object schema.");
  }
}

function jsonSchemaFormat(schema: NonNullable<RunResponsesTurnRequest["textJsonSchema"]>): Record<string, unknown> {
  return {
    type: "json_schema",
    name: schema.name,
    schema: schema.schema,
    ...(schema.description === undefined ? {} : { description: schema.description }),
    ...(schema.strict === undefined ? {} : { strict: schema.strict }),
  };
}
