import assert from "node:assert/strict";
import { test } from "node:test";
import { final, makeFixture, waitUntil } from "./support/bot-worker.js";

test("definitive Telegram rejection follows its retryable classification", async (t) => {
  const fixture = makeFixture(t);
  const result = await fixture.worker({ agent: async () => final("ответ"), publisher: async () => ({ ok: false, chunksSent: 0, error: { kind: "telegram_rejected", code: "TELEGRAM_400", retryable: false } }) }).runOnce();
  assert.deepEqual(result, { status: "dispatch_rejected", turnId: fixture.turnId, retryable: false });
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "dead_letter");
});

test("ambiguous network delivery remains lost_ack and is never retried automatically", async (t) => {
  const fixture = makeFixture(t);
  const result = await fixture.worker({ agent: async () => final("ответ"), publisher: async () => ({ ok: false, chunksSent: 0, error: { kind: "network", code: "ECONNRESET" } }) }).runOnce();
  assert.deepEqual(result, { status: "lost_ack", turnId: fixture.turnId });
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "lost_ack");
});

test("publish deadline aborts a hung Bot API request", async (t) => {
  const fixture = makeFixture(t); let signal: AbortSignal | undefined;
  const running = fixture.worker({ agent: async () => final("ответ"), publisher: ({ signal: value }) => { signal = value; return new Promise<never>(() => {}); } }).runOnce();
  await waitUntil(() => fixture.store.getBotTurn(fixture.turnId)?.status === "sending"); fixture.scheduler.fireTimeouts();
  assert.equal((await running).status, "lost_ack"); assert.equal(signal?.aborted, true);
});
