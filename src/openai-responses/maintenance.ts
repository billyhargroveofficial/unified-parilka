import type {
  SummaryTextRunResult,
  SummaryTextRunner,
} from "../digest/summary-text-port.js";
import type {
  DreamTextRunOptions,
  DreamTextRunResult,
  DreamTextRunner,
} from "../dream/text-runner.js";
import { REVIEW_DYNAMIC_TOOLS, type ReviewDynamicTool } from "../dream/review-tools.js";
import {
  OPENAI_RESPONSES_MODEL as OPENAI_RESPONSES_MAINTENANCE_MODEL,
  OPENAI_RESPONSES_SERVICE_TIER as OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
} from "./contracts.js";

/** Re-export the shared direct-Responses Luna/fast policy for maintenance. */
export {
  OPENAI_RESPONSES_MAINTENANCE_MODEL,
  OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
};
export const OPENAI_RESPONSES_MAINTENANCE_PROVIDER_ID = "openai-responses" as const;

export interface ResponsesTextRequest {
  model: typeof OPENAI_RESPONSES_MAINTENANCE_MODEL;
  serviceTier: typeof OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER;
  instructions: string;
  input: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputTokens: number;
  outputSchema?: Readonly<Record<string, unknown>>;
}

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}

export interface ResponsesFunctionOutput {
  success: boolean;
  text: string;
}

export interface ResponsesFunctionLoopRequest extends ResponsesTextRequest {
  tools: readonly ResponsesFunctionTool[];
  dispatch: (name: string, input: unknown) => Promise<ResponsesFunctionOutput>;
}

export interface ResponsesTextResult {
  text: string;
  /** The direct Responses client must return the actual resolved model. */
  model: string;
  providerId?: string;
  completed?: boolean;
  usage?: { inputTokens?: unknown; outputTokens?: unknown };
}

export interface ResponsesFunctionLoopResult extends ResponsesTextResult {
  finishReason: string;
  toolCalls: number;
}

/**
 * Narrow maintenance seam beside the shared direct Responses client.
 *
 * The current generic turn contract does not yet carry maintenance's output
 * budget or Dream finish/tool metadata, so the production bridge should adapt
 * its streamed function loop to this interface. Maintenance itself never
 * imports SDK or credential details directly.
 */
export interface OpenAiResponsesMaintenanceClient {
  readonly model: string;
  readonly serviceTier: string;
  runText(request: ResponsesTextRequest): Promise<ResponsesTextResult>;
  runFunctionLoop(request: ResponsesFunctionLoopRequest): Promise<ResponsesFunctionLoopResult>;
}

/** Maps the existing digest port onto a hard-pinned direct Responses client. */
export class ResponsesDigestTextRunner implements SummaryTextRunner {
  readonly #client: OpenAiResponsesMaintenanceClient;

  constructor(client: OpenAiResponsesMaintenanceClient) {
    assertMaintenanceClient(client);
    this.#client = client;
  }

  async runText(params: Parameters<SummaryTextRunner["runText"]>[0]): Promise<SummaryTextRunResult> {
    const result = await this.#client.runText({
      model: OPENAI_RESPONSES_MAINTENANCE_MODEL,
      serviceTier: OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
      instructions: params.instructions,
      input: params.prompt,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      maxOutputTokens: params.maxOutputTokens,
      ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
    });
    assertPinnedResult(result);
    return {
      text: result.text,
      model: result.model,
      providerId: result.providerId ?? OPENAI_RESPONSES_MAINTENANCE_PROVIDER_ID,
      ...(result.completed === undefined ? {} : { completed: result.completed }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }
}

/**
 * Direct Responses bridge for Dream review and tool-free shortening. It owns
 * no store: staged writes remain exclusively inside Dream's existing runner.
 */
export class ResponsesDreamRunner implements DreamTextRunner {
  readonly #client: OpenAiResponsesMaintenanceClient;

