import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotAgentFinalResult } from "../src/bot/worker.js";
import {
  deferredFinal,
  final,
  makeFixture,
  turnStarted,
} from "./support/bot-worker.js";

test("lease heartbeat renews while agent runs and timers stop before publish", async (t) => {
  const fixture = makeFixture(t);
  const deferred = deferredFinal();
  let signal: AbortSignal | undefined;
  let publisherCalls = 0;
  const worker = fixture.worker({
    agent: (request) => {
      signal = request.signal;
      return deferred.promise;
    },
    publisher: async (request) => {
      assert.equal(fixture.scheduler.intervalCount, 0);
      assert.equal(fixture.scheduler.timeoutCount, 1);
      publisherCalls += 1;
      return { ok: true, chunksSent: 1 };
    },
  });

  const running = worker.runOnce();
  await turnStarted();
  const initialExpiry =
    fixture.store.getBotTurn(fixture.turnId)?.leaseExpiresAtMs ?? 0;
  assert.equal(publisherCalls, 0, "publisher cannot observe an unfinished agent result");
  fixture.clock.now += 500;
  fixture.scheduler.fireIntervals();
  const renewedExpiry =
    fixture.store.getBotTurn(fixture.turnId)?.leaseExpiresAtMs ?? 0;
  assert.ok(renewedExpiry > initialExpiry);
  assert.equal(signal?.aborted, false);

  deferred.resolve(final("Ответ после heartbeat"));
  assert.equal((await running).status, "sent");
  assert.equal(publisherCalls, 1);
});

test("lost lease aborts agent and can never reach publisher", async (t) => {
  const fixture = makeFixture(t);
  let observedSignal: AbortSignal | undefined;
  let publisherCalls = 0;
  const worker = fixture.worker({
    agent: ({ signal }) => {
      observedSignal = signal;
      return new Promise<BotAgentFinalResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    publisher: async () => {
      publisherCalls += 1;
      throw new Error("lost lease must not publish");
    },
  });

  const running = worker.runOnce();
  await turnStarted();
  fixture.clock.now += 1_001;
  fixture.scheduler.fireIntervals();
  const result = await running;

  assert.deepEqual(result, {
    status: "lease_lost",
    turnId: fixture.turnId,
  });
  assert.equal(observedSignal?.aborted, true);
  assert.equal(publisherCalls, 0);
  assert.equal(fixture.scheduler.activeCount, 0);
});

test("capacity is checked before durable claim", async (t) => {
  const fixture = makeFixture(t, { maxActiveTurns: 1 });
  fixture.coordinator.startTurn({
    turnId: "already-running",
    ownerSenderId: "someone",
  });
  let agentCalls = 0;
  const worker = fixture.worker({
    agent: async () => {
      agentCalls += 1;
      return final("не должен запуститься");
    },
    publisher: async () => {
      throw new Error("must not publish");
    },
  });

  assert.deepEqual(await worker.runOnce(), { status: "capacity" });
  assert.equal(agentCalls, 0);
  const turn = fixture.store.getBotTurn(fixture.turnId);
  assert.equal(turn?.status, "queued");
  assert.equal(turn?.attempts, 0);
});

test("worker completion removes only its coordinator turn", async (t) => {
  const fixture = makeFixture(t, {
    mode: "shadow",
    maxActiveTurns: 2,
  });
  fixture.coordinator.startTurn({
    turnId: "unrelated-turn",
    ownerSenderId: "other-owner",
  });
  const worker = fixture.worker({
    agent: async () => final("Теневой ответ"),
    publisher: async () => {
      throw new Error("shadow must not publish");
    },
  });

  assert.equal((await worker.runOnce()).status, "skipped");
  assert.ok(fixture.coordinator.getTurn("unrelated-turn"));
  assert.equal(fixture.coordinator.activeTurnCount, 1);
});
