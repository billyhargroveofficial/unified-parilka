import assert from "node:assert/strict";
import { test } from "node:test";
import { BotTurnWorker } from "../src/bot/worker.js";
import { DEFAULT_PROGRESS_MIN_VISIBLE_MS } from "../src/bot/tool-progress.js";
import { CHAT, final, makeFixture, message } from "./support/bot-worker.js";

test("worker persists draft and publishes a generic BotTurnAgent final", async (t) => {
  const fixture = makeFixture(t); let published = "";
  const result = await fixture.worker({ agent: async () => final("Ответ Luna"), publisher: async ({ publication }) => { published = publication.plainText; return { ok: true, chunksSent: 1, telegramMessageId: 77 }; } }).runOnce();
  assert.deepEqual(result, { status: "sent", turnId: fixture.turnId, telegramMessageId: 77 });
  assert.equal(published, "Ответ Luna"); assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "sent");
});

test("shadow worker never invokes publisher", async (t) => {
  const fixture = makeFixture(t, { mode: "shadow" }); let calls = 0;
  const result = await fixture.worker({ agent: async () => final("только проверка"), publisher: async () => { calls += 1; return { ok: true, chunksSent: 1 }; } }).runOnce();
  assert.equal(result.status, "skipped"); assert.equal(calls, 0);
});

test("an explicitly non-retryable agent timeout dead-letters the turn after one visible attempt", async (t) => {
  const fixture = makeFixture(t);
  let calls = 0;
  const timeout = Object.assign(new Error("model timed out"), {
    name: "ResponsesTurnTimeoutError",
    retryable: false,
  });
  const worker = fixture.worker({
    agent: async () => { calls += 1; throw timeout; },
    publisher: async () => { assert.fail("timeout must not publish"); },
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "failed", turnId: fixture.turnId, stage: "agent",
  });
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "dead_letter");
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.attempts, 1);
  assert.equal((await worker.runOnce()).status, "idle");
  assert.equal(calls, 1);
});

test("a rejected stale-progress delete cannot block final turn delivery", async (t) => {
  const fixture = makeFixture(t);
  const prior = fixture.store.claimNextBotTurn({
    workerId: "old-progress-owner",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: fixture.clock.now,
  });
  assert.ok(prior);
  assert.equal(
    fixture.store.saveBotTurnProgress(
      prior.id,
      "old-progress-owner",
      { messageId: 88, state: "unknown" },
      fixture.clock.now,
    ),
    true,
  );
  assert.equal(
    fixture.store.markBotTurnFailed(
      prior.id,
      "old-progress-owner",
      "simulated previous worker failure",
      fixture.clock.now,
    ),
    true,
  );
  // Reclaim after durable backoff, retaining the stale presentation fence.
  fixture.clock.now += 60_000;
  const worker = new BotTurnWorker({
    store: fixture.store,
    coordinator: fixture.coordinator,
    agent: { async run() { return final("Финал всё равно отправлен"); } },
    publisher: { async publish() { return { ok: true, chunksSent: 1, telegramMessageId: 77 }; } },
    workerId: "recovery-throw-worker",
    allowedChatId: CHAT.chatId,
    mode: "live",
    leaseMs: 1_000,
    heartbeatMs: 100,
    scheduler: fixture.scheduler,
    now: () => fixture.clock.now,
    toolProgressBotApiPort: {
      async sendMessage() { assert.fail("agent does not start a new progress item"); },
      async editMessageText() { assert.fail("agent does not start a new progress item"); },
      async deleteMessage() { throw new Error("temporary Telegram delete failure"); },
    },
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "sent",
    turnId: fixture.turnId,
    telegramMessageId: 77,
  });
  const turn = fixture.store.getBotTurn(fixture.turnId);
  assert.equal(turn?.status, "sent");
  assert.equal(turn?.draftText, "Финал всё равно отправлен");
  assert.equal(turn?.progressMessageId, 88);
  assert.equal(turn?.progressState, "unknown");
});

