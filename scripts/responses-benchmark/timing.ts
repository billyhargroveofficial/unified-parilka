import { performance } from "node:perf_hooks";
import type {
  BenchmarkItemCategory,
  BenchmarkTimingEvent,
  BenchmarkTimingKind,
  BenchmarkUsage,
  BenchmarkWebAction,
} from "./contracts.js";

const NATIVE_EVENT_KINDS: Readonly<Record<string, BenchmarkTimingKind>> = Object.freeze({
  "thread.started": "native_thread_started",
  "turn.started": "native_turn_started",
  "item.started": "native_item_started",
  "item.completed": "native_item_completed",
  "turn.completed": "native_turn_completed",
  "turn.failed": "native_turn_failed",
});
const MAX_TIMING_EVENTS = 128;

export interface NativeTimingObservation {
  readonly kind: BenchmarkTimingKind;
  readonly itemCategory?: BenchmarkItemCategory;
  readonly webAction?: BenchmarkWebAction;
  readonly usage?: BenchmarkUsage;
}

/** A report recorder that stores no provider data beyond fixed event names. */
export class TimingRecorder {
  readonly #startedAt = performance.now();
  readonly #events: BenchmarkTimingEvent[] = [];
  #lastAtMs = 0;
  #droppedEvents = 0;

  event(kind: BenchmarkTimingKind): void {
    const atMs = Math.max(this.#lastAtMs, Math.round(performance.now() - this.#startedAt));
    this.#lastAtMs = atMs;
    if (this.#events.length < MAX_TIMING_EVENTS) this.#events.push({ kind, atMs });
    else this.#droppedEvents += 1;
  }

  durationMs(): number {
    return Math.max(this.#lastAtMs, Math.round(performance.now() - this.#startedAt));
  }

  events(): readonly BenchmarkTimingEvent[] {
    return [...this.#events];
  }

  droppedEvents(): number {
    return this.#droppedEvents;
  }
}

/**
 * Accept only fixed Codex JSONL envelope types. The raw JSONL line is neither
 * retained nor returned, so prompts, agent text, URLs, ids and stderr cannot
 * enter a report.
 */
export function nativeTimingObservation(line: string): NativeTimingObservation | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const kind = NATIVE_EVENT_KINDS[value.type];
  if (kind === undefined) return undefined;
  const item = isRecord(value.item) ? value.item : undefined;
  const itemCategory = item === undefined ? undefined : categoryFrom(item.type);
  const webAction = itemCategory === "web_search" ? actionFrom(item?.action) : undefined;
  const usage = kind === "native_turn_completed" ? usageFrom(value.usage) : undefined;
  return {
    kind,
    ...(itemCategory === undefined ? {} : { itemCategory }),
    ...(webAction === undefined ? {} : { webAction }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Retained as a narrow compatibility seam for timing-only callers. */
export function nativeTimingKind(line: string): BenchmarkTimingKind | undefined {
  return nativeTimingObservation(line)?.kind;
}

export class BoundedJsonlObserver {
  #pending = "";
  #droppingLine = false;
  readonly #decoder = new TextDecoder();
  readonly #onObservation: (observation: NativeTimingObservation) => void;
  readonly #maxLineChars: number;

  constructor(
    onObservation: (observation: NativeTimingObservation) => void,
    maxLineChars = 16 * 1024,
  ) {
    this.#onObservation = onObservation;
    this.#maxLineChars = maxLineChars;
  }

  push(chunk: Uint8Array): void {
    // Process bounded byte slices: a malformed CLI can never make us decode or
    // concatenate a huge JSONL chunk before the line cap takes effect.
    const sliceBytes = Math.max(1, Math.min(this.#maxLineChars, 8 * 1024));
    for (let offset = 0; offset < chunk.byteLength; offset += sliceBytes) {
      const slice = chunk.subarray(offset, Math.min(chunk.byteLength, offset + sliceBytes));
      this.#consume(this.#decoder.decode(slice, { stream: true }));
    }
  }

  finish(): void {
    this.#consume(this.#decoder.decode());
    if (!this.#droppingLine) this.#observe(this.#pending);
    this.#pending = "";
    this.#droppingLine = false;
  }

  #consume(text: string): void {
    if (this.#droppingLine) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      this.#droppingLine = false;
      text = text.slice(newline + 1);
    }
    this.#pending += text;
    for (;;) {
      const newline = this.#pending.indexOf("\n");
      if (newline < 0) break;
      const line = this.#pending.slice(0, newline);
      this.#pending = this.#pending.slice(newline + 1);
      this.#observe(line);
    }
    if (this.#pending.length > this.#maxLineChars) {
      this.#pending = "";
      this.#droppingLine = true;
    }
  }

  #observe(line: string): void {
    if (line.length > this.#maxLineChars) return;
    const observation = nativeTimingObservation(line);
    if (observation !== undefined) this.#onObservation(observation);
  }
}

function categoryFrom(value: unknown): BenchmarkItemCategory {
  // Native `codex exec --json` emits `web_search`; subscription Responses
  // terminal output calls the corresponding item `web_search_call`.
  if (value === "web_search" || value === "web_search_call") return "web_search";
  if (value === "reasoning") return "reasoning";
  if (value === "agent_message") return "agent_message";
  if (value === "command_execution") return "command_execution";
  return "other";
}

function actionFrom(value: unknown): BenchmarkWebAction {
  const action = isRecord(value) ? value.type : undefined;
  if (action === "search" || action === "open_page" || action === "find_in_page") return action;
  // Keep aliases explicit and test-only-driven. Unknown live spellings remain
  // `other` rather than being guessed into a successful fetch action.
  if (action === "open") return "open_page";
  if (action === "find") return "find_in_page";
  return "other";
}

function usageFrom(value: unknown): BenchmarkUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : undefined;
  const inputTokens = nonNegativeInteger(value.input_tokens);
  const cachedInputTokens = nonNegativeInteger(value.cached_input_tokens) ??
    nonNegativeInteger(inputDetails?.cached_tokens);
  const outputTokens = nonNegativeInteger(value.output_tokens);
  const reasoningOutputTokens = nonNegativeInteger(value.reasoning_output_tokens) ??
    nonNegativeInteger(outputDetails?.reasoning_tokens);
  const totalTokens = nonNegativeInteger(value.total_tokens) ?? safeTotal(inputTokens, outputTokens);
  if (inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined ||
    reasoningOutputTokens === undefined || totalTokens === undefined) return undefined;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeTotal(inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const total = inputTokens + outputTokens;
  return Number.isSafeInteger(total) ? total : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
