import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatTypingLeaseManager, type TypingScheduler } from "../src/bot/typing.js";
import { BotUpdateProcessor } from "../src/bot/runtime.js";
import { TurnCoordinator } from "../src/bot/turn-coordinator.js";
import { BotTurnWorker } from "../src/bot/worker.js";
import type { MessageStore, StoredBotTurn } from "../src/store.js";
import { final, ManualScheduler, turnStarted, deferredFinal } from "./support/bot-worker.js";
import { TELEGRAM_OPTIONS, addressedUpdate, makeStore } from "./support/bot-runtime.js";

function typingScheduler(scheduler: ManualScheduler): TypingScheduler {
  return {
    setInterval: (callback) => scheduler.setInterval(callback),
    clearInterval: (handle) => scheduler.clearInterval(handle),
  };
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("queue typing starts on durable enqueue and one heartbeat spans a blocked successor", async (t) => {
  const store = makeStore(t);
  const scheduler = new ManualScheduler();
  const actions: string[] = [];
  const leases = new ChatTypingLeaseManager({
    port: { async sendChatAction(chatId) { actions.push(chatId); } },
    intervalMs: 4_000,
    scheduler: typingScheduler(scheduler),
  });
  let nowMs = 1_000;
  const processor = new BotUpdateProcessor({
    store,
    coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
    workNotifier: { notify() {} },
    typingLeases: leases,
    telegram: TELEGRAM_OPTIONS,
    now: () => nowMs,
  });
  const first = processor.process(addressedUpdate(100, 500));
  assert.equal(first.acknowledged && first.turnReserved, true);
  await drain();
  assert.deepEqual(actions, [TELEGRAM_OPTIONS.allowedChatId]);

  const firstAgent = deferredFinal();
  let calls = 0;
  const worker = new BotTurnWorker({
    store,
    coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
    agent: {
      async run() {
        calls += 1;
        return calls === 1 ? firstAgent.promise : final("Второй ответ");
      },
    },
    publisher: { async publish() { return { ok: true, chunksSent: 1, telegramMessageId: 77 }; } },
    workerId: "typing-test-worker",
    allowedChatId: TELEGRAM_OPTIONS.allowedChatId,
    mode: "live",
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    scheduler,
    now: () => nowMs,
    typingLeases: leases,
  });

  const firstRun = worker.runOnce();
  await turnStarted();
  nowMs += 6_000;
  const second = processor.process(addressedUpdate(101, 501));
  assert.equal(second.acknowledged && second.turnReserved, true);
  await drain();
  // The second durable turn joined the existing chat lease; it did not issue
  // a duplicate immediate sendChatAction while the first is running.
  assert.deepEqual(actions, [TELEGRAM_OPTIONS.allowedChatId]);

  scheduler.fireIntervals();
  await drain();
  assert.deepEqual(actions, [TELEGRAM_OPTIONS.allowedChatId, TELEGRAM_OPTIONS.allowedChatId]);

  firstAgent.resolve(final("Первый ответ"));
  assert.equal((await firstRun).status, "sent");
  // The first worker released its reference, but the queued second turn keeps
  // the same heartbeat alive until it is claimed and finishes.
  scheduler.fireIntervals();
  await drain();
  assert.equal(actions.length, 3);

  assert.equal((await worker.runOnce()).status, "sent");
  scheduler.fireIntervals();
  await drain();
  assert.equal(actions.length, 3);
});

test("stopAll aborts every queued chat heartbeat", async () => {
  const scheduler = new ManualScheduler();
  const actions: string[] = [];
  const leases = new ChatTypingLeaseManager({
    port: { async sendChatAction(chatId) { actions.push(chatId); } },
    scheduler: typingScheduler(scheduler),
  });

  leases.enqueue({ turnId: 1, chatId: "-10042" });
  await drain();
  leases.stopAll();
  scheduler.fireIntervals();
  await drain();
  assert.deepEqual(actions, ["-10042"]);
});

test("queue typing reports only the first safe presentation outcome", async () => {
  const scheduler = new ManualScheduler();
  const telemetry: string[] = [];
  const leases = new ChatTypingLeaseManager({
    port: { async sendChatAction() { throw Object.assign(new Error("private"), { code: "TELEGRAM_429" }); } },
    scheduler: typingScheduler(scheduler),
    onFirstSuccess: () => { telemetry.push("sent"); },
    onFirstFailure: (code) => { telemetry.push(`failed:${code}`); },
  });

  leases.enqueue({ turnId: 1, chatId: "-10042" });
  await drain();
  scheduler.fireIntervals();
  await drain();
  leases.stopAll();

  assert.deepEqual(telemetry, ["failed:TELEGRAM_429"]);
});

test("queue typing remains active while final publication awaits Telegram ACK", async (t) => {
  const store = makeStore(t);
  const scheduler = new ManualScheduler();
  const actions: string[] = [];
  const leases = new ChatTypingLeaseManager({
    port: { async sendChatAction(chatId) { actions.push(chatId); } },
    scheduler: typingScheduler(scheduler),
  });
  const processor = new BotUpdateProcessor({
    store,
    coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
    workNotifier: { notify() {} },
    typingLeases: leases,
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
  });
  processor.process(addressedUpdate(103, 503));
  await drain();

  let publisherStarted!: () => void;
  const started = new Promise<void>((resolve) => { publisherStarted = resolve; });
  let acknowledge!: () => void;
  const pendingAck = new Promise<void>((resolve) => { acknowledge = resolve; });
  const worker = new BotTurnWorker({
    store,
    coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
    agent: { async run() { return final("Готово"); } },
    publisher: { async publish() {
      publisherStarted();
      await pendingAck;
      return { ok: true, chunksSent: 1, telegramMessageId: 78 };
    } },
    workerId: "typing-publish-worker",
    allowedChatId: TELEGRAM_OPTIONS.allowedChatId,
    mode: "live",
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    scheduler,
    now: () => 1_000,
    typingLeases: leases,
  });
  const run = worker.runOnce();
  await started;
  const beforeAck = actions.length;
  scheduler.fireIntervals();
  await drain();
  assert.equal(actions.length, beforeAck + 1);

  acknowledge();
  assert.equal((await run).status, "sent");
  scheduler.fireIntervals();
  await drain();
  assert.equal(actions.length, beforeAck + 1);
});

test("coordinator rejection releases the queue typing lease after durable claim", async (t) => {
  const store = makeStore(t);
  const scheduler = new ManualScheduler();
  const actions: string[] = [];
  const leases = new ChatTypingLeaseManager({
    port: { async sendChatAction(chatId) { actions.push(chatId); } },
    scheduler: typingScheduler(scheduler),
  });
  const coordinator = new TurnCoordinator({ maxActiveTurns: 2 });
  const processor = new BotUpdateProcessor({
    store,
    coordinator,
    workNotifier: { notify() {} },
    typingLeases: leases,
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
  });
  processor.process(addressedUpdate(102, 502));
  const turn = store.getBotTurnByTrigger(TELEGRAM_OPTIONS.allowedChatId, 502);
  assert.ok(turn);
  await drain();
  assert.deepEqual(actions, [TELEGRAM_OPTIONS.allowedChatId]);

  // Leave one free slot for the pre-claim check, but reserve the same durable
  // id so `startTurn` reaches its terminal duplicate-id rejection path.
  assert.equal(
    coordinator.startTurn({ turnId: String(turn.id), ownerSenderId: "other" }).accepted,
    true,
  );
  const worker = new BotTurnWorker({
    store,
    coordinator,
    agent: { async run() { assert.fail("agent must not run"); } },
    publisher: { async publish() { assert.fail("publisher must not run"); } },
    workerId: "typing-reject-worker",
    allowedChatId: TELEGRAM_OPTIONS.allowedChatId,
    mode: "live",
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    scheduler,
    now: () => 1_000,
    typingLeases: leases,
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "failed",
    turnId: turn.id,
    stage: "coordinator",
  });
  scheduler.fireIntervals();
  await drain();
  assert.deepEqual(actions, [TELEGRAM_OPTIONS.allowedChatId]);
});

test("chat-scope rejection releases by turn id without a foreign typing action", async () => {
  const scheduler = new ManualScheduler();
  const actions: string[] = [];
  const leases = new ChatTypingLeaseManager({
    port: { async sendChatAction(chatId) { actions.push(chatId); } },
    scheduler: typingScheduler(scheduler),
  });
  const foreignTurn: StoredBotTurn = {
    id: 777,
    updateId: 777,
    chatId: "-100999",
    triggerMessageId: 7,
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    leaseOwner: "corrupt-owner",
    leaseExpiresAtMs: 9_999,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const store = {
    claimNextBotTurn: () => foreignTurn,
    markBotTurnSkipped: () => true,
  } as unknown as MessageStore;

  // Simulate an old queued lease established for the only allowed chat. A
  // corrupt row returned by the store must release it by turn id, not move it
  // to the row's foreign chat id.
  leases.enqueue({ turnId: foreignTurn.id, chatId: TELEGRAM_OPTIONS.allowedChatId });
  await drain();
  const worker = new BotTurnWorker({
    store,
    coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
    agent: { async run() { assert.fail("agent must not run"); } },
    publisher: { async publish() { assert.fail("publisher must not run"); } },
    workerId: "typing-scope-worker",
    allowedChatId: TELEGRAM_OPTIONS.allowedChatId,
    mode: "live",
    leaseMs: 1_000,
    heartbeatMs: 100,
    scheduler,
    now: () => 1_000,
    typingLeases: leases,
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "skipped",
    turnId: foreignTurn.id,
    reason: "chat_scope",
  });
  scheduler.fireIntervals();
  await drain();
  assert.equal(actions.includes(foreignTurn.chatId), false);
  assert.deepEqual(actions, [TELEGRAM_OPTIONS.allowedChatId]);
});