  constructor(client: OpenAiResponsesMaintenanceClient) {
    assertMaintenanceClient(client);
    this.#client = client;
  }

  async runText(options: DreamTextRunOptions): Promise<DreamTextRunResult> {
    assertDreamToolSurface(options.dynamicTools);
    if (options.dynamicTools.length === 0) {
      const result = await this.#client.runText({
        model: OPENAI_RESPONSES_MAINTENANCE_MODEL,
        serviceTier: OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
        instructions: options.instructions,
        input: options.prompt,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        maxOutputTokens: options.maxOutputTokens,
      });
      assertPinnedResult(result);
      return {
        text: result.text,
        finishReason: result.completed === false ? "incomplete" : "stop",
        toolCalls: 0,
        model: result.model,
        providerId: result.providerId ?? OPENAI_RESPONSES_MAINTENANCE_PROVIDER_ID,
      };
    }

    const permitted = new Set<string>(options.dynamicTools.map((tool) => tool.name));
    const result = await this.#client.runFunctionLoop({
      model: OPENAI_RESPONSES_MAINTENANCE_MODEL,
      serviceTier: OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
      instructions: options.instructions,
      input: options.prompt,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxOutputTokens: options.maxOutputTokens,
      tools: options.dynamicTools.map(toResponsesFunctionTool),
      dispatch: async (name, input) => {
        if (!permitted.has(name)) {
          return { success: false, text: "Dream host tool is not permitted." };
        }
        try {
          return { success: true, text: await options.dispatch(name, input) };
        } catch {
          // Keep malformed tool input and staged-store errors bounded. The
          // outer Dream attempt still decides whether to retry or discard.
          return { success: false, text: "Dream host tool rejected the request." };
        }
      },
    });
    assertPinnedResult(result);
    if (!Number.isSafeInteger(result.toolCalls) || result.toolCalls < 0) {
      throw new TypeError("Responses function loop returned an invalid tool-call count.");
    }
    if (typeof result.finishReason !== "string" || result.finishReason.trim().length === 0) {
      throw new TypeError("Responses function loop returned an invalid finish reason.");
    }
    return {
      text: result.text,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls,
      model: result.model,
      providerId: result.providerId ?? OPENAI_RESPONSES_MAINTENANCE_PROVIDER_ID,
    };
  }
}

export function assertMaintenanceClient(client: OpenAiResponsesMaintenanceClient): void {
  if (
    client === null ||
    typeof client !== "object" ||
    typeof client.runText !== "function" ||
    typeof client.runFunctionLoop !== "function"
  ) {
    throw new TypeError("Responses maintenance client requires text and function-loop methods.");
  }
  if (client.model !== OPENAI_RESPONSES_MAINTENANCE_MODEL) {
    throw new Error(`Responses maintenance model must be ${OPENAI_RESPONSES_MAINTENANCE_MODEL}.`);
  }
  if (client.serviceTier !== OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER) {
    throw new Error(`Responses maintenance service tier must be ${OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER}.`);
  }
}

function assertPinnedResult(result: ResponsesTextResult): void {
  if (result === null || typeof result !== "object" || typeof result.text !== "string") {
    throw new TypeError("Responses maintenance client returned an invalid text result.");
  }
  if (result.model !== OPENAI_RESPONSES_MAINTENANCE_MODEL) {
    throw new Error(`Responses maintenance result model must be ${OPENAI_RESPONSES_MAINTENANCE_MODEL}.`);
  }
}

function toResponsesFunctionTool(tool: ReviewDynamicTool): ResponsesFunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function assertDreamToolSurface(dynamicTools: readonly ReviewDynamicTool[]): void {
  if (dynamicTools.length === 0) return;
  if (stableJson(dynamicTools) !== stableJson(REVIEW_DYNAMIC_TOOLS)) {
    throw new Error("Dream Responses turn may expose only REVIEW_DYNAMIC_TOOLS.");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
