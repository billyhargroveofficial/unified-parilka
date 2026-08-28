import assert from "node:assert/strict";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  AiSdkBotTurnAgent,
  type TurnModelRouter,
} from "../../src/bot/ai-agent.js";
import {
  BotReadTools,
  type BotReadToolCache,
} from "../../src/bot/read-tools.js";
import { BotMemoryTools } from "../../src/bot/memory-tools.js";
import type { WebToolPort } from "../../src/bot/web-tools/tool-definitions.js";
import type { BotMediaToolsPort } from "../../src/bot/media-tools.js";
import type { ToolProgressPort } from "../../src/bot/tool-progress.js";
import type {
  FoldBatch,
  TurnBoundary,
} from "../../src/bot/turn-coordinator.js";
import type {
  BotAgentRequest,
  JsonEventLogger,
} from "../../src/bot/worker.js";
import {
  classifyModelFallback,
  ModelRoutingError,
  type ModelAttemptRecord,
  type ModelExecutionResult,
  type ModelRole,
  type ResolvedModelCandidate,
} from "../../src/providers/model-router.js";
import { abortErrorFrom } from "../../src/providers/model-router/fallback.js";
import type {
  StoredBotTurn,
  StoredMessage,
} from "../../src/store.js";
import { emptyTranscript } from "./bot-read-tools.js";

export const CHAT_ID = "-1004242";
const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 5,
    text: 5,
    reasoning: undefined,
  },
} as const;

export function makeAgent(
  candidates: ResolvedModelCandidate[],
  options: {
    searchResults?: readonly StoredMessage[];
    mediaTools?: BotMediaToolsPort;
    memoryTools?: BotMemoryTools;
    botSenderId?: string;
    agentOptions?: {
      contextCharLimit?: number;
      stepTimeoutMs?: number;
      toolTimeoutMs?: number;
      searxngEndpoint?: string;
      firecrawlEndpoint?: string;
      webToolPort?: WebToolPort;
    };
  } = {},
): {
  agent: AiSdkBotTurnAgent;
  logs: Array<Record<string, unknown>>;
  readonly searchCalls: number;
} {
  let searchCalls = 0;
  const cache: BotReadToolCache = {
    search: async () => {
      searchCalls += 1;
      return options.searchResults ?? [];
    },
    findMessages: () => [],
    readSlice: () => emptyTranscript(),
    getThreadContext: () => [],
    getDigests: () => ({ digests: [] }),
  };
  const logs: Array<Record<string, unknown>> = [];
  const logger: JsonEventLogger = {
    info: (record) => logs.push({ ...record }),
    warn: (record) => logs.push({ ...record }),
    error: (record) => logs.push({ ...record }),
  };
  return {
    agent: new AiSdkBotTurnAgent({
      router: new FakeRouter(candidates),
      readTools: new BotReadTools({
        chatId: CHAT_ID,
        cache,
        ...(options.botSenderId === undefined
          ? {}
          : { botSenderId: options.botSenderId }),
      }),
      ...(options.mediaTools === undefined
        ? {}
        : { mediaTools: options.mediaTools }),
      ...(options.memoryTools === undefined
        ? {}
        : { memoryTools: options.memoryTools }),
      prompt: {
        botUsername: "parilka_bot",
        botName: "Парилка",
        chatTitle: "Тестовая парилка",
        ...(options.botSenderId === undefined
          ? {}
          : { botSenderId: options.botSenderId }),
      },
      logger,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      nonceFactory: () => "fixed_nonce_1234",
      ...options.agentOptions,
    }),
    logs,
    get searchCalls() {
      return searchCalls;
    },
  };
}

class FakeRouter implements TurnModelRouter {
  constructor(
    private readonly candidates: readonly ResolvedModelCandidate[],
  ) {}

