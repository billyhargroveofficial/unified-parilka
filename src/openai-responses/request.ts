import {
  OPENAI_RESPONSES_MODEL,
  OPENAI_RESPONSES_PROMPT_CACHE_KEY,
  OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER,
  OPENAI_WEB_SEARCH_TOOL,
  type ResponsesCreateRequest,
  type RunResponsesTurnRequest,
  ResponsesTurnError,
} from "./contracts.js";

const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_FUNCTION_CALLS = 16;
const MAX_FUNCTION_RESULT_CHARS = 200_000;
const MAX_INPUT_TEXT_CHARS = 64_000;
const MAX_INSTRUCTIONS_CHARS = 32_000;
const MAX_IMAGE_DATA_URL_CHARS = 16 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 128_000;

export function assertTurnRequest(request: RunResponsesTurnRequest): void {
  assertPlainText(request.text, "text", MAX_INPUT_TEXT_CHARS);
  assertPlainText(request.instructions, "instructions", MAX_INSTRUCTIONS_CHARS);
  assertFunctionSchemas(request.localFunctions);
  assertTextJsonSchema(request.textJsonSchema);
  assertHostedWebPolicy(request);
}

export function createRequest(
  request: RunResponsesTurnRequest,
  input: readonly Record<string, unknown>[],
  requireHostedWeb: boolean,
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
    ...(requireHostedWeb
      ? { tool_choice: { type: "allowed_tools" as const, mode: "required" as const, tools: [{ type: "web_search" as const }] as const } }
      : {}),
    max_tool_calls: maxFunctionCalls,
    parallel_tool_calls: false,
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: boundedOutputTokens(request.maxOutputTokens) }),
    ...(request.textJsonSchema === undefined ? {} : { text: { format: jsonSchemaFormat(request.textJsonSchema) } }),
  };
}

export function userInput(
  text: string,
  image: RunResponsesTurnRequest["image"],
): readonly Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [{ type: "input_text", text }];
  if (image !== undefined) {
    if (!/^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[A-Za-z0-9+/=]+$/iu.test(image.dataUrl) ||
      image.dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
      throw new ResponsesTurnError("Responses image input must be a bounded image data URL.");
    }
    content.push({ type: "input_image", image_url: image.dataUrl, detail: image.detail ?? "auto" });
  }
  return [{ role: "user", content }];
}

export function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ResponsesTurnError(`Responses timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`);
  }
  return value;
}

export function boundedFunctionCalls(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FUNCTION_CALLS) {
    throw new ResponsesTurnError(`Responses maxFunctionCalls must be between 1 and ${MAX_FUNCTION_CALLS}.`);
  }
  return value;
}

export function assertFunctionResult(result: { success: boolean; text: string }): void {
  if (typeof result.success !== "boolean" || typeof result.text !== "string" ||
    result.text.length > MAX_FUNCTION_RESULT_CHARS) {
    throw new ResponsesTurnError("Responses local function result is invalid or too large.");
  }
}

function assertHostedWebPolicy(request: RunResponsesTurnRequest): void {
  if (request.hostedWebSearch === false && request.hostedWebSearchPolicy !== undefined) {
    throw new ResponsesTurnError("Responses hosted web policy cannot require a disabled hosted tool.");
  }
  if (request.hostedWebSearchPolicy !== undefined &&
    request.hostedWebSearchPolicy !== "available" && request.hostedWebSearchPolicy !== "required_first_leg" &&
    request.hostedWebSearchPolicy !== "bounded_research") {
    throw new ResponsesTurnError("Responses hosted web policy is invalid.");
  }
}

function assertFunctionSchemas(schemas: readonly { name: string }[]): void {
  const names = new Set<string>();
  for (const schema of schemas) {
    if (!schema || typeof schema.name !== "string" || schema.name.length === 0 || schema.name.length > 128 ||
      names.has(schema.name)) {
      throw new ResponsesTurnError("Responses local function schemas must have unique bounded names.");
    }
    names.add(schema.name);
  }
}

function assertPlainText(value: string, name: string, limit: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > limit || /\0/u.test(value)) {
    throw new ResponsesTurnError(`Responses ${name} must be non-empty and bounded.`);
  }
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
