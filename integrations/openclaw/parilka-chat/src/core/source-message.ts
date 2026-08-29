import { MAX_SAFE_TELEGRAM_ID, type TurnIdentity } from "./types.js";

const STATE_TTL_MS = 60 * 60_000;
const STATE_MAX_ENTRIES = 128;

interface LedgerEntry {
  identity: TurnIdentity;
  ts: number;
  toolCalls: number;
}

function prune(store: Map<string, LedgerEntry>, now: number): void {
  for (const [key, entry] of store) {
    if (now - entry.ts > STATE_TTL_MS) store.delete(key);
  }
  const overflow = store.size - STATE_MAX_ENTRIES;
  if (overflow <= 0) return;
  const oldest = [...store.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .slice(0, overflow);
  for (const [key] of oldest) store.delete(key);
}

export function parseTelegramMessageId(raw: unknown): number | undefined {
  if (typeof raw === "boolean") return undefined;
  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed)) return undefined;
    value = parsed;
  } else {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_SAFE_TELEGRAM_ID) {
    return undefined;
  }
  return value;
}

export function ledgerKey(sessionKey?: string, runId?: string): string | undefined {
  return ledgerKeys(sessionKey, runId)[0];
}

export function ledgerKeys(sessionKey?: string, runId?: string): string[] {
  const keys: string[] = [];
  if (runId && runId.trim()) keys.push(`run:${runId.trim()}`);
  if (sessionKey && sessionKey.trim()) keys.push(`session:${sessionKey.trim()}`);
  return keys;
}

export function chatIdFromSessionKey(sessionKey: string | undefined): string {
  if (!sessionKey) return "";
  const match = /telegram:group:(-?\d+)/u.exec(sessionKey);
  return match?.[1] ?? "";
}

export class SourceMessageLedger {
  readonly #store = new Map<string, LedgerEntry>();
  #latest: LedgerEntry | undefined;

  capture(identity: TurnIdentity, now = Date.now()): void {
    const keys = ledgerKeys(identity.sessionKey, identity.runId);
    if (keys.length === 0) return;
    prune(this.#store, now);
    const existing = keys.map((key) => this.#store.get(key)).find(Boolean);
    const sameTurn = existing?.identity.messageId === identity.messageId;
    const entry: LedgerEntry = {
      identity,
      ts: sameTurn && existing ? existing.ts : now,
      toolCalls: sameTurn ? (existing?.toolCalls ?? 0) : 0,
    };
    for (const key of keys) this.#store.set(key, entry);
    this.#latest = entry;
  }

  remember(sessionKey: string | undefined, runId: string | undefined): TurnIdentity | undefined {
    prune(this.#store, Date.now());
    const hit = this.#lookup(sessionKey, runId)?.identity;
    if (hit) return hit;
    if (sessionKey || runId) return undefined;
    return this.#latest?.identity;
  }

  recordToolCall(sessionKey: string | undefined, runId: string | undefined): number {
    const entry = this.#lookup(sessionKey, runId);
    if (!entry) return 0;
    entry.toolCalls += 1;
    entry.ts = Date.now();
    return entry.toolCalls;
  }

  toolCalls(sessionKey: string | undefined, runId: string | undefined): number {
    return this.#lookup(sessionKey, runId)?.toolCalls ?? 0;
  }

  startedAt(sessionKey: string | undefined, runId: string | undefined): number | undefined {
    return this.#lookup(sessionKey, runId)?.ts;
  }

  #lookup(sessionKey: string | undefined, runId: string | undefined): LedgerEntry | undefined {
    for (const key of ledgerKeys(sessionKey, runId)) {
      const entry = this.#store.get(key);
      if (entry) return entry;
    }
    return undefined;
  }
}
