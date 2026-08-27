import type { ResponsesUsage, RunResponsesTurnRequest } from "./contracts.js";

/** Explicit research is intentionally deeper than ordinary chat, but bounded. */
export const TARGET_SUCCESSFUL_HOSTED_WEB_CALLS = 4;
export const MIN_SYNTHESIS_HOSTED_WEB_CALLS = 3;
const MAX_REQUIRED_RESEARCH_LEGS = 4;
const MAX_EVIDENCE_PHASE_MS = 120_000;
const MIN_SYNTHESIS_RESERVE_MS = 1_000;
const CONTINUATION = [
  "Application research controller: continue the same task before finalizing.",
  "The total target is four successful distinct hosted web actions. Use hosted web now only for a missing evidence gap; do not repeat earlier queries merely to increase the count.",
  "Prioritize current availability/prices, an open_page/find_in_page check of a relevant market or primary source, ownership risks, and an independent comparison.",
  "As soon as the total reaches four successful actions, stop calling web and return one revised, self-contained final answer with citations, not a search log.",
].join(" ");

export function shouldRequireHostedWeb(options: {
  request: RunResponsesTurnRequest;
  firstLeg: boolean;
  successfulHostedWebCalls: number;
  requiredResearchLegs: number;
}): boolean {
  if (options.request.hostedWebSearchPolicy === "required_first_leg") return options.firstLeg;
  return options.request.hostedWebSearchPolicy === "bounded_research" &&
    options.successfulHostedWebCalls < TARGET_SUCCESSFUL_HOSTED_WEB_CALLS &&
    options.requiredResearchLegs < MAX_REQUIRED_RESEARCH_LEGS;
}

export function shouldContinueBoundedResearch(
  request: RunResponsesTurnRequest,
  successfulHostedWebCalls: number,
  requiredResearchLegs: number,
): boolean {
  return request.hostedWebSearchPolicy === "bounded_research" &&
    successfulHostedWebCalls < TARGET_SUCCESSFUL_HOSTED_WEB_CALLS &&
    requiredResearchLegs < MAX_REQUIRED_RESEARCH_LEGS;
}

export function shouldSynthesizeBoundedResearch(
  request: RunResponsesTurnRequest,
  successfulHostedWebCalls: number,
  attemptedHostedWebCalls: number,
): boolean {
  return request.hostedWebSearchPolicy === "bounded_research" &&
    successfulHostedWebCalls >= MIN_SYNTHESIS_HOSTED_WEB_CALLS &&
    successfulHostedWebCalls < TARGET_SUCCESSFUL_HOSTED_WEB_CALLS &&
    attemptedHostedWebCalls >= TARGET_SUCCESSFUL_HOSTED_WEB_CALLS;
}

export function researchContinuationInput(successfulHostedWebCalls: number): Record<string, unknown> {
  const remaining = Math.max(1, TARGET_SUCCESSFUL_HOSTED_WEB_CALLS - successfulHostedWebCalls);
  return {
    role: "developer",
    content: [{
      type: "input_text",
      text: `${CONTINUATION} Exactly ${String(remaining)} additional distinct hosted web action${remaining === 1 ? " is" : "s are"} still required to reach the target of four.`,
    }],
  };
}

export function researchSynthesisInput(
  successfulHostedWebCalls: number,
  attemptedHostedWebCalls: number,
): Record<string, unknown> {
  const unavailable = Math.max(0, attemptedHostedWebCalls - successfulHostedWebCalls);
  return {
    role: "developer",
    content: [{
      type: "input_text",
      text: [
        `Application research controller: the hosted-web evidence phase completed ${String(successfulHostedWebCalls)} successful action${successfulHostedWebCalls === 1 ? "" : "s"} across ${String(attemptedHostedWebCalls)} attempt${attemptedHostedWebCalls === 1 ? "" : "s"}.`,
        unavailable === 0
          ? "The target evidence completed successfully."
          : `${String(unavailable)} slow, failed, or redundant hosted action${unavailable === 1 ? " was" : "s were"} cut off by the bounded host policy; use the completed evidence and state material uncertainty rather than retrying.`,
        "Tools are intentionally disabled for this finalization leg. Do not request more research and do not mention this handoff.",
        "Synthesize one self-contained final answer from the captured evidence, preserve supported citations, state material uncertainty, and do not output a search log.",
      ].join(" "),
    }],
  };
}

/** Reserve part of the logical turn for a tool-free max-effort synthesis leg. */
export function researchEvidencePhaseTimeoutMs(totalTimeoutMs: number): number {
  const reserve = Math.min(60_000, Math.max(MIN_SYNTHESIS_RESERVE_MS, Math.floor(totalTimeoutMs / 3)));
  return Math.min(MAX_EVIDENCE_PHASE_MS, totalTimeoutMs - reserve);
}

/** A single slow fourth action must not consume the synthesis reserve. */
export function researchStalledActionGraceMs(evidencePhaseTimeoutMs: number): number {
  return Math.min(20_000, Math.max(100, Math.floor(evidencePhaseTimeoutMs / 6)));
}

export function researchSynthesisRequest(request: RunResponsesTurnRequest): RunResponsesTurnRequest {
  const { hostedWebSearchPolicy: _policy, localFunctions: _functions, ...rest } = request;
  return { ...rest, hostedWebSearch: false, localFunctions: [] };
}

export function hasInsufficientBoundedResearchCoverage(
  request: RunResponsesTurnRequest,
  successfulHostedWebCalls: number,
  requiredResearchLegs: number,
): boolean {
  return request.hostedWebSearchPolicy === "bounded_research" &&
    requiredResearchLegs >= MAX_REQUIRED_RESEARCH_LEGS &&
    successfulHostedWebCalls < TARGET_SUCCESSFUL_HOSTED_WEB_CALLS;
}

export function addResponsesUsage(current: ResponsesUsage | undefined, next: ResponsesUsage): ResponsesUsage {
  if (current === undefined) return next;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    cachedInputTokens: current.cachedInputTokens + next.cachedInputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens + next.reasoningOutputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
  };
}
