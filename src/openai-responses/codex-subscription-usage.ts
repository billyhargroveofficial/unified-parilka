import type { CodexSubscriptionAuthStore } from "./codex-subscription-auth.js";

export const CODEX_SUBSCRIPTION_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const DEFAULT_USAGE_TIMEOUT_MS = 1_500;
const DEFAULT_USAGE_CACHE_TTL_MS = 60_000;
const MAX_USAGE_RESPONSE_BYTES = 64 * 1024;

export interface CodexSubscriptionUsageWindow {
  readonly usedPercent?: number;
  readonly resetAtMs?: number;
  readonly windowSeconds?: number;
}

export interface CodexSubscriptionUsageSnapshot {
  readonly primary?: CodexSubscriptionUsageWindow;
  readonly secondary?: CodexSubscriptionUsageWindow;
}

export interface CodexSubscriptionUsageClientOptions {
  readonly auth: Pick<CodexSubscriptionAuthStore, "snapshot">;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly usageUrl?: string;
}

/** Account quota is optional UI data: it can never fail or delay a model turn. */
export class CodexSubscriptionUsageClient {
  readonly #auth: Pick<CodexSubscriptionAuthStore, "snapshot">;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #usageUrl: string;
  #cached: { readonly snapshot: CodexSubscriptionUsageSnapshot | undefined; readonly fetchedAtMs: number } | undefined;
  #inFlight: Promise<CodexSubscriptionUsageSnapshot | undefined> | undefined;

  constructor(options: CodexSubscriptionUsageClientOptions) {
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = boundedPositiveInteger(options.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS, "timeoutMs", 10_000);
    this.#cacheTtlMs = boundedPositiveInteger(options.cacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS, "cacheTtlMs", 300_000);
    this.#usageUrl = requiredHttpsUrl(options.usageUrl ?? CODEX_SUBSCRIPTION_USAGE_URL);
  }

  /** Cached or stale data returns immediately; a refresh is bounded and deduplicated. */
  async get(): Promise<CodexSubscriptionUsageSnapshot | undefined> {
    const cached = this.#cached;
    if (cached !== undefined) {
      if (this.#now() - cached.fetchedAtMs > this.#cacheTtlMs) void this.#refresh();
      return cached.snapshot;
    }
    return this.#refresh();
  }

  #refresh(): Promise<CodexSubscriptionUsageSnapshot | undefined> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const refresh = this.#load();
    this.#inFlight = refresh;
    void refresh.finally(() => {
      if (this.#inFlight === refresh) this.#inFlight = undefined;
    });
    return refresh;
  }

  async #load(): Promise<CodexSubscriptionUsageSnapshot | undefined> {
    try {
      const auth = await this.#auth.snapshot();
      const response = await this.#fetch(this.#usageUrl, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
          "User-Agent": "parilka-unified/1.0",
          ...(auth.accountId === undefined ? {} : { "ChatGPT-Account-ID": auth.accountId }),
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) return this.#cacheUnknown();
      const snapshot = parseCodexSubscriptionUsage(await readBoundedText(response, MAX_USAGE_RESPONSE_BYTES), this.#now());
      if (snapshot === undefined) return this.#cacheUnknown();
      this.#cached = { snapshot, fetchedAtMs: this.#now() };
      return snapshot;
    } catch {
      return this.#cacheUnknown();
    }
  }

  #cacheUnknown(): CodexSubscriptionUsageSnapshot | undefined {
    // Quota is advisory UI. A transient auth/network/parse failure must not
    // erase the last confirmed account window and turn a useful footer into
    // `7d —`; retain it while backing off the next refresh by the normal TTL.
    const lastKnownGood = this.#cached?.snapshot;
    this.#cached = { snapshot: lastKnownGood, fetchedAtMs: this.#now() };
    return lastKnownGood;
  }
}

export function parseCodexSubscriptionUsage(body: string, nowMs: number): CodexSubscriptionUsageSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const windows = record(record(parsed)?.rate_limit);
  if (windows === undefined) return undefined;
  const primary = parseWindow(windows.primary_window, nowMs);
  const secondary = parseWindow(windows.secondary_window, nowMs);
  return primary === undefined && secondary === undefined
    ? undefined
    : { ...(primary === undefined ? {} : { primary }), ...(secondary === undefined ? {} : { secondary }) };
}

function parseWindow(value: unknown, nowMs: number): CodexSubscriptionUsageWindow | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
  const used = finiteNumber(source.used_percent);
  const windowSeconds = positiveInteger(source.limit_window_seconds);
  const resetAtSeconds = positiveInteger(source.reset_at);
  const resetAfterSeconds = nonNegativeInteger(source.reset_after_seconds);
  const resetAtMs = resetAtSeconds === undefined
    ? resetAfterSeconds === undefined ? undefined : nowMs + resetAfterSeconds * 1_000
    : resetAtSeconds * 1_000;
  if (used === undefined && windowSeconds === undefined && resetAtMs === undefined) return undefined;
  return {
    ...(used === undefined ? {} : { usedPercent: Math.min(100, Math.max(0, used)) }),
    ...(resetAtMs === undefined ? {} : { resetAtMs }),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
  };
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return body + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) return "";
      body += decoder.decode(next.value, { stream: true });
    }
  } finally {
    try { await reader.cancel(); } catch { /* bounded best-effort cleanup */ }
  }
}

function requiredHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("usageUrl must be a canonical HTTPS URL without credentials, query, or fragment.");
  }
  return url.href;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
