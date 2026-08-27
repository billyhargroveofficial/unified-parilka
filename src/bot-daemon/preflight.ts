import {
  CodexSubscriptionAuthStore,
  CodexSubscriptionResponsesTransport,
  OPENAI_RESPONSES_INTERACTIVE_REASONING_EFFORT,
} from "../openai-responses/index.js";
import {
  parseBotResponsesRuntimeConfig,
  type BotResponsesRuntimeConfig,
  type BotResponsesRuntimeEnvironment,
} from "../bot/responses/runtime-config.js";
import { createLogger } from "../observability/logger.js";

const MODEL_ACCESS_TIMEOUT_MS = 30_000;

export interface BotResponsesPreflightRequest {
  readonly model: "gpt-5.6-luna";
  /** Codex subscription wire value for logical Fast. */
  readonly service_tier: "priority";
  readonly reasoning: Readonly<{ effort: typeof OPENAI_RESPONSES_INTERACTIVE_REASONING_EFFORT }>;
  readonly store: false;
  readonly stream: true;
  readonly input: readonly [Readonly<{
    role: "user";
    content: readonly [Readonly<{ type: "input_text"; text: "Responses preflight: reply exactly READY." }>];
  }>];
  readonly tools: readonly [Readonly<{ type: "web_search"; search_context_size: "low" }>];
  readonly tool_choice: "none";
  readonly parallel_tool_calls: false;
  readonly max_output_tokens: 64;
}

export interface BotResponsesPreflightResponse {
  readonly model: string;
  readonly status?: string | null;
  readonly service_tier?: string | null;
  readonly output_text?: string | null;
}

export interface BotResponsesPreflightStreamEvent {
  readonly type: string;
  readonly response?: BotResponsesPreflightResponse;
}

export interface BotResponsesPreflightProbe {
  create(
    request: BotResponsesPreflightRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<AsyncIterable<BotResponsesPreflightStreamEvent>>;
  close?(): Promise<void> | void;
}

export interface BotResponsesPreflightOptions {
  readonly env?: BotResponsesRuntimeEnvironment;
  readonly createProbe?: (config: BotResponsesRuntimeConfig) => BotResponsesPreflightProbe;
  readonly timeoutMs?: number;
}

/**
 * Exercises the real subscription streaming transport only. It opens no
 * SQLite database and polls/sends no Telegram. `tool_choice: none` proves
 * hosted-web registration without creating an external search request.
 */
export async function runBotResponsesPreflight(
  options: BotResponsesPreflightOptions = {},
): Promise<BotResponsesRuntimeConfig> {
  const config = parseBotResponsesRuntimeConfig(options.env ?? process.env);
  const probe = (options.createProbe ?? createCodexSubscriptionModelProbe)(config);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Responses model-access preflight timed out.")),
    boundedTimeout(options.timeoutMs ?? MODEL_ACCESS_TIMEOUT_MS),
  );
  timeout.unref();
  try {
    const stream = await probe.create(preflightRequest(config), { signal: controller.signal });
    const response = await completedResponseFrom(stream, controller.signal);
    assertPreflightAdmission(response, config);
    return config;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await probe.close?.();
  }
}

export async function runBotResponsesPreflightMain(): Promise<void> {
  const logger = createLogger({ service: "bot" });
  try {
    const config = await runBotResponsesPreflight();
    logger.info({
      event: "bot.responses.preflight.ok",
      model: config.model,
      serviceTier: config.serviceTier,
      effectiveServiceTier: "priority",
    });
  } catch {
    // Provider bodies are untrusted and can include prompt/request context.
    logger.error({ event: "bot.responses.preflight.failed" });
    process.exitCode = 1;
  } finally {
    logger.flush();
  }
}

function createCodexSubscriptionModelProbe(
  config: BotResponsesRuntimeConfig,
): BotResponsesPreflightProbe {
  const transport = new CodexSubscriptionResponsesTransport({
    auth: new CodexSubscriptionAuthStore({ authFile: config.authFile }),
    timeoutMs: config.turnTimeoutMs,
  });
  return {
    // The production transport has the narrower interactive request type; this
    // probe intentionally differs only by `store:false` and `tool_choice:none`.
    create: (request, options) => transport.create(request as never, options) as Promise<AsyncIterable<BotResponsesPreflightStreamEvent>>,
  };
}

function preflightRequest(config: BotResponsesRuntimeConfig): BotResponsesPreflightRequest {
  return {
    model: config.model,
    service_tier: "priority",
    reasoning: { effort: config.reasoningEffort },
    store: false,
    stream: true,
    input: [{
      role: "user",
      content: [{ type: "input_text", text: "Responses preflight: reply exactly READY." }],
    }],
    tools: [{ type: "web_search", search_context_size: "low" }],
    tool_choice: "none",
    parallel_tool_calls: false,
    max_output_tokens: 64,
  };
}

async function completedResponseFrom(
  stream: AsyncIterable<BotResponsesPreflightStreamEvent>,
  signal: AbortSignal,
): Promise<BotResponsesPreflightResponse> {
  let completed: BotResponsesPreflightResponse | undefined;
  for await (const event of stream) {
    if (signal.aborted) throw signal.reason;
    if (event.type === "response.completed") {
      if (completed !== undefined || event.response === undefined) {
        throw new Error("Responses model-access preflight emitted an invalid completion.");
      }
      completed = event.response;
    } else if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
      throw new Error("Responses model-access preflight did not complete.");
    }
  }
  if (completed === undefined) {
    throw new Error("Responses model-access preflight stream ended without completion.");
  }
  return completed;
}

function assertPreflightAdmission(
  response: BotResponsesPreflightResponse,
  config: BotResponsesRuntimeConfig,
): void {
  if (response.model !== config.model) {
    throw new Error("Responses model-access preflight returned an unexpected model.");
  }
  if (response.status !== "completed") {
    throw new Error("Responses model-access preflight did not complete.");
  }
  // The transport normalizes Codex's legacy/default admission to priority.
  // Do not admit a raw default/auto/null tier here.
  if (response.service_tier !== "priority") {
    throw new Error("Responses model-access preflight was not served on the Fast (priority) tier.");
  }
  if (typeof response.output_text !== "string" || response.output_text.trim().length === 0) {
    throw new Error("Responses model-access preflight returned an empty reply.");
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000) {
    throw new Error("Responses preflight timeout must be an integer between 1000 and 30000 ms.");
  }
  return value;
}
