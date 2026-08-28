import { randomBytes } from "node:crypto";
import { generateText } from "ai";
import { ModelContentFilterError, ModelRoutingError, type ModelExecutionResult, type ModelRole, type ResolvedModelCandidate } from "../providers/model-router.js";
import { BOT_AGENT_CONTRACT, botExternalSourcesRequestedForText, botResearchMinimumToolCalls, botResearchModeForText, buildBotSystemPrompt, renderFoldBatch, type BotSystemPromptOptions } from "./prompt.js";
import { type BotReadTools } from "./read-tools.js";
import { BotMemoryTools } from "./memory-tools.js";
import { botMemoryWriteAllowedForText } from "./memory-policy.js";
import { extractReasoningMode, extractReasoningTokens, TurnUsageAccumulator, type TurnTelemetry } from "./telemetry.js";
import type { BotAgentFinalResult, BotAgentRequest, BotTurnAgent, JsonEventLogger } from "./worker.js";
import { buildTurnMessages, userMessage, withImageAttachment } from "./agent/context.js";
import { renderCarriedToolMessages, type CarriedToolResult } from "./agent/evidence.js";
import { sanitizeFinalText } from "./agent/final-sanitizer.js";
import { ThinkingProgressTracker } from "./agent/thinking-progress.js";
import { createBotToolExecutionObserver } from "./agent/tool-observer.js";
import { compactModelContextIfNeeded, MODEL_CONTEXT_FINALIZATION_TOKENS } from "./agent/model-context.js";
import { createBotToolSet, researchContinuationInstructions } from "./agent/tool-set.js";
import { AudioTranscriptionExecution, isDirectAudioTranscriptionRequest, renderDirectAudioTranscription } from "./agent/media-execution.js";
import { type BotMediaToolsPort } from "./media-tools.js";
import { boundedInteger, isTimeoutError, modelStepTimeoutError, requireNonce, safeErrorCode, throwIfTurnAborted } from "./agent/runtime-helpers.js";
import type { ReadToolEvidence } from "./read-tools/contracts.js";
import { appendFreshWebImages, createTurnImageTracker } from "./agent/web-images.js";
import { createWebToolPort, type WebToolPort } from "./web-tools/tool-definitions.js";
const DEFAULT_CONTEXT_CHARS = 48_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_STEP_TIMEOUT_MS = 180_000;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const MAX_CONTEXT_CHARS = 200_000;
const MAX_LENGTH_FINALIZATION_RETRIES = 1;
const MAX_EMPTY_FINAL_RETRIES = 1;
export interface TurnModelRouter {
  executeWithFallback<T>(
    role: ModelRole,
    attempt: (
      candidate: ResolvedModelCandidate,
      attemptNumber: number,
    ) => Promise<T>,
  ): Promise<ModelExecutionResult<T>>;
}

export interface AiSdkBotTurnAgentOptions {
  router: TurnModelRouter;
  readTools: BotReadTools;
  mediaTools?: BotMediaToolsPort;
  memoryTools?: BotMemoryTools;
  prompt: Omit<BotSystemPromptOptions, "modelLabel" | "now">;
  logger?: JsonEventLogger;
  now?: () => Date;
  nonceFactory?: () => string;
  contextCharLimit?: number;
  maxOutputTokens?: number;
  stepTimeoutMs?: number;
  toolTimeoutMs?: number;
  searxngEndpoint?: string;
  firecrawlEndpoint?: string;
  webToolPort?: WebToolPort;
}

export type BotAgentProtocolErrorCode =
  | "empty_final"
  | "incomplete_finish";

export class BotAgentProtocolError extends Error {
  readonly name = "BotAgentProtocolError";
  readonly modelFallback: boolean;