  async executeWithFallback<T>(
    role: ModelRole,
    attempt: (
      candidate: ResolvedModelCandidate,
      attemptNumber: number,
    ) => Promise<T>,
  ): Promise<ModelExecutionResult<T>> {
    assert.equal(role, "turn");
    const failures: ModelAttemptRecord[] = [];
    for (let index = 0; index < this.candidates.length; index += 1) {
      const selected = this.candidates[index]!;
      try {
        return {
          value: await attempt(selected, index + 1),
          candidate: selected,
          attempt: index + 1,
          failures,
        };
      } catch (error) {
        const decision = classifyModelFallback(error);
        failures.push({
          candidate: selected.reference,
          providerId: selected.providerId,
          modelId: selected.modelId,
          attempt: index + 1,
          decision,
        });
        // Matching production ModelRouter.executeWithFallback:
        // abort is control flow, not a candidate failure.
        if (decision.reason === "abort") {
          throw abortErrorFrom(error);
        }
        if (
          decision.fallback &&
          index < this.candidates.length - 1
        ) {
          continue;
        }
        throw new ModelRoutingError(
          decision.fallback ? "candidates_exhausted" : "terminal_error",
          role,
          failures,
          error,
        );
      }
    }
    throw new Error("No candidates");
  }
}

export function candidate(
  reference: `${string}:${string}`,
  model: LanguageModel,
  providerOptions?: ResolvedModelCandidate["providerOptions"],
  capabilities: ResolvedModelCandidate["capabilities"] = { vision: false },
): ResolvedModelCandidate {
  const separator = reference.indexOf(":");
  return {
    reference,
    providerId: reference.slice(0, separator),
    modelId: reference.slice(separator + 1),
    model,
    capabilities,
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
}

export function mockModel(
  results: Array<LanguageModelV4GenerateResult | Error>,
): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doGenerate: async (_options: LanguageModelV4CallOptions) => {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      if (result instanceof Error) {
        throw result;
      }
      if (!result) {
        throw new Error("Mock response missing");
      }
      return result;
    },
  });
}

export function response(
  content: LanguageModelV4GenerateResult["content"],
  finishReason:
    LanguageModelV4GenerateResult["finishReason"]["unified"],
): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: {
      unified: finishReason,
      raw: finishReason,
    },
    usage: USAGE,
    warnings: [],
  };
}

export function toolResponse(
  content: LanguageModelV4GenerateResult["content"],
): LanguageModelV4GenerateResult {
  return response(content, "tool-calls");
}

export function toolCall(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV4GenerateResult["content"][number] {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    input: JSON.stringify(input),
  };
}

export function request(
  overrides: {
    signal?: AbortSignal;
    trigger?: StoredMessage;
    replyTarget?: StoredMessage;
    context?: readonly StoredMessage[];
    drainFold?: (boundary: TurnBoundary) => FoldBatch;
    toolProgressPort?: ToolProgressPort;
    botSenderId?: string;
  } = {},
): BotAgentRequest {
  const trigger =
    overrides.trigger ??
    storedMessage(100, "что там было?", "42", "Коля");
  const turn: StoredBotTurn = {
    id: 1,
    updateId: 2,
    chatId: CHAT_ID,
    triggerMessageId: trigger.messageId,
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  return {
    turn,
    trigger,
    ...(overrides.replyTarget === undefined
      ? {}
      : { replyTarget: overrides.replyTarget }),
    context:
      overrides.context ??
      [
        storedMessage(99, "старый контекст", "77", "Лена"),
        trigger,
      ],
    signal:
      overrides.signal ?? new AbortController().signal,
    drainFold:
      overrides.drainFold ??
      ((boundary) => emptyFold(boundary)),
    ...(overrides.toolProgressPort === undefined
      ? {}
      : { toolProgressPort: overrides.toolProgressPort }),
    ...(overrides.botSenderId === undefined
      ? {}
      : { botSenderId: overrides.botSenderId }),
  };
}

export function promptUserText(
  call: LanguageModelV4CallOptions | undefined,
): string {
  if (!call) {
    return "";
  }
  return call.prompt
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map(({ text }) => text)
    .join("\n");
}

export function emptyFold(boundary: TurnBoundary): FoldBatch {
  return {
    turnId: "bot:1",
    boundary,
    messages: [],
    ownerFollowUps: [],
    ambient: [],
    totalChars: 0,
    remainingMessages: 0,
  };
}

export function storedMessage(
  messageId: number,
  text: string,
  senderId: string,
  senderName: string,
): StoredMessage {
  return {
    chatId: CHAT_ID,
    messageId,
    date: "2026-07-30T12:00:00.000Z",
    senderId,
    senderName,
    text,
  };
}
