/**
 * Per-turn model usage accumulation and telemetry footer rendering.
 *
 * The accumulator lives inside the agent loop and collects usage from every
 * completed model step across all provider attempts. Aggregate totals stay
 * internal diagnostics; the published footer only reports the current context
 * occupancy: the provider-reported input tokens of the LAST completed model
 * step (repeated/cached prefixes are neither summed nor subtracted) against
 * the final candidate's declared context window. The footer is appended to
 * the final model text before publication, so it passes through the same
 * rich-render and Telegram chunking pipeline.
 */

export interface StepUsageRecord {
  readonly modelId: string;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
}

export interface TurnTelemetry {
  readonly finalModelId: string;
  readonly finalProviderId: string;
  readonly reasoningMode: string | undefined;
  readonly steps: readonly StepUsageRecord[];
  /**
   * Aggregate input tokens across all completed steps. Internal diagnostics
   * only; it double-counts repeated context and is never rendered verbatim.
   */
  readonly totalInputTokens: number | undefined;
  readonly totalOutputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  /**
   * Current context occupancy: the provider-reported input tokens of the last
   * completed model step only. Rendered as the footer numerator.
   */
  readonly contextUsedTokens: number | undefined;
  /**
   * Declared context window of the successful final candidate, from exact
   * model-router capabilities metadata. Rendered as the footer denominator.
   */
  readonly contextWindowTokens: number | undefined;
  /** Number of tool executions that actually started during this turn. */
  readonly toolCalls: number;
  /** Wall-clock duration of the model/agent request, excluding publication. */
  readonly durationMs: number;
  /** True when at least one completed step did not report usage. */
  readonly incomplete: boolean;
}

export class TurnUsageAccumulator {
  readonly #steps: StepUsageRecord[] = [];
  #finalModelId = "";
  #finalProviderId = "";
  #finalContextWindowTokens: number | undefined;
  #reasoningMode: string | undefined;
  #toolCalls = 0;
  #durationMs = 0;

  recordStep(record: {
    modelId: string;
    providerId?: string;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
    reasoningTokens?: number | undefined;
    reasoningMode?: string | undefined;
  }): void {
    this.#steps.push({
      modelId: boundedString(record.modelId, 128),
      inputTokens: safeTokenCount(record.inputTokens),
      outputTokens: safeTokenCount(record.outputTokens),
      totalTokens: safeTokenCount(record.totalTokens),
      reasoningTokens: safeTokenCount(record.reasoningTokens),
    });
    if (record.providerId) {
      this.#finalProviderId = boundedString(record.providerId, 64);
    }
    if (record.reasoningMode) {
      this.#reasoningMode = boundedString(record.reasoningMode, 32);
    }
  }

  setFinalModel(
    modelId: string,
    providerId: string,
    contextWindowTokens?: number,
  ): void {
    this.#finalModelId = boundedString(modelId, 128);
    this.#finalProviderId = boundedString(providerId, 64);
    this.#finalContextWindowTokens = safePositiveTokenCount(
      contextWindowTokens,
    );
  }

  setExecutionStats(input: {
    toolCalls: number;
    durationMs: number;
  }): void {
    this.#toolCalls = safeNonNegativeInteger(input.toolCalls) ?? 0;
    this.#durationMs = safeNonNegativeInteger(input.durationMs) ?? 0;
  }

  build(): TurnTelemetry {
    let totalInput: number | undefined;
    let totalOutput: number | undefined;
    let totalAll: number | undefined;
    let incomplete = false;

    for (const step of this.#steps) {
      if (step.inputTokens === undefined) {
        incomplete = true;
      } else {
        totalInput = (totalInput ?? 0) + step.inputTokens;
      }
      if (step.outputTokens === undefined) {
        incomplete = true;
      } else {
        totalOutput = (totalOutput ?? 0) + step.outputTokens;
      }
      if (step.totalTokens === undefined) {
        incomplete = true;
      } else {
        totalAll = (totalAll ?? 0) + step.totalTokens;
      }
    }

    // Current occupancy is the LAST step's provider-reported input count only:
    // earlier steps re-send (largely) the same prefix, so summing them would
    // invent usage, and a post-compaction step must visibly lower the number.
    const lastStep = this.#steps[this.#steps.length - 1];

    return Object.freeze({
      finalModelId: this.#finalModelId || "unknown",
      finalProviderId: this.#finalProviderId || "unknown",
      reasoningMode: this.#reasoningMode,
      steps: Object.freeze([...this.#steps]),
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalAll,
      contextUsedTokens: lastStep?.inputTokens,
      contextWindowTokens: this.#finalContextWindowTokens,
      toolCalls: this.#toolCalls,
      durationMs: this.#durationMs,
      incomplete,
    });
  }
}

/**
 * Renders a compact, unobtrusive telemetry footer for the final answer.
 *
 * Format: `model 🧠 · contextUsed/contextWindow · tool calls · duration`,
 * e.g. `qwen3.8-max 🧠 · 15.2k/1.0m · 2 tool calls · 1м 3с`.
 *
 * The token pair is the current context occupancy — the last completed step's
 * provider-reported input tokens — over the final candidate's declared
 * context window. It is never cumulative input/output, and output tokens are
 * deliberately absent. Missing values are shown as `?` rather than invented.
 * The footer is plain text and follows the same publication path as the rest
 * of the answer.
 */
export function buildTelemetryFooter(telemetry: TurnTelemetry): string {
  const model = displayModelName(
    telemetry.finalModelId,
    telemetry.finalProviderId,
  );
  const used = formatTokens(telemetry.contextUsedTokens);
  const window = formatTokens(telemetry.contextWindowTokens);

  return `${model} 🧠 · ${used}/${window} · ${telemetry.toolCalls} tool calls · ${formatDuration(telemetry.durationMs)}`;
}

/** Extracts optional provider reasoning usage without trusting response shape. */
export function extractReasoningTokens(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const direct = safeTokenCount(record.reasoningTokens);
  if (direct !== undefined) {
    return direct;
  }
  const outputTokens = record.outputTokens;
  return typeof outputTokens === "object" && outputTokens !== null
    ? safeTokenCount((outputTokens as Record<string, unknown>).reasoning)
    : undefined;
}

/** Returns the internal telemetry flag; it is deliberately not user-visible. */
export function extractReasoningMode(step: unknown): string | undefined {
  if (typeof step !== "object" || step === null) {
    return undefined;
  }
  const usage = (step as Record<string, unknown>).usage;
  const reasoningTokens = extractReasoningTokens(usage);
  return reasoningTokens !== undefined && reasoningTokens > 0
    ? "on"
    : undefined;
}

function displayModelName(modelId: string, providerId: string): string {
  const model = modelId.trim() || "unknown";
  const providerPrefix = providerId.trim()
    ? `${providerId.trim()}/`
    : "";
  return providerPrefix && model.startsWith(providerPrefix)
    ? model.slice(providerPrefix.length) || "unknown"
    : model;
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) {
    return "?";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds}с`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}м ${seconds}с`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}ч ${minutes % 60}м`;
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function safePositiveTokenCount(value: unknown): number | undefined {
  const count = safeTokenCount(value);
  return count !== undefined && count > 0 ? count : undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function boundedString(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength
    ? trimmed.slice(0, maxLength)
    : trimmed;
}