test("a never-settling progress send cannot block durable final publication", async (t) => {
  const fixture = makeFixture(t);
  let published = "";
  const worker = new BotTurnWorker({
    store: fixture.store,
    coordinator: fixture.coordinator,
    agent: {
      async run({ toolProgressPort }) {
        toolProgressPort?.onToolStarted({ toolName: "day_digest", callId: "stuck-send" });
        await flushProgress();
        return final("Финал после зависшего progress");
      },
    },
    publisher: {
      async publish({ publication }) {
        published = publication.plainText;
        return { ok: true, chunksSent: 1, telegramMessageId: 77 };
      },
    },
    workerId: "stuck-progress-worker",
    allowedChatId: CHAT.chatId,
    mode: "live",
    leaseMs: 5_000,
    heartbeatMs: 100,
    scheduler: fixture.scheduler,
    now: () => fixture.clock.now,
    toolProgressBotApiPort: {
      async sendMessage() { return new Promise(() => {}); },
      async editMessageText() { assert.fail("no edit after ambiguous send"); },
      async deleteMessage() { assert.fail("no message id was acknowledged"); },
    },
  });

  const run = worker.runOnce();
  await flushProgress();
  fixture.scheduler.fireTimeouts();
  assert.deepEqual(await run, {
    status: "sent",
    turnId: fixture.turnId,
    telegramMessageId: 77,
  });
  assert.equal(published, "Финал после зависшего progress");
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "sent");
});

test("a never-settling terminal progress cleanup cannot starve the next final", async (t) => {
  const fixture = makeFixture(t);
  const stale = fixture.store.claimNextBotTurn({
    workerId: "stale-progress-owner",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: fixture.clock.now,
  });
  assert.ok(stale);
  assert.equal(
    fixture.store.saveBotTurnProgress(
      stale.id,
      "stale-progress-owner",
      { messageId: 88, state: "unknown" },
      fixture.clock.now,
    ),
    true,
  );
  assert.equal(
    fixture.store.markBotTurnSkipped(
      stale.id,
      "stale-progress-owner",
      "test stale progress",
      fixture.clock.now,
    ),
    true,
  );
  const next = fixture.store.ingestBotUpdate({
    updateId: 78,
    rawJson: "{\"update_id\":78}",
    chat: CHAT,
    message: message(1_001, "@bot after stale cleanup", "owner"),
    addressed: true,
    maxAttempts: 3,
    nowMs: fixture.clock.now,
  }).turn;
  assert.ok(next);

  const worker = new BotTurnWorker({
    store: fixture.store,
    coordinator: fixture.coordinator,
    agent: { async run() { return final("Финал не ждёт cleanup"); } },
    publisher: { async publish() { return { ok: true, chunksSent: 1, telegramMessageId: 77 }; } },
    workerId: "stale-progress-cleanup-worker",
    allowedChatId: CHAT.chatId,
    mode: "live",
    leaseMs: 5_000,
    heartbeatMs: 100,
    scheduler: fixture.scheduler,
    now: () => fixture.clock.now,
    toolProgressBotApiPort: {
      async sendMessage() { assert.fail("no new progress expected"); },
      async editMessageText() { assert.fail("no new progress expected"); },
      async deleteMessage() { return new Promise(() => {}); },
    },
  });

  const run = worker.runOnce();
  await flushProgress();
  fixture.scheduler.fireTimeouts();
  assert.deepEqual(await run, {
    status: "sent",
    turnId: next.id,
    telegramMessageId: 77,
  });
  assert.equal(fixture.store.getBotTurn(stale.id)?.progressMessageId, 88);
  assert.equal(fixture.store.getBotTurn(next.id)?.status, "sent");
});

