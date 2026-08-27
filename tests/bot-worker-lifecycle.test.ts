import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotAgentFinalResult } from "../src/bot/worker.js";
import { deferredFinal, final, makeFixture, turnStarted } from "./support/bot-worker.js";

test("heartbeat renews a running agent lease and stops before Bot API publishing", async (t) => {
  const fixture = makeFixture(t); const deferred = deferredFinal(); let intervalCountDuringPublish = -1;
  const running = fixture.worker({ agent: async () => deferred.promise, publisher: async () => { intervalCountDuringPublish = fixture.scheduler.intervalCount; return { ok: true, chunksSent: 1 }; } }).runOnce();
  await turnStarted(); const before = fixture.store.getBotTurn(fixture.turnId)?.leaseExpiresAtMs ?? 0; fixture.clock.now += 500; fixture.scheduler.fireIntervals();
  assert.ok((fixture.store.getBotTurn(fixture.turnId)?.leaseExpiresAtMs ?? 0) > before); deferred.resolve(final("готово")); await running;
  assert.equal(intervalCountDuringPublish, 0);
});

test("lost lease aborts agent and blocks publication", async (t) => {
  const fixture = makeFixture(t); let sent = 0; let observed: AbortSignal | undefined;
  const running = fixture.worker({ agent: ({ signal }) => { observed = signal; return new Promise<BotAgentFinalResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }, publisher: async () => { sent += 1; return { ok: true, chunksSent: 1 }; } }).runOnce();
  await turnStarted(); fixture.clock.now += 1_001; fixture.scheduler.fireIntervals();
  assert.equal((await running).status, "lease_lost"); assert.equal(observed?.aborted, true); assert.equal(sent, 0);
});
