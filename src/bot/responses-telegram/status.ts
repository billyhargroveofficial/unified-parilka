import type { CodexSubscriptionUsageSnapshot } from "../../openai-responses/codex-subscription-usage.js";

/** Current CodeX model-catalog context window for the code-owned Luna model. */
export const LUNA_CONTEXT_WINDOW_TOKENS = 272_000;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export interface ResponsesStatusFooter {
  readonly inputTokens?: number;
  readonly usage?: CodexSubscriptionUsageSnapshot;
  readonly nowMs?: number;
}

/** Trusted post-turn presentation; this text never enters a model request. */
export function renderResponsesStatusFooter(input: ResponsesStatusFooter): string {
  const context = input.inputTokens === undefined ? "?" : compactTokens(input.inputTokens);
  const usage = renderWeeklyUsage(selectWeeklyWindow(input.usage), input.nowMs ?? Date.now());
  return `\n\n*GPT-5.6 Luna Fast · ctx ${context}/${compactTokens(LUNA_CONTEXT_WINDOW_TOKENS)} ● ${usage}*`;
}

function selectWeeklyWindow(
  usage: CodexSubscriptionUsageSnapshot | undefined,
): CodexSubscriptionUsageSnapshot["primary"] {
  if (usage === undefined) return undefined;
  const windows = [usage.primary, usage.secondary];
  const exact = windows.find((window) => window?.windowSeconds === WEEKLY_WINDOW_SECONDS);
  if (exact !== undefined) return exact;
  // Older payloads omit `limit_window_seconds`. Their `secondary_window` was
  // historically the weekly bucket; retain that narrow fallback only for an
  // unknown duration, never for a known non-weekly primary bucket.
  return usage.secondary?.windowSeconds === undefined ? usage.secondary : undefined;
}

function renderWeeklyUsage(window: CodexSubscriptionUsageSnapshot["primary"], nowMs: number): string {
  if (window === undefined || window.usedPercent === undefined) return "7d —";
  const reset = window.resetAtMs === undefined ? "—" : compactRemaining(window.resetAtMs - nowMs);
  return `7d ${Math.round(window.usedPercent)}% ${reset}`;
}

function compactTokens(value: number): string {
  return value < 1_000 ? String(value) : `${Math.round(value / 1_000)}k`;
}

function compactRemaining(milliseconds: number): string {
  const totalHours = Math.max(0, Math.floor(milliseconds / 3_600_000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days}d${hours}h`;
  const minutes = Math.max(0, Math.floor((milliseconds % 3_600_000) / 60_000));
  return `${hours}h${minutes}m`;
}