test("terminal progress cleanup retries the exact durable fence after final delivery", async (t) => {
  const fixture = makeFixture(t);
  const deletedMessageIds: number[] = [];
  let deleteAttempts = 0;
  const worker = new BotTurnWorker({
    store: fixture.store,
    coordinator: fixture.coordinator,
    agent: {
      async run({ toolProgressPort }) {
        assert.ok(toolProgressPort);
        toolProgressPort.onThinkingStarted?.({ callId: "thinking" });
        await flushProgress();
        fixture.clock.now += DEFAULT_PROGRESS_MIN_VISIBLE_MS;
        return final("Ответ с transient progress");
      },
    },
    publisher: { async publish() { return { ok: true, chunksSent: 1, telegramMessageId: 77 }; } },
    workerId: "progress-cleanup-worker",
    allowedChatId: "-1004242",
    mode: "live",
    leaseMs: 5_000,
    heartbeatMs: 100,
    scheduler: fixture.scheduler,
    now: () => fixture.clock.now,
    toolProgressBotApiPort: {
      async sendMessage() { return { ok: true, messageId: 88 }; },
      async editMessageText() { return { ok: true }; },
      async deleteMessage(_chatId, messageId) {
        deletedMessageIds.push(messageId);
        deleteAttempts += 1;
        return deleteAttempts === 1 ? { ok: false } : { ok: true };
      },
    },
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "sent",
    turnId: fixture.turnId,
    telegramMessageId: 77,
  });
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "sent");
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.progressMessageId, 88);
  assert.equal(
    fixture.store.clearTerminalBotTurnProgressIfMatches(
      fixture.turnId,
      89,
      fixture.clock.now,
    ),
    false,
  );
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.progressMessageId, 88);

  assert.deepEqual(await worker.runOnce(), {
    status: "progress_cleaned",
    turnId: fixture.turnId,
  });
  assert.deepEqual(deletedMessageIds, [88, 88]);
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.progressMessageId, undefined);
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.progressState, undefined);
});

test("terminal progress cleanup retires a permanently undeletable fence", async (t) => {
  const fixture = makeFixture(t);
  const logs: Array<Record<string, unknown>> = [];
  const claimed = fixture.store.claimNextBotTurn({
    workerId: "terminal-permanent-owner",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: fixture.clock.now,
  });
  assert.ok(claimed);
  assert.equal(
    fixture.store.saveBotTurnProgress(
      claimed.id,
      "terminal-permanent-owner",
      { messageId: 93, state: "unknown" },
      fixture.clock.now,
    ),
    true,
  );
  assert.equal(
    fixture.store.markBotTurnSkipped(
      claimed.id,
      "terminal-permanent-owner",
      "test permanent progress refusal",
      fixture.clock.now,
    ),
    true,
  );

  const worker = new BotTurnWorker({
    store: fixture.store,
    coordinator: fixture.coordinator,
    agent: { async run() { assert.fail("agent must not run"); } },
    publisher: { async publish() { assert.fail("publisher must not run"); } },
    workerId: "terminal-permanent-cleanup-worker",
    allowedChatId: CHAT.chatId,
    mode: "live",
    scheduler: fixture.scheduler,
    now: () => fixture.clock.now,
    logger: {
      info(fields) { logs.push(fields); },
      warn() {},
      error() {},
    },
    toolProgressBotApiPort: {
      async sendMessage() { assert.fail("send must not run"); },
      async editMessageText() { assert.fail("edit must not run"); },
      async deleteMessage(_chatId, messageId) {
        assert.equal(messageId, 93);
        return { ok: false, terminal: true };
      },
    },
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "progress_cleaned",
    turnId: claimed.id,
  });
  assert.equal(fixture.store.getBotTurn(claimed.id)?.progressMessageId, undefined);
  assert.equal(fixture.store.getBotTurn(claimed.id)?.progressState, undefined);
  assert.deepEqual(logs, [{
    event: "bot.progress.abandoned",
    turnId: claimed.id,
    reason: "permanent_delete_refusal",
  }]);
});

