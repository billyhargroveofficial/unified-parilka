import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { TurnCoordinator } from "../../src/bot/turn-coordinator.js";
import {
  BotTurnWorker,
  type BotAgentFinalResult,
  type BotAgentRequest,
  type BotTurnPublisher,
  type WorkerScheduler,
} from "../../src/bot/worker.js";
import { MessageStore, type StoredMessage } from "../../src/store.js";
import type { ChatInfo } from "../../src/telegram/types.js";

export const CHAT: ChatInfo = { chatId: "-1004242", requested: "-1004242", title: "Parilka", kind: "supergroup" };
export const TRIGGER_ID = 1_000;

export function final(text: string): BotAgentFinalResult {
  return { kind: "final", text, telemetry: { finalModelId: "gpt-5.6-luna", finalProviderId: "openai-responses", reasoningMode: "low", steps: [], toolCalls: 0, durationMs: 0, incomplete: false } };
}

export function makeFixture(t: TestContext, options: { mode?: "live" | "shadow"; maxActiveTurns?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "parilka-worker-"));
  const store = new MessageStore(join(directory, "cache.sqlite"));
  const coordinator = new TurnCoordinator({ maxActiveTurns: options.maxActiveTurns ?? 1 });
  const scheduler = new ManualScheduler();
  const clock = { now: 100_000 };
  const ingested = store.ingestBotUpdate({ updateId: 77, rawJson: "{\"update_id\":77}", chat: CHAT, message: message(TRIGGER_ID, "@bot trigger", "owner"), addressed: true, maxAttempts: 3, nowMs: clock.now });
  const turnId = ingested.turn!.id;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    store, coordinator, scheduler, clock, turnId,
    worker(overrides: { agent: (request: BotAgentRequest) => Promise<BotAgentFinalResult>; publisher: BotTurnPublisher["publish"] }): BotTurnWorker {
      return new BotTurnWorker({ store, coordinator, agent: { run: overrides.agent }, publisher: { publish: overrides.publisher }, workerId: "test-worker", allowedChatId: CHAT.chatId, mode: options.mode ?? "live", leaseMs: 1_000, heartbeatMs: 100, scheduler, now: () => clock.now });
    },
  };
}

export class ManualScheduler implements WorkerScheduler {
  #next = 1; #intervals = new Map<number, () => void>(); #timeouts = new Map<number, () => void>();
  get activeCount(): number { return this.#intervals.size + this.#timeouts.size; }
  get intervalCount(): number { return this.#intervals.size; }
  get timeoutCount(): number { return this.#timeouts.size; }
  setInterval(callback: () => void): unknown { const id = this.#next++; this.#intervals.set(id, callback); return id; }
  clearInterval(handle: unknown): void { this.#intervals.delete(Number(handle)); }
  setTimeout(callback: () => void): unknown { const id = this.#next++; this.#timeouts.set(id, callback); return id; }
  clearTimeout(handle: unknown): void { this.#timeouts.delete(Number(handle)); }
  fireIntervals(): void { for (const callback of [...this.#intervals.values()]) callback(); }
  fireTimeouts(): void { for (const callback of [...this.#timeouts.values()]) callback(); }
}

export function message(messageId: number, text: string, senderName: string): StoredMessage {
  return { chatId: CHAT.chatId, messageId, date: "2026-07-30T12:00:00.000Z", senderId: senderName === "owner" ? "42" : `id:${senderName}`, senderName, text };
}

export function deferredFinal(): { promise: Promise<BotAgentFinalResult>; resolve(value: BotAgentFinalResult): void } {
  let resolve!: (value: BotAgentFinalResult) => void;
  const promise = new Promise<BotAgentFinalResult>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function turnStarted(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }
export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) { if (predicate()) return; await Promise.resolve(); }
  assert.fail("condition did not become true");
}
