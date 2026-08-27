import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  type LocalFunctionCall,
  type ResponsesCitation,
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
import {
  addResponsesUsage,
  hasInsufficientBoundedResearchCoverage,
  researchEvidencePhaseTimeoutMs,
  researchLegTimeoutMs,
  researchNoProgressTimeoutMs,
  researchStalledActionGraceMs,
  researchContinuationInput,
  researchSynthesisInput,
  researchSynthesisRequest,
  shouldContinueBoundedResearch,
  shouldRequireHostedWeb,
  shouldSynthesizeBoundedResearch,
  MIN_SYNTHESIS_HOSTED_WEB_CALLS,
  TARGET_SUCCESSFUL_HOSTED_WEB_CALLS,
} from "./research-policy.js";
import {
  citationsFrom,
  citationsFromWebEvidence,
  functionCallsFrom,
  hasHostedWebSearchCall,
  responseOutputInput,
  usageFrom,
  webProgressFingerprint,
  webSearchItem,
} from "./response-output.js";
import {
  assertFunctionResult,
  assertTurnRequest,
  boundedFunctionCalls,
  boundedTimeout,
  createRequest,
  userInput,
} from "./request.js";
import {
  assertCompletedResponseAdmission,
  awaitWithAbort,
  joinSignals,
  nextWithAbort,
  progress,
  type CompletedResponseAdmission,
} from "./stream-control.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_FUNCTION_CALLS = 8;
/** Bound all local-function continuations within one Telegram turn. */
const MAX_TOTAL_FUNCTION_OUTPUT_CHARS = 96_000;
/** Never leak or partially truncate an over-budget host result into a model leg. */
const FUNCTION_OUTPUT_BUDGET_ERROR = "Local function output omitted: Responses turn output budget exhausted.";

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
    assertTurnRequest(request);
    const timeoutMs = boundedTimeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxFunctionCalls = boundedFunctionCalls(request.maxFunctionCalls ?? DEFAULT_MAX_FUNCTION_CALLS);
    const timeout = new AbortController();
    const signal = joinSignals(request.signal, timeout.signal);
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    const evidenceTimeoutMs = request.hostedWebSearchPolicy === "bounded_research"
      ? researchEvidencePhaseTimeoutMs(timeoutMs)
      : undefined;
    const stalledResearchActionGraceMs = evidenceTimeoutMs === undefined
      ? undefined
      : researchStalledActionGraceMs(evidenceTimeoutMs);
    const boundedResearchLegTimeoutMs = evidenceTimeoutMs === undefined
      ? undefined
      : researchLegTimeoutMs(timeoutMs);
    const evidenceTimeout = new AbortController();
    let evidenceTimer = evidenceTimeoutMs === undefined
      ? undefined
      : setTimeout(() => evidenceTimeout.abort(), evidenceTimeoutMs);
    evidenceTimer?.unref();
    let input = userInput(request.text, request.image);
    let activeRequest = request;
    let collectingResearchEvidence = evidenceTimeoutMs !== undefined;
    let firstLeg = true;
    let functionCalls = 0;
    const hostedWebCallIds = new Set<string>();
    const openPageAttemptCallIds = new Set<string>();
    const successfulHostedWebEvidenceKeys = new Set<string>();
    const evidenceCitations = new Map<string, ResponsesCitation>();
    const rememberEvidenceCitations = (...groups: readonly (readonly ResponsesCitation[])[]): void => {
      for (const group of groups) {
        for (const citation of group) {
          if (!evidenceCitations.has(citation.url) && evidenceCitations.size < 12) {
            evidenceCitations.set(citation.url, citation);
          }
        }
      }
    };
    let requiredResearchLegs = 0;
    let legCount = 0;
    let aggregateUsage: ResponsesUsage | undefined;
    let aggregateUsageComplete = true;
    let functionOutputChars = 0;
    try {
      for (;;) {
        const requireHostedWeb = shouldRequireHostedWeb({
          request: activeRequest,
          firstLeg,
          successfulHostedWebCalls: successfulHostedWebEvidenceKeys.size,
          hasOpenPageAttempt: openPageAttemptCallIds.size > 0,
          requiredResearchLegs,
        });
        if (requireHostedWeb && activeRequest.hostedWebSearchPolicy === "bounded_research") {
          requiredResearchLegs += 1;
        }
        const leg = await this.#runLeg({
          request: activeRequest,
          input,
          requireHostedWeb,
          signal,
          evidenceSignal: collectingResearchEvidence ? evidenceTimeout.signal : undefined,
          stalledResearchActionGraceMs,
          researchLegTimeoutMs: boundedResearchLegTimeoutMs,
          researchNoProgressTimeoutMs: boundedResearchLegTimeoutMs === undefined
            ? undefined
            : researchNoProgressTimeoutMs(boundedResearchLegTimeoutMs),
          hostedWebAttemptsBeforeLeg: hostedWebCallIds.size,
          openPageAttemptsBeforeLeg: new Set(openPageAttemptCallIds),
          successfulEvidenceBeforeLeg: new Set(successfulHostedWebEvidenceKeys),
          maxFunctionCalls,
          captureResearchEvidence: collectingResearchEvidence,
        });
        for (const callId of leg.hostedWebCallIds) hostedWebCallIds.add(callId);
        for (const callId of leg.openPageAttemptCallIds) openPageAttemptCallIds.add(callId);
        for (const key of leg.successfulHostedWebEvidenceKeys) successfulHostedWebEvidenceKeys.add(key);
        if (leg.kind === "research_evidence") {
          rememberEvidenceCitations(citationsFromWebEvidence(leg.output));
          if (successfulHostedWebEvidenceKeys.size < MIN_SYNTHESIS_HOSTED_WEB_CALLS) {
            throw new ResponsesTurnError("Responses research evidence handoff fell below its strict coverage floor.");
          }
          aggregateUsageComplete = false;
          if (evidenceTimer !== undefined) clearTimeout(evidenceTimer);
          evidenceTimer = undefined;
          collectingResearchEvidence = false;
          input = [
            ...input,
            ...responseOutputInput(leg.output),
            researchSynthesisInput(successfulHostedWebEvidenceKeys.size, hostedWebCallIds.size),
          ];
          activeRequest = researchSynthesisRequest(request);
          firstLeg = false;
          continue;
        }
        legCount += 1;
        const legUsage = usageFrom(leg.response);
        if (legUsage === undefined) {
          aggregateUsageComplete = false;
        } else {
          aggregateUsage = addResponsesUsage(aggregateUsage, legUsage);
        }
        const functions = functionCallsFrom(leg.response.output);
        const legCitations = citationsFrom(leg.response);
        rememberEvidenceCitations(legCitations, citationsFromWebEvidence(leg.response.output));
        if (functions.length === 0) {
          const text = leg.response.output_text;
          if (shouldSynthesizeBoundedResearch(
            activeRequest,
            successfulHostedWebEvidenceKeys.size,
            hostedWebCallIds.size,
            openPageAttemptCallIds.size > 0,
          )) {
            if (evidenceTimer !== undefined) clearTimeout(evidenceTimer);
            evidenceTimer = undefined;
            collectingResearchEvidence = false;
            input = [
              ...input,
              ...responseOutputInput(leg.response.output),
              researchSynthesisInput(successfulHostedWebEvidenceKeys.size, hostedWebCallIds.size),
            ];
            activeRequest = researchSynthesisRequest(request);
            firstLeg = false;
            continue;
          }
          if (shouldContinueBoundedResearch(
            activeRequest,
            successfulHostedWebEvidenceKeys.size,
            openPageAttemptCallIds.size > 0,
            requiredResearchLegs,
          )) {
            input = [
              ...input,
              ...responseOutputInput(leg.response.output),
              researchContinuationInput(successfulHostedWebEvidenceKeys.size, openPageAttemptCallIds.size > 0),
            ];
            firstLeg = false;
            continue;
          }
          if (hasInsufficientBoundedResearchCoverage(
            activeRequest,
            successfulHostedWebEvidenceKeys.size,
            openPageAttemptCallIds.size > 0,
            requiredResearchLegs,
          )) {
            throw new ResponsesTurnError("Responses bounded research exhausted before sufficient hosted-web coverage.");
          }
          if (text.length === 0) throw new ResponsesTurnError("Responses completed without final text.");
          return {
            responseId: leg.response.id,
            model: leg.model,
            text,
            annotations: legCitations.length > 0 ? legCitations : [...evidenceCitations.values()],
            functionCalls,
            completed: true,
            finishStatus: "completed",
            ...(legUsage === undefined ? {} : { usage: legUsage }),
            ...(legCount > 1 && aggregateUsageComplete && aggregateUsage !== undefined
              ? { aggregateUsage }
              : {}),
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
          activeRequest,
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
      if (collectingResearchEvidence && evidenceTimeout.signal.aborted && evidenceTimeoutMs !== undefined) {
        throw new ResponsesTurnTimeoutError(evidenceTimeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (evidenceTimer !== undefined) clearTimeout(evidenceTimer);
    }
  }

  async #runLeg(options: {
    request: RunResponsesTurnRequest;
    input: readonly Record<string, unknown>[];
    requireHostedWeb: boolean;
    signal: AbortSignal;
    evidenceSignal?: AbortSignal;
    stalledResearchActionGraceMs?: number;
    researchLegTimeoutMs?: number;
    researchNoProgressTimeoutMs?: number;
    hostedWebAttemptsBeforeLeg: number;
    openPageAttemptsBeforeLeg: ReadonlySet<string>;
    successfulEvidenceBeforeLeg: ReadonlySet<string>;
    maxFunctionCalls: number;
    captureResearchEvidence: boolean;
  }): Promise<{
    kind: "completed";
    response: Response;
    model: CompletedResponseAdmission["model"];
    serviceTier: CompletedResponseAdmission["serviceTier"];
    hostedWebCallIds: readonly string[];
    openPageAttemptCallIds: readonly string[];
    successfulHostedWebEvidenceKeys: readonly string[];
  } | {
    kind: "research_evidence";
    output: readonly ResponseOutputItem[];
    hostedWebCallIds: readonly string[];
    openPageAttemptCallIds: readonly string[];
    successfulHostedWebEvidenceKeys: readonly string[];
  }> {
    const legAbort = new AbortController();
    const legSignal = AbortSignal.any([
      options.signal,
      legAbort.signal,
      ...(options.evidenceSignal === undefined ? [] : [options.evidenceSignal]),
    ]);
    const thinkingCallId = `thinking:${crypto.randomUUID()}`;
    let thinking = true;
    const activeWebSearches = new Set<string>();
    const startedWebSearches = new Set<string>();
    const completedWebSearches = new Set<string>();
    const strictSuccessfulWebEvidenceKeys = new Set<string>();
    const totalSuccessfulWebEvidenceKeys = new Set(options.successfulEvidenceBeforeLeg);
    const openPageAttemptCallIds = new Set(options.openPageAttemptsBeforeLeg);
    const capturedOutput: ResponseOutputItem[] = [];
    const capturedOutputIds = new Set<string>();
    const announcedWebDetails = new Map<string, string>();
    let stalledResearchActionDeadlineReached = false;
    let researchLegDeadlineReached = false;
    let researchNoProgressDeadlineReached = false;
    let researchLegTimer: ReturnType<typeof setTimeout> | undefined;
    let researchNoProgressTimer: ReturnType<typeof setTimeout> | undefined;
    let guardedResearchCallId: string | undefined;
    let stalledResearchActionTimer: ReturnType<typeof setTimeout> | undefined;
    const researchEvidence = (): {
      kind: "research_evidence";
      output: readonly ResponseOutputItem[];
      hostedWebCallIds: readonly string[];
      openPageAttemptCallIds: readonly string[];
      successfulHostedWebEvidenceKeys: readonly string[];
    } => ({
      kind: "research_evidence",
      output: capturedOutput,
      hostedWebCallIds: [...startedWebSearches],
      openPageAttemptCallIds: [...openPageAttemptCallIds],
      successfulHostedWebEvidenceKeys: [...strictSuccessfulWebEvidenceKeys],
    });
    const armResearchNoProgressDeadline = (): void => {
      if (options.researchNoProgressTimeoutMs === undefined) return;
      if (researchNoProgressTimer !== undefined) clearTimeout(researchNoProgressTimer);
      researchNoProgressTimer = setTimeout(() => {
        researchNoProgressDeadlineReached = true;
        legAbort.abort();
      }, options.researchNoProgressTimeoutMs);
      researchNoProgressTimer.unref();
    };
    const armResearchLegDeadline = (): void => {
      if (options.researchLegTimeoutMs === undefined) return;
      researchLegTimer = setTimeout(() => {
        researchLegDeadlineReached = true;
        legAbort.abort();
      }, options.researchLegTimeoutMs);
      researchLegTimer.unref();
      armResearchNoProgressDeadline();
    };
    const recordOpenPageAttempt = (callId: string, action: ResponsesWebAction | undefined): void => {
      if (action === "open_page") openPageAttemptCallIds.add(callId);
    };
    const captureResearchOutput = (item: ResponseOutputItem): void => {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string") {
        if (capturedOutputIds.has(id)) return;
        capturedOutputIds.add(id);
      }
      capturedOutput.push(item);
    };
    const clearGuardedResearchAction = (callId: string): void => {
      if (guardedResearchCallId !== callId || stalledResearchActionTimer === undefined) return;
      clearTimeout(stalledResearchActionTimer);
      stalledResearchActionTimer = undefined;
      guardedResearchCallId = undefined;
    };
    const maybeArmStalledResearchAction = (): void => {
      if (!options.captureResearchEvidence || options.stalledResearchActionGraceMs === undefined ||
        stalledResearchActionTimer !== undefined ||
        totalSuccessfulWebEvidenceKeys.size < MIN_SYNTHESIS_HOSTED_WEB_CALLS ||
        options.hostedWebAttemptsBeforeLeg + startedWebSearches.size <
          TARGET_SUCCESSFUL_HOSTED_WEB_CALLS) return;
      const activeCallId = activeWebSearches.values().next().value as string | undefined;
      if (activeCallId === undefined) return;
      guardedResearchCallId = activeCallId;
      stalledResearchActionTimer = setTimeout(() => {
        stalledResearchActionDeadlineReached = true;
        legAbort.abort();
      }, options.stalledResearchActionGraceMs);
      stalledResearchActionTimer.unref();
    };
    const completeThinking = async (ok: boolean): Promise<void> => {
      if (!thinking) return;
      thinking = false;
      await progress(options.request, { type: "thinking_completed", callId: thinkingCallId, ok }, legSignal);
    };
    const startWebSearch = async (
      callId: string,
      action?: ResponsesWebAction,
      input?: ResponsesWebProgressInput,
      batchSize?: number,
      completedOk = true,
    ): Promise<void> => {
      const announced = webProgressFingerprint(action ?? "search", input, batchSize);
      recordOpenPageAttempt(callId, action);
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
            ...(batchSize === undefined ? {} : { batchSize }),
          }, legSignal);
          await progress(options.request, {
            type: "hosted_web_completed", callId, ok: completedOk,
          }, legSignal);
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
          ...(batchSize === undefined ? {} : { batchSize }),
        }, legSignal);
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
            ...(batchSize === undefined ? {} : { batchSize }),
          }, legSignal);
        }
      }
      maybeArmStalledResearchAction();
    };
    const completeWebSearch = async (callId: string, ok: boolean): Promise<void> => {
      if (completedWebSearches.has(callId)) return;
      await startWebSearch(callId);
      activeWebSearches.delete(callId);
      completedWebSearches.add(callId);
      await progress(options.request, { type: "hosted_web_completed", callId, ok }, legSignal);
    };
    let iterator: AsyncIterator<ResponseStreamEvent> | undefined;
    armResearchLegDeadline();
    // This is deliberately before the awaited HTTP create: Telegram gets an
    // immediate status even while the upstream connection is being established.
    await progress(options.request, { type: "thinking_started", callId: thinkingCallId }, legSignal);
    try {
      if (legSignal.aborted) throw new ResponsesTurnCancelledError();
      const stream = await awaitWithAbort(this.#transport.create(
        createRequest(
          options.request,
          options.input,
          options.requireHostedWeb,
          options.maxFunctionCalls,
        ),
        { signal: legSignal },
      ), legSignal);
      let completed: Response | undefined;
      let completedAdmission: CompletedResponseAdmission | undefined;
      iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await nextWithAbort(iterator, legSignal);
        if (next.done) break;
        armResearchNoProgressDeadline();
        const event = next.value;
        if (event.type === "response.web_search_call.in_progress" || event.type === "response.web_search_call.searching") {
          await completeThinking(true);
          await startWebSearch(event.item_id);
        } else if (event.type === "response.web_search_call.completed") {
          await completeWebSearch(event.item_id, true);
        } else if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
          const web = webSearchItem(event.item);
          if (event.type === "response.output_item.done" && options.captureResearchEvidence &&
            web === undefined && event.item.type === "reasoning") {
            captureResearchOutput(event.item);
          }
          if (web !== undefined) {
            await completeThinking(true);
            await startWebSearch(web.callId, web.action, web.input, web.batchSize, web.ok);
            if (event.type === "response.output_item.done") {
              await completeWebSearch(web.callId, web.ok);
              if (web.ok) {
                const evidenceKey = webProgressFingerprint(web.action ?? "search", web.input);
                strictSuccessfulWebEvidenceKeys.add(evidenceKey);
                totalSuccessfulWebEvidenceKeys.add(evidenceKey);
                if (options.captureResearchEvidence) captureResearchOutput(event.item);
                clearGuardedResearchAction(web.callId);
                if (options.captureResearchEvidence &&
                  totalSuccessfulWebEvidenceKeys.size >= TARGET_SUCCESSFUL_HOSTED_WEB_CALLS) {
                  if (openPageAttemptCallIds.size === 0) continue;
                  legAbort.abort();
                  for (const activeCallId of [...activeWebSearches]) {
                    await completeWebSearch(activeCallId, false);
                  }
                  return researchEvidence();
                }
              }
              if (options.captureResearchEvidence && !web.ok) clearGuardedResearchAction(web.callId);
              if (options.captureResearchEvidence &&
                options.hostedWebAttemptsBeforeLeg + startedWebSearches.size >=
                  TARGET_SUCCESSFUL_HOSTED_WEB_CALLS &&
                  totalSuccessfulWebEvidenceKeys.size >= MIN_SYNTHESIS_HOSTED_WEB_CALLS) {
                  if (openPageAttemptCallIds.size === 0) continue;
                  legAbort.abort();
                for (const activeCallId of [...activeWebSearches]) {
                  await completeWebSearch(activeCallId, false);
                }
                return researchEvidence();
              }
              maybeArmStalledResearchAction();
            }
          }
        } else if (event.type === "response.completed") {
          // A `response.completed` event is not sufficient admission by itself:
          // reject a substituted model or a degraded effective tier before any
          // response from this leg can seed a local-function continuation.
          completedAdmission = assertCompletedResponseAdmission(event.response);
          if (options.requireHostedWeb && !hasHostedWebSearchCall(event.response.output)) {
            throw new ResponsesTurnError("Responses required hosted web_search on this leg but did not return a web call.");
          }
          completed = event.response;
          // Some transports omit granular web stream events. The terminal
          // output still contains hosted call records, so project those into
          // the same safe Telegram lifecycle rather than hiding a real tool.
          await completeThinking(true);
          for (const item of event.response.output) {
            const web = webSearchItem(item);
            if (web === undefined) continue;
            await startWebSearch(web.callId, web.action, web.input, web.batchSize, web.ok);
            await completeWebSearch(web.callId, web.ok);
            if (web.ok) {
              const evidenceKey = webProgressFingerprint(web.action ?? "search", web.input);
              strictSuccessfulWebEvidenceKeys.add(evidenceKey);
              totalSuccessfulWebEvidenceKeys.add(evidenceKey);
            }
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
        kind: "completed",
        response: completed,
        ...completedAdmission,
        hostedWebCallIds: [...startedWebSearches],
        openPageAttemptCallIds: [...openPageAttemptCallIds],
        successfulHostedWebEvidenceKeys: [...strictSuccessfulWebEvidenceKeys],
      };
    } catch (error) {
      await completeThinking(false);
      for (const callId of [...activeWebSearches]) {
        await completeWebSearch(callId, false);
      }
      if (options.signal.aborted) throw error;
      if (researchLegDeadlineReached || researchNoProgressDeadlineReached) {
        if (options.captureResearchEvidence && totalSuccessfulWebEvidenceKeys.size >= MIN_SYNTHESIS_HOSTED_WEB_CALLS &&
          openPageAttemptCallIds.size > 0) {
          return researchEvidence();
        }
        throw new ResponsesTurnError(`Responses bounded research ${options.captureResearchEvidence ? "evidence" : "synthesis"} leg stalled before completion.`);
      }
      if (!options.signal.aborted &&
        (stalledResearchActionDeadlineReached || options.evidenceSignal?.aborted === true) &&
        totalSuccessfulWebEvidenceKeys.size >= MIN_SYNTHESIS_HOSTED_WEB_CALLS && openPageAttemptCallIds.size > 0) {
        return researchEvidence();
      }
      throw error;
    } finally {
      if (stalledResearchActionTimer !== undefined) clearTimeout(stalledResearchActionTimer);
      if (researchLegTimer !== undefined) clearTimeout(researchLegTimer);
      if (researchNoProgressTimer !== undefined) clearTimeout(researchNoProgressTimer);
      try {
        const closing = iterator?.return?.();
        if (closing !== undefined) void Promise.resolve(closing).catch(() => {});
      } catch { /* aborting a stream is best effort and must never delay the turn */ }
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

function parseFunctionCall(call: ResponseFunctionToolCall): LocalFunctionCall {
  try {
    return { callId: call.call_id, name: call.name, arguments: JSON.parse(call.arguments) };
  } catch {
    return { callId: call.call_id, name: call.name, arguments: undefined };
  }
}