test("terminal progress cleanup also reaches a dead-lettered turn", async (t) => {
  const fixture = makeFixture(t);
  let nowMs = fixture.clock.now;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = fixture.store.claimNextBotTurn({
      workerId: "dead-letter-owner",
      chatId: "-1004242",
      leaseMs: 1_000,
      nowMs,
    });
    assert.ok(claimed);
    if (attempt === 1) {
      assert.equal(
        fixture.store.saveBotTurnProgress(
          claimed.id,
          "dead-letter-owner",
          { messageId: 91, state: "unknown" },
          nowMs,
        ),
        true,
      );
    }
    assert.equal(
      fixture.store.markBotTurnFailed(
        claimed.id,
        "dead-letter-owner",
        "test failure",
        nowMs,
      ),
      true,
    );
    nowMs += 60_000;
  }
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "dead_letter");

  const worker = new BotTurnWorker({
    store: fixture.store,
    coordinator: fixture.coordinator,
    agent: { async run() { assert.fail("agent must not run"); } },
    publisher: { async publish() { assert.fail("publisher must not run"); } },
    workerId: "dead-letter-cleanup-worker",
    allowedChatId: "-1004242",
    mode: "live",
    scheduler: fixture.scheduler,
    now: () => nowMs,
    toolProgressBotApiPort: {
      async sendMessage() { assert.fail("send must not run"); },
      async editMessageText() { assert.fail("edit must not run"); },
      async deleteMessage(_chatId, messageId) {
        assert.equal(messageId, 91);
        return { ok: true };
      },
    },
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "progress_cleaned",
    turnId: fixture.turnId,
  });
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.progressMessageId, undefined);
});

test("terminal progress cleanup keeps retrying while a normal FIFO backlog is draining", async (t) => {
  const fixture = makeFixture(t);
  const claimed = fixture.store.claimNextBotTurn({
    workerId: "terminal-progress-owner",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: fixture.clock.now,
  });
  assert.ok(claimed);
  assert.equal(
    fixture.store.saveBotTurnProgress(
      claimed.id,
      "terminal-progress-owner",
      { messageId: 92, state: "unknown" },
      fixture.clock.now,
    ),
    true,
  );
  assert.equal(
    fixture.store.markBotTurnSkipped(
      claimed.id,
      "terminal-progress-owner",
      "test terminal progress",
      fixture.clock.now,
    ),
    true,
  );

  const firstQueued = fixture.store.ingestBotUpdate({
    updateId: 78,
    rawJson: "{\"update_id\":78}",
    chat: CHAT,
    message: message(1_001, "@bot first queued", "owner"),
    addressed: true,
    maxAttempts: 3,
    nowMs: fixture.clock.now,
  }).turn;
  const secondQueued = fixture.store.ingestBotUpdate({
    updateId: 79,
    rawJson: "{\"update_id\":79}",
    chat: CHAT,
    message: message(1_002, "@bot second queued", "owner"),
    addressed: true,
    maxAttempts: 3,
    nowMs: fixture.clock.now,
  }).turn;
  assert.ok(firstQueued);
  assert.ok(secondQueued);

  const deleteAttempts: number[] = [];
  const worker = new BotTurnWorker({
    store: fixture.store,
    coordinator: fixture.coordinator,
    agent: { async run() { return final("готово"); } },
    publisher: { async publish() { return { ok: true, chunksSent: 1, telegramMessageId: 77 }; } },
    workerId: "backlog-progress-cleanup-worker",
    allowedChatId: CHAT.chatId,
    mode: "live",
    leaseMs: 1_000,
    heartbeatMs: 100,
    scheduler: fixture.scheduler,
    now: () => fixture.clock.now,
    toolProgressBotApiPort: {
      async sendMessage() { assert.fail("no new progress expected"); },
      async editMessageText() { assert.fail("no new progress expected"); },
      async deleteMessage(_chatId, messageId) {
        deleteAttempts.push(messageId);
        return { ok: deleteAttempts.length > 1 };
      },
    },
  });
  // A failed first cleanup does not block the first normal turn.
  assert.deepEqual(await worker.runOnce(), {
    status: "sent",
    turnId: firstQueued.id,
    telegramMessageId: 77,
  });
  assert.deepEqual(deleteAttempts, [92]);
  assert.equal(fixture.store.getBotTurn(claimed.id)?.progressMessageId, 92);
  // Backoff expiry clears the stale progress before the second normal claim.
  fixture.clock.now += DEFAULT_PROGRESS_MIN_VISIBLE_MS * 5;
  assert.deepEqual(await worker.runOnce(), {
    status: "sent",
    turnId: secondQueued.id,
    telegramMessageId: 77,
  });
  assert.deepEqual(deleteAttempts, [92, 92]);
  assert.equal(fixture.store.getBotTurn(claimed.id)?.progressMessageId, undefined);
});

async function flushProgress(): Promise<void> {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}
