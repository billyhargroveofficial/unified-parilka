import type { ResponsesReasoningEffort } from "../../src/openai-responses/contracts.js";

export const BENCHMARK_TIMEOUT_MS = 180_000;
export const BENCHMARK_MODEL = "gpt-5.6-luna" as const;
export const BENCHMARK_SERVICE_TIER = "priority" as const;

export type BenchmarkScenarioId = "ordinary" | "web" | "fetch" | "research";
export type BenchmarkArm = "direct_responses" | "native_codex";
export type BenchmarkOutcome = "completed" | "failed" | "timed_out" | "invalid" | "unverifiable";
export type BenchmarkItemCategory = "web_search" | "reasoning" | "agent_message" | "command_execution" | "other";
export type BenchmarkWebAction = "search" | "open_page" | "find_in_page" | "other";
export type BenchmarkTimingKind =
  | "started"
  | "thinking_started"
  | "thinking_completed"
  | "hosted_web_started"
  | "hosted_web_completed"
  | "native_thread_started"
  | "native_turn_started"
  | "native_item_started"
  | "native_item_completed"
  | "native_turn_completed"
  | "native_turn_failed"
  | "completed"
  | "failed"
  | "timed_out"
  | "invalid"
  | "unverifiable";

export interface BenchmarkTimingEvent {
  readonly kind: BenchmarkTimingKind;
  /** Monotonic milliseconds relative to this arm's own start. */
  readonly atMs: number;
}

/** Numeric provider accounting only; no model text or opaque metadata. */
export interface BenchmarkUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface BenchmarkArmReport {
  readonly outcome: BenchmarkOutcome;
  readonly durationMs: number;
  readonly hostedWebCalls?: number;
  readonly usage?: BenchmarkUsage;
  /** Direct stateless legs may expose only the final leg's accounting. */
  readonly usageScope?: "aggregate" | "final_leg";
  readonly itemCategories?: Readonly<Partial<Record<BenchmarkItemCategory, number>>>;
  readonly webActions?: Readonly<Partial<Record<BenchmarkWebAction, number>>>;
  /** Native CLI JSONL does not expose open/find semantic detail reliably. */
  readonly actionFidelity?: "exact" | "limited";
  /** Strict allowlist: no provider payload, ids, text, URLs, or stderr. */
  readonly events: readonly BenchmarkTimingEvent[];
  readonly droppedTimingEvents: number;
}

export interface BenchmarkRunReport {
  readonly scenario: BenchmarkScenarioId;
  readonly repetition: number;
  /** Alternates sequence only; it does not make different connection models equal. */
  readonly order: readonly BenchmarkArm[];
  readonly directResponses: BenchmarkArmReport;
  readonly nativeCodex: BenchmarkArmReport;
}

export interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly model: typeof BENCHMARK_MODEL;
  readonly serviceTier: typeof BENCHMARK_SERVICE_TIER;
  readonly effort: ResponsesReasoningEffort;
  readonly timeoutMs: typeof BENCHMARK_TIMEOUT_MS;
  readonly scenarios: readonly BenchmarkScenarioId[];
  readonly repetitions: number;
  readonly methodology: BenchmarkMethodology;
  readonly runs: readonly BenchmarkRunReport[];
}

export interface BenchmarkMethodology {
  readonly directArm: "minimal_direct_responses_no_telegram";
  readonly nativeArm: "fresh_codex_exec_process";
  readonly connectionMode: "direct_reused_transport_client_vs_native_fresh_process";
  readonly armOrder: "alternating_sequence_effect_distribution_only";
  readonly nativeActionFidelity: "limited_cli_jsonl_omits_open_find_semantics";
  readonly nativeCliVersion?: string;
}

export interface BenchmarkScenario {
  readonly id: BenchmarkScenarioId;
  /** Trusted fixture input. It is deliberately excluded from every report. */
  readonly prompt: string;
  readonly hostedWebPolicy?: "required_first_leg" | "bounded_research";
}

export interface LiveBenchmarkOptions {
  readonly authFile: string;
  readonly codexBin: string;
  readonly scenarios: readonly BenchmarkScenarioId[];
  readonly repetitions: number;
  readonly effort: ResponsesReasoningEffort;
}

export class BenchmarkConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkConfigurationError";
  }
}
