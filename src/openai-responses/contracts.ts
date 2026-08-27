import type {
  FunctionTool,
  ResponseOutputText,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

/** The only public model identity accepted by the Telegram response path. */
export const OPENAI_RESPONSES_MODEL = "gpt-5.6-luna" as const;
export const OPENAI_RESPONSES_SERVICE_TIER = "fast" as const;
/**
 * The subscription Responses wire calls its Fast lane `priority`.  Keep the
 * public runtime policy (`fast`) separate from the exact wire value so callers
 * cannot accidentally select a different lane.
 */
export const OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER = "priority" as const;
/**
 * A code-owned, non-PII cache partition for the stable Responses prompt
 * prefix. Bump this only when the shared prompt/tool contract changes.
 */
export const OPENAI_RESPONSES_PROMPT_CACHE_KEY = "parilka:responses:v2" as const;
/** The subscription transport normalizes successful Fast completions to this exact value. */
export type EffectiveResponsesServiceTier = typeof OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER;
export const OPENAI_WEB_SEARCH_TOOL = Object.freeze({
  type: "web_search" as const,
  search_context_size: "medium" as const,
});

export type ResponsesReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * Hosted web is registered for every interactive bot request.  A narrow,
 * explicit user request may require it on the initial model leg; continuations
 * always return to the ordinary tool policy after that first hosted call.
 */
export type HostedWebSearchPolicy = "available" | "required_first_leg";

/**
 * Deliberately no catch-all tool surface: callers provide exactly these schemas.
 * `strict` remains optional because existing trusted host schemas may omit it;
 * the core forwards the caller object unchanged rather than silently rewriting it.
 */
export type LocalFunctionSchema = Omit<FunctionTool, "strict"> & {
  readonly strict?: boolean | null;
};

export interface LocalFunctionCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface LocalFunctionResult {
  readonly success: boolean;
  /** JSON-safe text returned to the model, never presented directly to Telegram. */
  readonly text: string;
}

export interface LocalFunctionDispatcher {
  dispatch(call: LocalFunctionCall, signal: AbortSignal): Promise<LocalFunctionResult>;
}

export type ResponsesWebAction = "search" | "open_page" | "find_in_page";

/** Bounded hosted-web selectors that may be projected into transient Telegram UI. */
export interface ResponsesWebProgressInput {
  readonly query?: string;
  readonly url?: string;
  readonly pattern?: string;
}

/** Payloads are presentation-safe: no model reasoning, tool output, or image data. */
export type ResponsesProgressEvent =
  | { readonly type: "thinking_started"; readonly callId: string }
  | { readonly type: "thinking_completed"; readonly callId: string; readonly ok: boolean }
  | {
    readonly type: "hosted_web_started";
    readonly callId: string;
    readonly action?: ResponsesWebAction;
    readonly input?: ResponsesWebProgressInput;
  }
  | {
    readonly type: "hosted_web_action";
    readonly callId: string;
    readonly action: ResponsesWebAction;
    readonly input?: ResponsesWebProgressInput;
  }
  | { readonly type: "hosted_web_completed"; readonly callId: string; readonly ok: boolean }
  | {
    readonly type: "local_function_started";
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
  }
  | { readonly type: "local_function_completed"; readonly callId: string; readonly name: string; readonly ok: boolean };

export interface ResponsesProgressPort {
  onProgress(event: ResponsesProgressEvent): void | Promise<void>;
}

export interface ResponsesCitation {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly title: string;
  readonly url: string;
}

export interface ResponsesUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface ResponsesImageInput {
  /** A bounded `data:image/...;base64,...` URL prepared by the trusted host. */
  readonly dataUrl: string;
  readonly detail?: "low" | "high" | "auto" | "original";
}

/** The only structured-output setting exposed by this core. */
export interface ResponsesTextJsonSchema {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly strict?: boolean;
}

export interface RunResponsesTurnRequest {
  readonly text: string;
  readonly instructions: string;
  readonly localFunctions: readonly LocalFunctionSchema[];
  readonly dispatcher: LocalFunctionDispatcher;
  readonly image?: ResponsesImageInput;
  /** Hosted web search remains enabled unless an isolated maintenance job opts out. */
  readonly hostedWebSearch?: boolean;
  /** Requires hosted web_search, and only on the first leg of this one turn. */
  readonly hostedWebSearchPolicy?: HostedWebSearchPolicy;
  readonly maxOutputTokens?: number;
  readonly textJsonSchema?: ResponsesTextJsonSchema;
  readonly effort: ResponsesReasoningEffort;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxFunctionCalls?: number;
  readonly progress?: ResponsesProgressPort;
}

export interface RunResponsesTurnResult {
  /** Provider correlation only; Telegram continuity remains SQLite/RAG-owned. */
  readonly responseId: string;
  /**
   * The actual provider-reported model after exact Luna admission validation.
   * Luna currently publishes no dated snapshot alias, so this remains exact.
   */
  readonly model: typeof OPENAI_RESPONSES_MODEL;
  readonly text: string;
  readonly annotations: readonly ResponsesCitation[];
  readonly usage?: ResponsesUsage;
  /** The validated provider-reported effective tier for this completed turn. */
  readonly serviceTier: EffectiveResponsesServiceTier;
  readonly functionCalls: number;
  readonly hostedWebCalls: number;
  readonly completed: true;
  readonly finishStatus: "completed";
}

export interface ResponsesCreateRequest {
  readonly model: typeof OPENAI_RESPONSES_MODEL;
  /** Codex subscription wire spelling for the hard-pinned Fast lane. */
  readonly service_tier: typeof OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER;
  readonly reasoning: { readonly effort: ResponsesReasoningEffort };
  /** Stateless requests replay the complete in-turn transcript themselves. */
  readonly store: false;
  readonly stream: true;
  /** Stable direct-subscription cache partition; never derived from a chat or user. */
  readonly prompt_cache_key: typeof OPENAI_RESPONSES_PROMPT_CACHE_KEY;
  readonly instructions: string;
  readonly input: readonly Record<string, unknown>[];
  readonly tools: readonly (typeof OPENAI_WEB_SEARCH_TOOL | LocalFunctionSchema)[];
  /**
   * Encrypted reasoning is required to replay a response's output in a
   * stateless function continuation. Web sources stay available whenever the
   * hosted tool is exposed.
   */
  readonly include:
    | readonly ["reasoning.encrypted_content"]
    | readonly ["reasoning.encrypted_content", "web_search_call.action.sources"];
  /** First-leg deterministic hosted search, deliberately absent on continuations. */
  readonly tool_choice?: Readonly<{
    type: "allowed_tools";
    mode: "required";
    tools: readonly [Readonly<{ type: "web_search" }>];
  }>;
  readonly max_tool_calls: number;
  readonly parallel_tool_calls: false;
  readonly max_output_tokens?: number;
  readonly text?: Readonly<{ format: Readonly<Record<string, unknown>> }>;
}

/** Narrow seam around the official SDK; tests never open a network connection. */
export interface ResponsesStreamTransport {
  create(
    request: ResponsesCreateRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<AsyncIterable<ResponseStreamEvent>>;
}

export class ResponsesTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsesTurnError";
  }
}

export class ResponsesTurnTimeoutError extends ResponsesTurnError {
  constructor(timeoutMs: number) {
    super(`Responses turn exceeded its ${timeoutMs}ms timeout.`);
    this.name = "ResponsesTurnTimeoutError";
  }
}

export class ResponsesTurnCancelledError extends ResponsesTurnError {
  constructor() {
    super("Responses turn was cancelled.");
    this.name = "ResponsesTurnCancelledError";
  }
}

export type OutputText = ResponseOutputText;