  constructor(
    readonly code: BotAgentProtocolErrorCode,
    readonly finishReason?: string,
    fallbackEligible = code === "empty_final",
  ) {
    super(
      code === "empty_final"
        ? "The model returned an empty final response."
        : `The model did not finish normally (${finishReason ?? "unknown"}).`,
    );
    this.modelFallback = fallbackEligible;
  }
}
/** A non-streaming, read-only model loop with durable tool accounting. */
export class AiSdkBotTurnAgent implements BotTurnAgent {
  readonly #router: TurnModelRouter;
  readonly #readTools: BotReadTools;
  readonly #mediaTools: BotMediaToolsPort | undefined;
  readonly #memoryTools: BotMemoryTools | undefined;
  readonly #prompt: Omit<BotSystemPromptOptions, "modelLabel" | "now">;
  readonly #logger: JsonEventLogger | undefined;
  readonly #now: () => Date;
  readonly #nonceFactory: () => string;
  readonly #contextCharLimit: number;
  readonly #maxOutputTokens: number;
  readonly #stepTimeoutMs: number;
  readonly #toolTimeoutMs: number;
  readonly #searxngEndpoint: string | undefined;
  readonly #firecrawlEndpoint: string | undefined;
  readonly #webToolPort: WebToolPort | undefined;

