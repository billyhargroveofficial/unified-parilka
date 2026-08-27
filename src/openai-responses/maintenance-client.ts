import {
  OPENAI_RESPONSES_MODEL,
  OPENAI_RESPONSES_SERVICE_TIER,
  type LocalFunctionDispatcher,
  type LocalFunctionSchema,
  type RunResponsesTurnRequest,
  type RunResponsesTurnResult,
} from "./contracts.js";
import {
  OPENAI_RESPONSES_MAINTENANCE_PROVIDER_ID,
  type OpenAiResponsesMaintenanceClient,
  type ResponsesFunctionLoopRequest,
  type ResponsesFunctionLoopResult,
  type ResponsesFunctionOutput,
  type ResponsesTextRequest,
  type ResponsesTextResult,
} from "./maintenance.js";

const MAINTENANCE_EFFORT = "medium" as const;
const MAINTENANCE_OUTPUT_SCHEMA_NAME = "maintenance_output";
const MAX_MAINTENANCE_FUNCTION_OUTPUT_CHARS = 200_000;
const MAX_MAINTENANCE_FUNCTION_CALLS = 8;

/** The small part of the direct Responses core needed by maintenance jobs. */
export interface OpenAiResponsesTurnPort {
  run(request: RunResponsesTurnRequest): Promise<RunResponsesTurnResult>;
}

/**
 * Fixed-policy maintenance facade over the shared direct Responses turn core.
 *
 * It cannot enable hosted web search or image input. The underlying core owns
 * the actual streaming/function continuation loop, while this adapter owns the
 * narrower Digest/Dream policy and maps their function schemas into it.
 */
export class OpenAiResponsesMaintenanceClientAdapter implements OpenAiResponsesMaintenanceClient {
  readonly model = OPENAI_RESPONSES_MODEL;
  readonly serviceTier = OPENAI_RESPONSES_SERVICE_TIER;
  readonly #turn: OpenAiResponsesTurnPort;

  constructor(turn: OpenAiResponsesTurnPort) {
    if (turn === null || typeof turn !== "object" || typeof turn.run !== "function") {
      throw new TypeError("Responses maintenance adapter requires a turn client.");
    }
    this.#turn = turn;
  }

  async runText(request: ResponsesTextRequest): Promise<ResponsesTextResult> {
    assertMaintenanceRequestPolicy(request);
    const result = await this.#turn.run({
      text: request.input,
      instructions: request.instructions,
      localFunctions: [],
      dispatcher: noLocalFunctions,
      hostedWebSearch: false,
      effort: MAINTENANCE_EFFORT,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxOutputTokens: request.maxOutputTokens,
      maxFunctionCalls: 1,
      ...(request.outputSchema === undefined ? {} : { textJsonSchema: namedOutputSchema(request.outputSchema) }),
    });
    return toTextResult(result);
  }

  async runFunctionLoop(request: ResponsesFunctionLoopRequest): Promise<ResponsesFunctionLoopResult> {
    assertMaintenanceRequestPolicy(request);
    const allowed = new Set<string>();
    const localFunctions = request.tools.map((tool) => {
      if (allowed.has(tool.name)) throw new TypeError("Responses maintenance function names must be unique.");
      allowed.add(tool.name);
      return toLocalFunctionSchema(tool);
    });
    const result = await this.#turn.run({
      text: request.input,
      instructions: request.instructions,
      localFunctions,
      dispatcher: boundedDispatcher(request, allowed),
      hostedWebSearch: false,
      effort: MAINTENANCE_EFFORT,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxOutputTokens: request.maxOutputTokens,
      maxFunctionCalls: MAX_MAINTENANCE_FUNCTION_CALLS,
      ...(request.outputSchema === undefined ? {} : { textJsonSchema: namedOutputSchema(request.outputSchema) }),
    });
    const text = toTextResult(result);
    if (!Number.isSafeInteger(result.functionCalls) || result.functionCalls < 0) {
      throw new TypeError("Responses maintenance turn returned an invalid function-call count.");
    }
    return { ...text, finishReason: "stop", toolCalls: result.functionCalls };
  }
}

function assertMaintenanceRequestPolicy(request: ResponsesTextRequest): void {
  if (request.model !== OPENAI_RESPONSES_MODEL) {
    throw new Error(`Responses maintenance model must be ${OPENAI_RESPONSES_MODEL}.`);
  }
  if (request.serviceTier !== OPENAI_RESPONSES_SERVICE_TIER) {
    throw new Error(`Responses maintenance service tier must be ${OPENAI_RESPONSES_SERVICE_TIER}.`);
  }
}

function namedOutputSchema(schema: Readonly<Record<string, unknown>>): NonNullable<RunResponsesTurnRequest["textJsonSchema"]> {
  return { name: MAINTENANCE_OUTPUT_SCHEMA_NAME, schema, strict: true };
}

function toLocalFunctionSchema(tool: ResponsesFunctionLoopRequest["tools"][number]): LocalFunctionSchema {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

const noLocalFunctions: LocalFunctionDispatcher = {
  async dispatch() {
    return { success: false, text: "This maintenance turn has no local functions." };
  },
};

function boundedDispatcher(
  request: ResponsesFunctionLoopRequest,
  allowed: ReadonlySet<string>,
): LocalFunctionDispatcher {
  return {
    async dispatch(call) {
      if (!allowed.has(call.name)) {
        return { success: false, text: "Unknown maintenance function." };
      }
      try {
        return boundedFunctionOutput(await request.dispatch(call.name, call.arguments));
      } catch {
        return { success: false, text: "Maintenance function failed." };
      }
    },
  };
}

function boundedFunctionOutput(value: ResponsesFunctionOutput): ResponsesFunctionOutput {
  if (value === null || typeof value !== "object" || typeof value.success !== "boolean" || typeof value.text !== "string") {
    return { success: false, text: "Maintenance function returned an invalid result." };
  }
  if (value.text.length > MAX_MAINTENANCE_FUNCTION_OUTPUT_CHARS) {
    return { success: false, text: "Maintenance function result is too large." };
  }
  return { success: value.success, text: value.text };
}

function toTextResult(result: RunResponsesTurnResult): ResponsesTextResult {
  if (typeof result.text !== "string") throw new TypeError("Responses maintenance turn returned invalid text.");
  return {
    text: result.text,
    model: result.model,
    providerId: OPENAI_RESPONSES_MAINTENANCE_PROVIDER_ID,
    completed: result.completed,
    ...(result.usage === undefined
      ? {}
      : { usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } }),
  };
}
