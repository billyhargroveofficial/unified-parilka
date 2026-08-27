import {
  CodexSubscriptionAuthStore,
  CodexSubscriptionResponsesTransport,
  OpenAiResponsesTurnClient,
  ResponsesTurnTimeoutError,
  type ResponsesProgressEvent,
  type RunResponsesTurnRequest,
} from "../../src/openai-responses/index.js";
import type { BenchmarkArmReport, BenchmarkScenario, BenchmarkWebAction, LiveBenchmarkOptions } from "./contracts.js";
import { acceptedOutcome } from "./acceptance.js";
import { TimingRecorder } from "./timing.js";

type DirectTurnClient = Pick<OpenAiResponsesTurnClient, "run">;

const DIRECT_INSTRUCTIONS = [
  "You are a benchmark arm. Answer the user directly and concisely in Russian.",
  "Use hosted web only when it is available or explicitly required by the host.",
  "Do not call local functions; none are available.",
].join(" ");

export async function runDirectResponsesArm(
  options: Pick<LiveBenchmarkOptions, "authFile" | "effort">,
  scenario: BenchmarkScenario,
  client: DirectTurnClient = createDirectResponsesClient(options.authFile),
): Promise<BenchmarkArmReport> {
  const timing = new TimingRecorder();
  const lifecycle = new DirectWebLifecycle();
  timing.event("started");
  try {
    const result = await client.run(directRequest(options.effort, scenario, timing, (event) => lifecycle.observe(event)));
    const usage = result.aggregateUsage ?? result.usage;
    const usageScope = result.aggregateUsage === undefined ? "final_leg" : "aggregate";
    timing.event("completed");
    let report: BenchmarkArmReport = {
      outcome: "completed",
      durationMs: timing.durationMs(),
      hostedWebCalls: result.hostedWebCalls,
      ...(usage === undefined ? {} : { usage, usageScope }),
      ...(lifecycle.webActions(result.hostedWebCalls) === undefined ? {} : { webActions: lifecycle.webActions(result.hostedWebCalls) }),
      actionFidelity: "exact",
      events: timing.events(),
      droppedTimingEvents: timing.droppedEvents(),
    };
    const accepted = acceptedOutcome(scenario, "direct_responses", report);
    if (accepted !== "completed") {
      timing.event(accepted);
      report = { ...report, outcome: accepted, durationMs: timing.durationMs(), events: timing.events(), droppedTimingEvents: timing.droppedEvents() };
    }
    return report;
  } catch (error) {
    const outcome = error instanceof ResponsesTurnTimeoutError ? "timed_out" : "failed";
    timing.event(outcome);
    return { outcome, durationMs: timing.durationMs(), events: timing.events(), droppedTimingEvents: timing.droppedEvents() };
  }
}

export function directRequest(
  effort: LiveBenchmarkOptions["effort"],
  scenario: BenchmarkScenario,
  timing: TimingRecorder,
  onHostedWebEvent?: (event: Extract<ResponsesProgressEvent, { type: "hosted_web_started" | "hosted_web_action" | "hosted_web_completed" }>) => void,
): RunResponsesTurnRequest {
  return {
    text: scenario.prompt,
    instructions: DIRECT_INSTRUCTIONS,
    effort,
    timeoutMs: 180_000,
    localFunctions: [],
    dispatcher: { async dispatch() { throw new Error("No local benchmark tools are registered."); } },
    ...(scenario.hostedWebPolicy === undefined ? {} : { hostedWebSearchPolicy: scenario.hostedWebPolicy }),
    progress: {
      onProgress(event) {
        if (event.type === "thinking_started") timing.event("thinking_started");
        if (event.type === "thinking_completed") timing.event("thinking_completed");
        if (event.type === "hosted_web_started") {
          onHostedWebEvent?.(event);
          timing.event("hosted_web_started");
        }
        if (event.type === "hosted_web_action") onHostedWebEvent?.(event);
        if (event.type === "hosted_web_completed") {
          onHostedWebEvent?.(event);
          timing.event("hosted_web_completed");
        }
      },
    },
  };
}

/** One benchmark creates this once and shares it across direct arm runs. */
export function createDirectResponsesClient(authFile: string): OpenAiResponsesTurnClient {
  return new OpenAiResponsesTurnClient(new CodexSubscriptionResponsesTransport({
    auth: new CodexSubscriptionAuthStore({ authFile }),
    originator: "parilka-responses-benchmark",
    userAgent: "parilka-responses-benchmark/1.0",
  }));
}

export class DirectWebLifecycle {
  readonly #calls = new Map<string, { action?: BenchmarkWebAction; completed: boolean }>();

  observe(event: Extract<ResponsesProgressEvent, { type: "hosted_web_started" | "hosted_web_action" | "hosted_web_completed" }>): void {
    const call = this.#calls.get(event.callId) ?? { completed: false };
    if (event.type === "hosted_web_started" && event.action !== undefined) call.action = event.action;
    if (event.type === "hosted_web_action") call.action = event.action;
    if (event.type === "hosted_web_completed") call.completed = true;
    this.#calls.set(event.callId, call);
  }

  webActions(totalHostedWebCalls: number): Partial<Record<BenchmarkWebAction, number>> | undefined {
    const counts: Partial<Record<BenchmarkWebAction, number>> = {};
    let completed = 0;
    for (const call of this.#calls.values()) {
      if (!call.completed) continue;
      completed += 1;
      increment(counts, call.action ?? "other");
    }
    for (let missing = Math.max(0, totalHostedWebCalls - completed); missing > 0; missing -= 1) increment(counts, "other");
    return Object.keys(counts).length === 0 ? undefined : counts;
  }
}

function increment<Key extends string>(counts: Partial<Record<Key, number>>, key: Key): void {
  counts[key] = (counts[key] ?? 0) + 1;
}