  constructor(options: AiSdkBotTurnAgentOptions) {
    this.#router = options.router;
    this.#readTools = options.readTools;
    this.#mediaTools = options.mediaTools;
    this.#memoryTools = options.memoryTools;
    this.#prompt = options.prompt;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#nonceFactory =
      options.nonceFactory ?? (() => randomBytes(12).toString("hex"));
    this.#contextCharLimit = boundedInteger(
      options.contextCharLimit ?? DEFAULT_CONTEXT_CHARS,
      1_000,
      MAX_CONTEXT_CHARS,
      "contextCharLimit",
    );
    this.#maxOutputTokens = boundedInteger(
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      64,
      32_768,
      "maxOutputTokens",
    );
    this.#stepTimeoutMs = boundedInteger(
      options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      100,
      15 * 60_000,
      "stepTimeoutMs",
    );
    this.#toolTimeoutMs = boundedInteger(
      options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      100,
      this.#stepTimeoutMs,
      "toolTimeoutMs",
    );
    this.#searxngEndpoint = options.searxngEndpoint;
    this.#firecrawlEndpoint = options.firecrawlEndpoint;
    this.#webToolPort = options.webToolPort;
  }

  async run(request: BotAgentRequest): Promise<BotAgentFinalResult> {
    throwIfTurnAborted(request.signal);
    const agentStartedAtMs = Date.now();
    const traceContext = {
      turnId: request.turn.id,
      updateId: request.turn.updateId,
    };
    const turnSignal = request.signal;
    const now = this.#now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("now must return a valid Date");
    }
    const nonce = requireNonce(this.#nonceFactory());
    const baseMessages = buildTurnMessages(
      request,
      nonce,
      this.#contextCharLimit,
    );
    const researchMode = botResearchModeForText(request.trigger.text);
    const researchMinimumToolCalls = botResearchMinimumToolCalls(researchMode);
    const externalSourcesRequested = botExternalSourcesRequestedForText(
      request.trigger.text,
    );
    const memoryWriteAllowed =
      this.#memoryTools !== undefined &&
      this.#memoryTools.isWriteAuthorizer(request.trigger.senderId) &&
      botMemoryWriteAllowedForText(request.trigger.text);
    const folds: string[] = [];
    const carriedTools: CarriedToolResult[] = [];
    const toolEvidence: ReadToolEvidence[] = [];
    const readToolFailures: Array<{ name: string; code: string }> = [];
    const approvalOrder = new Map<string, number>();
    const usage = new TurnUsageAccumulator();
    let allowedExecutions = 0;
    let startedExecutions = 0;
    let startedReadExecutions = 0;
    let completedExecutions = 0;
    let deniedExecutions = 0;
    let requestedExecutions = 0;
    let researchQualityRetries = 0;
    let contextCompactions = 0;
    const imageTracker = this.#webToolPort?.imageTracker ?? createTurnImageTracker();
    const thinkingProgress = new ThinkingProgressTracker(
      request.toolProgressPort,
    );
    const mediaTools = this.#mediaTools;
    const photoTarget = mediaTools?.findPhoto(
      request.trigger,
      request.replyTarget,
    );
    const audioTarget = mediaTools?.findAudio(
      request.trigger,
      request.replyTarget,
    );
    let visionAttachmentPromise: ReturnType<BotMediaToolsPort["resolveVision"]> | undefined;
    const audioExecution = new AudioTranscriptionExecution({
      mediaTools,
      target: audioTarget,
      thinkingProgress,
      toolProgressPort: request.toolProgressPort,
      carriedTools,
      onStarted: () => { startedExecutions += 1; },
      onCompleted: () => { completedExecutions += 1; },
      getSequence: (callId) =>
        approvalOrder.get(callId) ?? allowedExecutions + carriedTools.length + 1,
      log: (level, event, fields) => this.#log(level, event, fields),
      traceContext,
    });

    const rememberFold = (boundary: "model" | "tool"): void => {
      const rendered = renderFoldBatch(request.drainFold(boundary));
      if (rendered) {
        folds.push(rendered);
      }
    };

    if (isDirectAudioTranscriptionRequest(request.trigger.text)) {
      // Explicit local transcription never sends the private transcript to a model.
      const directAudioCallId = `audio:auto:${request.turn.id}`;
      if (audioExecution.available) {
        allowedExecutions += 1;
        approvalOrder.set(directAudioCallId, allowedExecutions);
      }
      const directAudio = await audioExecution.runDirect({
        callId: directAudioCallId,
        signal: turnSignal,
      });
      usage.setFinalModel("flov", "local");
      usage.setExecutionStats({
        toolCalls: startedExecutions,
        durationMs: Math.max(0, Date.now() - agentStartedAtMs),
      });
      const final: BotAgentFinalResult = {
        kind: "final",
        text: renderDirectAudioTranscription(directAudio),
        telemetry: usage.build(),
        responseOrigin: "local_audio",
      };
      this.#log("info", "bot.agent.complete", {
        ...traceContext,
        candidate: "local:flov",
        attempt: 1,
        fallbackCount: 0,
        fallbackReasons: [],
        requestedToolCalls: requestedExecutions,
        allowedToolCalls: allowedExecutions,
        startedToolCalls: startedExecutions,
        startedReadToolCalls: startedReadExecutions,
        completedToolCalls: completedExecutions,
        deniedToolCalls: deniedExecutions,
        researchMode,
        memoryWriteAllowed,
        researchMinimumToolCalls,
        researchQualityRetries,
      });
      return final;
    }

    try {
      const routed = await this.#router.executeWithFallback(
        "turn",
        async (candidate, attemptNumber) => {
          throwIfTurnAborted(request.signal);
          let visionAttachment:
            | Awaited<ReturnType<BotMediaToolsPort["resolveVision"]>>
            | undefined;
          if (
            photoTarget !== undefined &&
            mediaTools !== undefined &&
            candidate.capabilities.vision
          ) {
            try {
              visionAttachmentPromise ??= mediaTools.resolveVision(
                photoTarget,
                turnSignal,
              );
              visionAttachment = await visionAttachmentPromise;
            } catch (error) {
              if (turnSignal.aborted) {
                throwIfTurnAborted(request.signal);
              }
              this.#log("warn", "bot.agent.vision_unavailable", {
                ...traceContext,
                candidate: candidate.reference,
                attempt: attemptNumber,
                code: safeErrorCode(error),
              });
            }
          }
          const candidateBaseMessages = visionAttachment === undefined
            ? baseMessages
            : withImageAttachment(baseMessages, visionAttachment);
          const instructions = buildBotSystemPrompt({
            ...this.#prompt,
            modelLabel: candidate.reference,
            now,
            memoryBlock:
              request.memoryBlock ?? this.#prompt.memoryBlock,
            memoryMaxChars: this.#prompt.memoryMaxChars,
            fastMemory: request.fastMemory,
            longTermLessons: request.longTermLessons,
            chatSkills: request.chatSkills,
            memoryToolsAvailable: this.#memoryTools !== undefined,
            memoryWriteAllowed,
            researchMode,
            imageAttached: photoTarget !== undefined,
            visionAvailable: candidate.capabilities.vision,
            imageDelivered: visionAttachment !== undefined,
            audioTranscriptionAvailable:
              audioExecution.available && !audioExecution.hasModelTranscription,
            botSenderId: this.#prompt.botSenderId,
            externalSourcesRequested,
          });
          const toolObserver = createBotToolExecutionObserver({
            traceContext,
            candidate: candidate.reference,
            attempt: attemptNumber,
            approvalOrder,
            carriedTools,
            toolEvidence,
            readToolFailures,
            toolProgressPort: request.toolProgressPort,
            onStarted: (execution) => {
              startedExecutions += 1;
              // Web tools count as read executions for research depth.
              if (execution.kind === "read" || execution.kind === "web") {
                startedReadExecutions += 1;
              }
            },
            finishThinking: () => thinkingProgress.finish(),
            onCompleted: () => {
              completedExecutions += 1;
            },
            log: (level, event, fields) => this.#log(level, event, fields),
          });
          let finalizationRequested = false;
          let lengthFinalizationRetries = 0;
          let emptyFinalRetries = 0;
          const { tools, toolOrder } = createBotToolSet({
            readTools: this.#readTools,
            memoryTools: this.#memoryTools,
            memoryWriteAllowed,
            audioTranscriptionAvailable:
              audioExecution.available && !audioExecution.hasModelTranscription,
            nonce,
            turnSignal,
            chatId: request.turn.chatId,
            sourceMessageId: request.trigger.messageId,
            senderId: request.trigger.senderId,
            visionAvailable: candidate.capabilities.vision,
            webToolPort: this.#webToolPort ?? createWebToolPort({
              searxngEndpoint: this.#searxngEndpoint,
              firecrawlEndpoint: this.#firecrawlEndpoint,
              imageTracker, nonce, turnSignal }),
            onExecutionStarted: toolObserver.onExecutionStarted,
            onExecutionCompleted: toolObserver.onExecutionCompleted,
            ...(!audioExecution.available || audioExecution.hasModelTranscription
              ? {}
              : {
                  runAudioTranscription: ({ callId, signal }) =>
                    audioExecution.runForModel({
                      callId,
                      signal,
                      candidate,
                      attempt: attemptNumber,
                    }),
                }),
          });

          try {
            let injectedImageCount = 0;
            while (true) {
              throwIfTurnAborted(request.signal);
              let foldCursor = folds.length;
              const activeInstructions = researchQualityRetries === 0
                ? instructions
                : researchContinuationInstructions(
                    instructions,
                    researchMinimumToolCalls,
                    startedReadExecutions,
                  );
              const attemptMessages = [
                ...candidateBaseMessages,
                ...folds.map(userMessage),
                ...renderCarriedToolMessages(carriedTools, nonce),
              ];
              const result = await generateText({
                model: candidate.model,
                providerOptions: candidate.providerOptions,
                instructions: activeInstructions,
                messages: attemptMessages,
                tools,
                toolOrder,
                // Qwen-compatible endpoint supports auto tool choice, not required.
                toolChoice: "auto",
                toolApproval: ({ toolCall }) => {
                  throwIfTurnAborted(request.signal);
                  requestedExecutions += 1;
                  rememberFold("tool");
                  allowedExecutions += 1;
                  approvalOrder.set(toolCall.toolCallId, allowedExecutions);
                  return "not-applicable";
                },
                prepareStep: async ({ messages }) => {
                  throwIfTurnAborted(request.signal);
                  rememberFold("model");
                  const newFolds = folds.slice(foldCursor);
                  foldCursor = folds.length;
                  // Inject fresh web images before the next model step.
                  const withFolds = newFolds.length === 0
                    ? messages
                    : [...messages, ...newFolds.map(userMessage)];
                  const injected = appendFreshWebImages(withFolds,
                    imageTracker, injectedImageCount, candidate.capabilities.vision, nonce);
                  injectedImageCount = injected.injectedCount;
                  const nextMessages = injected.messages;
                  const compacted = await compactModelContextIfNeeded({
                    model: candidate.model, providerOptions: candidate.providerOptions,
                    messages: nextMessages, signal: turnSignal,
                    contextCompactions, remainingMs: Number.MAX_SAFE_INTEGER,
                    toolLimitReached: false,
                  });
                  const compactedMessages = compacted.messages;
                  const contextChars = compacted.contextChars;
                  const contextTokens = compacted.contextTokens;
                  contextCompactions = compacted.compactionNumber ?? contextCompactions;
                  if (compacted.compactionNumber !== undefined)
                    this.#log("info", "bot.agent.context_compacted", { ...traceContext, candidate: candidate.reference, attempt: attemptNumber, compaction: contextCompactions, beforeChars: compacted.beforeChars, afterChars: contextChars, beforeTokens: compacted.beforeTokens, afterTokens: contextTokens });
                  if (compacted.error !== undefined)
                    this.#log("warn", "bot.agent.context_compaction_failed", { ...traceContext, candidate: candidate.reference, attempt: attemptNumber, code: safeErrorCode(compacted.error) });
                  const contextGuard = contextTokens >= MODEL_CONTEXT_FINALIZATION_TOKENS;
                  const forceFinal =
                    finalizationRequested || contextGuard;
                  if (forceFinal && !finalizationRequested) {
                    finalizationRequested = true;
                    this.#log("warn", "bot.agent.finalization_guard", {
                      ...traceContext,
                      candidate: candidate.reference,
                      attempt: attemptNumber,
                      reason: "context",
                      estimatedContextChars: contextChars,
                      estimatedContextTokens: contextTokens,
                    });
                  }
                  const finalizationInstructions =
                    `${activeInstructions}\n\n` +
                    "Сейчас обязательно верни полный финальный ответ по уже " +
                    "собранным данным. Новые инструменты не вызывай. Если " +
                    "каких-то данных не хватило, честно обозначь ограничение " +
                    "в самом ответе.";
                  return {
                    messages: compactedMessages,
                    ...(forceFinal
                      ? {
                          activeTools: [],
                          toolChoice: "none" as const,
                          instructions: finalizationInstructions,
                          maxOutputTokens: this.#maxOutputTokens,
                        }
                      : {
                          toolChoice: "auto" as const,
                          maxOutputTokens: this.#maxOutputTokens,
                        }),
                  };
                },
                // There is no whole-turn or model/tool-step count ceiling.
                // Each provider and tool operation remains independently bounded.
                stopWhen: () => false,
                maxRetries: 0,
                abortSignal: turnSignal,
                timeout: {
                  stepMs: this.#stepTimeoutMs,
                  toolMs: this.#toolTimeoutMs,
                },
                maxOutputTokens: this.#maxOutputTokens,
                include: {
                  requestBody: false,
                  requestMessages: false,
                  responseBody: false,
                },
                onStepStart: () => {
                  thinkingProgress.start();
                },
                onStepEnd: (step) => {
                  thinkingProgress.finish();
                  usage.recordStep({
                    modelId: step.response.modelId ?? candidate.modelId,
                    providerId: candidate.providerId,
                    inputTokens: step.usage.inputTokens,
                    outputTokens: step.usage.outputTokens,
                    totalTokens: step.usage.totalTokens,
                    reasoningTokens: extractReasoningTokens(step.usage),
                    reasoningMode: extractReasoningMode(step),
                  });
                  this.#log("info", "bot.agent.step", {
                    ...traceContext,
                    candidate: candidate.reference,
                    attempt: attemptNumber,
                    researchQualityRetry: researchQualityRetries,
                    stepNumber: step.stepNumber,
                    callId: step.callId,
                    finishReason: step.finishReason,
                    rawFinishReason: step.rawFinishReason,
                    responseId: step.response.id,
                    responseModelId: step.response.modelId,
                    inputTokens: step.usage.inputTokens,
                    outputTokens: step.usage.outputTokens,
                    totalTokens: step.usage.totalTokens,
                    responseTimeMs: step.performance.responseTimeMs,
                    stepTimeMs: step.performance.stepTimeMs,
                    toolCalls: step.toolCalls.length,
                    toolResults: step.toolResults.length,
                  });
                },
              });

              if (
                result.finishReason === "content-filter" ||
                result.steps.some(
                  (step) => step.finishReason === "content-filter",
                )
              ) {
                throw new ModelContentFilterError(
                  "Provider blocked the generated response.",
                );
              }
              if (
                result.finishReason === "length" &&
                result.toolCalls.length === 0 &&
                lengthFinalizationRetries < MAX_LENGTH_FINALIZATION_RETRIES
              ) {
                lengthFinalizationRetries += 1;
                finalizationRequested = true;
                this.#log("warn", "bot.agent.finalization_retry", {
                  ...traceContext,
                  candidate: candidate.reference,
                  attempt: attemptNumber,
                  retry: lengthFinalizationRetries,
                  finishReason: result.finishReason,
                });
                continue;
              }
              if (result.finishReason !== "stop") {
                throw new BotAgentProtocolError(
                  "incomplete_finish",
                  result.finishReason,
                  result.finishReason === "error" ||
                    result.finishReason === "other" ||
                    result.finishReason === "tool-calls",
                );
              }
              if (result.text.trim().length === 0) {
                if (emptyFinalRetries < MAX_EMPTY_FINAL_RETRIES) {
                  emptyFinalRetries += 1;
                  finalizationRequested = true;
                  this.#log("warn", "bot.agent.empty_final_retry", {
                    ...traceContext,
                    candidate: candidate.reference,
                    attempt: attemptNumber,
                    retry: emptyFinalRetries,
                    finishReason: result.finishReason,
                  });
                  continue;
                }
                throw new BotAgentProtocolError("empty_final");
              }
              const sanitizedText = sanitizeFinalText({
                text: result.text,
                toolEvidence,
                researchMode: researchMode === "research",
                readToolFailures,
                externalSourcesRequested,
              });
              if (sanitizedText.length === 0) {
                if (emptyFinalRetries < MAX_EMPTY_FINAL_RETRIES) {
                  emptyFinalRetries += 1;
                  finalizationRequested = true;
                  this.#log("warn", "bot.agent.empty_final_retry", {
                    ...traceContext,
                    candidate: candidate.reference,
                    attempt: attemptNumber,
                    retry: emptyFinalRetries,
                    finishReason: result.finishReason,
                    reason: "sanitized_empty",
                  });
                  continue;
                }
                throw new BotAgentProtocolError("empty_final");
              }
              if (
                researchMinimumToolCalls > startedReadExecutions &&
                researchQualityRetries < BOT_AGENT_CONTRACT.researchQualityRetries
              ) {
                researchQualityRetries += 1;
                this.#log("info", "bot.agent.research_depth_retry", {
                  ...traceContext,
                  candidate: candidate.reference,
                  attempt: attemptNumber,
                  retry: researchQualityRetries,
                  requiredReadToolCalls: researchMinimumToolCalls,
                  startedReadToolCalls: startedReadExecutions,
                });
                continue;
              }
              usage.setFinalModel(
                result.response.modelId ?? candidate.modelId,
                candidate.providerId,
                candidate.capabilities.contextWindowTokens,
              );
              usage.setExecutionStats({
                toolCalls: startedExecutions,
                durationMs: Math.max(0, Date.now() - agentStartedAtMs),
              });
              return {
                kind: "final" as const,
                text: sanitizedText,
                telemetry: usage.build(),
              };
            }
          } catch (error) {
            thinkingProgress.finish(false);
            if (turnSignal.aborted) {
              throwIfTurnAborted(request.signal);
            }
            if (isTimeoutError(error)) {
              throw modelStepTimeoutError();
            }
            throw error;
          }
        },
      );

      throwIfTurnAborted(request.signal);
      this.#log("info", "bot.agent.complete", {
        ...traceContext,
        candidate: routed.candidate.reference,
        attempt: routed.attempt,
        fallbackCount: routed.failures.length,
        fallbackReasons: routed.failures.map(
          ({ decision }) => decision.reason,
        ),
        requestedToolCalls: requestedExecutions,
        allowedToolCalls: allowedExecutions,
        startedToolCalls: startedExecutions,
        startedReadToolCalls: startedReadExecutions,
        completedToolCalls: completedExecutions,
        deniedToolCalls: deniedExecutions,
        researchMode,
        memoryWriteAllowed,
        researchMinimumToolCalls,
        researchQualityRetries,
      });
      return routed.value;
    } catch (error) {
      const routingAttemptReasons =
        error instanceof ModelRoutingError
          ? error.attempts.map((a) => a.decision.reason)
          : undefined;
      const routingCode =
        error instanceof ModelRoutingError
          ? error.code
          : undefined;
      const leafCode =
        error instanceof ModelRoutingError && error.cause != null
          ? safeErrorCode(error.cause)
          : undefined;
      this.#log("warn", "bot.agent.failed", {
        ...traceContext,
        requestedToolCalls: requestedExecutions,
        allowedToolCalls: allowedExecutions,
        startedToolCalls: startedExecutions,
        startedReadToolCalls: startedReadExecutions,
        completedToolCalls: completedExecutions,
        deniedToolCalls: deniedExecutions,
        code: safeErrorCode(error),
        ...(routingCode === undefined ? {} : { routingCode }),
        ...(routingAttemptReasons === undefined
          ? {}
          : { routingAttemptReasons }),
        ...(leafCode === undefined ? {} : { leafCode }),
        researchMode,
        memoryWriteAllowed,
        researchMinimumToolCalls,
        researchQualityRetries,
      });
      throw error;
    }
  }

  #log(
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...fields });
    } catch {
      // Observability is best-effort and must not alter the agent loop.
    }
  }
}
