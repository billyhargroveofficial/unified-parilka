import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  MessageStore,
  type BotUpdateIngestResult,
  type StoredMessage,
} from "../src/store.js";
import type { ChatInfo } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1004242",
  requested: "-1004242",
  title: "Parilka",
  kind: "supergroup",
};

const OTHER_CHAT: ChatInfo = {
  chatId: "-1005252",
  requested: "-1005252",
  title: "Other",
  kind: "supergroup",
};

test("duplicate Bot API update is idempotent and cannot reserve a second turn", (t) => {
  const store = makeStore(t);

  const first = ingest(store, 100, 500);
  const duplicate = ingest(store, 100, 500);
  const duplicateTrigger = ingest(store, 101, 500);

  assert.equal(first.disposition, "ingested");
  assert.equal(duplicate.disposition, "duplicate");
  assert.equal(duplicate.turn?.id, first.turn?.id);
  assert.equal(duplicateTrigger.update.status, "skipped");
  assert.equal(duplicateTrigger.turn?.id, first.turn?.id);
  assert.equal(store.queryBotUpdates().length, 2);
  assert.equal(store.queryBotTurns().length, 1);
  assert.equal(store.countMessages(CHAT.chatId), 1);
});

test("durable writer uses WAL with FULL synchronous commits", (t) => {
  const store = makeStore(t);
  const db = (
    store as unknown as {
      db: {
        prepare(sql: string): {
          get(): Record<string, unknown> | undefined;
        };
      };
    }
  ).db;

  assert.equal(
    Number(db.prepare("PRAGMA synchronous").get()?.synchronous),
    2,
  );
  assert.equal(
    String(db.prepare("PRAGMA journal_mode").get()?.journal_mode),
    "wal",
  );
});

test("a process crash after ingest leaves an addressed turn claimable after reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-durable-crash-"));
  const dbPath = join(directory, "cache.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const firstProcess = new MessageStore(dbPath);
  const ingested = ingest(firstProcess, 200, 600);
  firstProcess.close();

  const restarted = new MessageStore(dbPath);
  t.after(() => restarted.close());
  const claimed = restarted.claimNextBotTurn({
    workerId: "worker-after-restart",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 10_000,
  });

  assert.equal(claimed?.id, ingested.turn?.id);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.attempts, 1);
  assert.equal(restarted.getBotUpdate(200)?.status, "running");
});

test("changing the configured chat quarantines old backlog before any claim", (t) => {
  const store = makeStore(t);
  const oldTurn = ingest(store, 250, 650).turn!;
  const newTurn = store.ingestBotUpdate({
    updateId: 251,
    rawJson: "{\"update_id\":251}",
    chat: OTHER_CHAT,
    message: message(651, { chatId: OTHER_CHAT.chatId }),
    addressed: true,
    nowMs: 1_000,
  }).turn!;

  const claimed = store.claimNextBotTurn({
    workerId: "new-config-worker",
    chatId: OTHER_CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 2_000,
  });

  assert.equal(claimed?.id, newTurn.id);
  assert.equal(claimed?.chatId, OTHER_CHAT.chatId);
  assert.equal(store.getBotTurn(oldTurn.id)?.status, "dead_letter");
  assert.match(
    store.getBotTurn(oldTurn.id)?.error ?? "",
    /outside the current allowlist/u,
  );
});

test("expired running and drafted leases recover, but attempts stay bounded", (t) => {
  const store = makeStore(t);
  const ingested = ingest(store, 300, 700, { maxAttempts: 2, nowMs: 1_000 });
  const first = store.claimNextBotTurn({
    workerId: "worker-a",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 1_000,
  });
  assert.equal(first?.id, ingested.turn?.id);
  assert.equal(store.saveBotTurnDraft(first!.id, "worker-a", "durable draft", 1_050), true);

  assert.equal(
    store.claimNextBotTurn({ workerId: "worker-b", chatId: CHAT.chatId, leaseMs: 100, nowMs: 1_099 }),
    undefined,
  );
  const recovered = store.claimNextBotTurn({
    workerId: "worker-b",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 1_100,
  });
  assert.equal(recovered, undefined);
  assert.equal(
    store.getBotTurn(first!.id)?.retryNotBeforeMs,
    6_100,
  );
  const due = store.claimNextBotTurn({
    workerId: "worker-b",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 6_100,
  });
  assert.equal(due?.id, first?.id);
  assert.equal(due?.attempts, 2);
  assert.equal(due?.draftText, "durable draft");
  assert.equal(store.saveBotTurnDraft(first!.id, "worker-a", "stale owner", 1_101), false);

  const exhausted = store.claimNextBotTurn({
    workerId: "worker-c",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 6_200,
  });
  assert.equal(exhausted, undefined);
  assert.equal(store.getBotTurn(first!.id)?.status, "dead_letter");
  assert.equal(store.getBotTurn(first!.id)?.attempts, 2);
  assert.equal(store.getBotUpdate(300)?.status, "dead_letter");
});

test("the active owner can renew a live lease but cannot revive or steal one", (t) => {
  const store = makeStore(t);
  const turn = ingest(store, 350, 750, { nowMs: 1_000 }).turn!;
  const claimed = store.claimNextBotTurn({
    workerId: "worker-a",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 1_010,
  });
  assert.equal(claimed?.id, turn.id);

  assert.equal(store.renewBotTurnLease(turn.id, "worker-b", 200, 1_050), false);
  assert.equal(store.renewBotTurnLease(turn.id, "worker-a", 200, 1_050), true);
  assert.equal(store.getBotTurn(turn.id)?.leaseExpiresAtMs, 1_250);
  assert.equal(store.renewBotTurnLease(turn.id, "worker-a", 200, 1_251), false);
});

test("sent terminal state is immutable and never automatically claimed", (t) => {
  const store = makeStore(t);
  const turn = ingest(store, 400, 800).turn!;
  const claimed = store.claimNextBotTurn({
    workerId: "sender",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 2_000,
  })!;

  assert.equal(store.saveBotTurnDraft(claimed.id, "sender", "guarded final text", 2_100), true);
  assert.equal(store.markBotTurnSending(claimed.id, "sender", 2_200), true);
  assert.equal(store.markBotTurnSent(claimed.id, 9_001, 2_300), true);

  assert.equal(store.markBotTurnSent(claimed.id, 9_002, 2_301), false);
  assert.equal(store.markBotTurnLostAck(claimed.id, "too late", 2_302), false);
  assert.equal(store.markBotTurnFailed(claimed.id, "sender", "too late", 2_303), false);
  assert.equal(store.markBotTurnSkipped(claimed.id, "sender", "too late", 2_304), false);
  assert.equal(store.claimNextBotTurn({ workerId: "other", chatId: CHAT.chatId, leaseMs: 100, nowMs: 9_000 }), undefined);
  assert.equal(store.getBotTurn(turn.id)?.status, "sent");
  assert.equal(store.getBotTurn(turn.id)?.telegramMessageId, 9_001);
  assert.equal(store.getBotTurn(turn.id)?.draftText, "guarded final text");
  assert.equal(store.getBotUpdate(400)?.status, "sent");
});

test("ACK token for an addressed update exists only after its turn reservation commits", (t) => {
  const store = makeStore(t);

  const result = ingest(store, 500, 900);
  assertAddressedAckHasReservation(store, result);
  assert.equal(result.ackUpdateId, 500);
  assert.equal(store.getHistory({ chatId: CHAT.chatId, limit: 10 })[0]?.messageId, 900);

  assert.throws(
    () =>
      store.ingestBotUpdate({
        updateId: 501,
        rawJson: "{\"update_id\":501}",
        chat: CHAT,
        message: message(900, { chatId: "-100-different" }),
        addressed: true,
      }),
    /chatId must match/,
  );
  assert.equal(store.getBotUpdate(501), undefined);
  assert.equal(store.queryBotTurns().length, 1);
});

test("three addressed triggers are durably queued and claimed once in FIFO order", (t) => {
  const store = makeStore(t);
  const results = [
    ingest(store, 600, 1_000, { nowMs: 10 }),
    ingest(store, 601, 1_001, { nowMs: 20 }),
    ingest(store, 602, 1_002, { nowMs: 30 }),
  ];

  assert.deepEqual(
    store.queryBotTurns({ statuses: ["queued"] }).map((turn) => turn.triggerMessageId),
    [1_000, 1_001, 1_002],
  );
  const claimed = results.map((_, index) =>
    store.claimNextBotTurn({
      workerId: `worker-${index}`,
      chatId: CHAT.chatId,
      leaseMs: 1_000,
      nowMs: 100 + index,
    }),
  );
  assert.deepEqual(
    claimed.map((turn) => turn?.triggerMessageId),
    [1_000, 1_001, 1_002],
  );
  assert.equal(new Set(claimed.map((turn) => turn?.id)).size, 3);
  assert.equal(store.queryBotTurns({ statuses: ["queued"] }).length, 0);
});

test("sending and lost_ack are never auto-retried", (t) => {
  const store = makeStore(t);
  ingest(store, 700, 1_100);
  const sending = store.claimNextBotTurn({
    workerId: "sender",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 20_000,
  })!;
  assert.equal(store.saveBotTurnDraft(sending.id, "sender", "possibly delivered", 20_010), true);
  assert.equal(store.markBotTurnSending(sending.id, "sender", 20_020), true);

  assert.equal(
    store.claimNextBotTurn({ workerId: "retry-worker", chatId: CHAT.chatId, leaseMs: 100, nowMs: 30_000 }),
    undefined,
  );
  assert.equal(store.markBotTurnLostAck(sending.id, "network timeout after dispatch", 30_001), true);
  assert.equal(
    store.claimNextBotTurn({ workerId: "retry-worker", chatId: CHAT.chatId, leaseMs: 100, nowMs: 40_000 }),
    undefined,
  );
  assert.equal(store.getBotTurn(sending.id)?.status, "lost_ack");
});

test("only a definitive dispatch rejection may leave sending for a retry lane", (t) => {
  const store = makeStore(t);
  const retryTurn = ingest(store, 725, 1_125, {
    maxAttempts: 2,
    nowMs: 30_000,
  }).turn!;
  const retryClaim = store.claimNextBotTurn({
    workerId: "sender",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 30_010,
  });
  assert.equal(retryClaim?.id, retryTurn.id);
  assert.equal(store.saveBotTurnDraft(retryTurn.id, "sender", "retry me", 30_020), true);
  assert.equal(store.markBotTurnSending(retryTurn.id, "sender", 30_030), true);
  assert.equal(
    store.markBotTurnDispatchRejected(retryTurn.id, "429 response", true, 30_040),
    true,
  );
  assert.equal(store.getBotTurn(retryTurn.id)?.status, "failed");
  assert.equal(
    store.getBotTurn(retryTurn.id)?.retryNotBeforeMs,
    35_040,
  );
  assert.equal(
    store.claimNextBotTurn({ workerId: "retry", chatId: CHAT.chatId, leaseMs: 100, nowMs: 30_050 })?.id,
    undefined,
  );
  assert.equal(
    store.claimNextBotTurn({ workerId: "retry", chatId: CHAT.chatId, leaseMs: 100, nowMs: 35_040 })?.id,
    retryTurn.id,
  );

  const permanentTurn = ingest(store, 726, 1_126, { nowMs: 31_000 }).turn!;
  const permanentClaim = store.claimNextBotTurn({
    workerId: "sender",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 31_010,
  });
  assert.equal(permanentClaim?.id, permanentTurn.id);
  assert.equal(store.saveBotTurnDraft(permanentTurn.id, "sender", "invalid", 31_020), true);
  assert.equal(store.markBotTurnSending(permanentTurn.id, "sender", 31_030), true);
  assert.equal(
    store.markBotTurnDispatchRejected(permanentTurn.id, "400 response", false, 31_040),
    true,
  );
  assert.equal(store.getBotTurn(permanentTurn.id)?.status, "dead_letter");
  assert.equal(
    store.markBotTurnDispatchRejected(permanentTurn.id, "late rewrite", true, 31_050),
    false,
  );
});

test("known failures retry within budget and an explicit skip is terminal", (t) => {
  const store = makeStore(t);
  ingest(store, 750, 1_150, { maxAttempts: 2, nowMs: 50_000 });
  const first = store.claimNextBotTurn({
    workerId: "worker-a",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 50_000,
  })!;

  assert.equal(store.markBotTurnFailed(first.id, "worker-a", "provider unavailable", 50_100), true);
  assert.equal(store.getBotTurn(first.id)?.status, "failed");
  const retry = store.claimNextBotTurn({
    workerId: "worker-b",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 55_100,
  })!;
  assert.equal(retry.id, first.id);
  assert.equal(retry.attempts, 2);
  assert.equal(store.markBotTurnSkipped(retry.id, "worker-b", "moderation policy", 50_300), true);
  assert.equal(store.getBotTurn(retry.id)?.status, "skipped");
  assert.equal(
    store.claimNextBotTurn({ workerId: "worker-c", chatId: CHAT.chatId, leaseMs: 100, nowMs: 60_000 }),
    undefined,
  );
});

test("poison updates retry durably, recover before the limit, and dead-letter at the limit", (t) => {
  const store = makeStore(t);

  const firstFailure = store.recordBotUpdateFailure({
    updateId: 800,
    rawJson: "{\"broken\":",
    error: "invalid JSON",
    maxAttempts: 3,
    nowMs: 1,
  });
  assert.equal(firstFailure.update.status, "failed");
  assert.equal(firstFailure.update.attempts, 1);
  assert.equal(firstFailure.ackUpdateId, undefined);

  const recovered = ingest(store, 800, 1_200, { maxAttempts: 3, nowMs: 2 });
  assert.equal(recovered.disposition, "recovered");
  assert.equal(recovered.update.status, "queued");
  assert.equal(recovered.turn?.triggerMessageId, 1_200);

  const deadOne = store.recordBotUpdateFailure({
    updateId: 801,
    rawJson: "{\"still\":\"bad\"}",
    error: "unsupported update shape",
    maxAttempts: 2,
    nowMs: 3,
  });
  const deadTwo = store.recordBotUpdateFailure({
    updateId: 801,
    rawJson: "{\"still\":\"bad\"}",
    error: "unsupported update shape",
    maxAttempts: 20,
    nowMs: 4,
  });
  assert.equal(deadOne.update.status, "failed");
  assert.equal(deadTwo.update.status, "dead_letter");
  assert.equal(deadTwo.update.attempts, 2);
  assert.equal(deadTwo.update.maxAttempts, 2);
  assert.equal(deadTwo.ackUpdateId, 801);
  assert.equal(ingest(store, 801, 1_201).disposition, "duplicate");
  assert.equal(store.getBotTurnByTrigger(CHAT.chatId, 1_201), undefined);
});

test("a changed decoder still ACKs a previously committed valid redelivery", (t) => {
  const store = makeStore(t);
  const committed = ingest(store, 850, 1_250);

  const reclassified = store.recordBotUpdateFailure({
    updateId: 850,
    rawJson: "{\"update_id\":850,\"new_shape\":true}",
    error: "new decoder rejects old shape",
    maxAttempts: 3,
    nowMs: 2_000,
  });

  assert.equal(reclassified.ackUpdateId, 850);
  assert.equal(reclassified.update.status, "queued");
  assert.equal(reclassified.update.attempts, 0);
  assert.equal(
    store.getBotTurnByTrigger(
      CHAT.chatId,
      committed.turn!.triggerMessageId,
    )?.id,
    committed.turn?.id,
  );
});

function makeStore(t: TestContext): MessageStore {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-durable-"));
  const store = new MessageStore(join(directory, "cache.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function ingest(
  store: MessageStore,
  updateId: number,
  messageId: number,
  options: { maxAttempts?: number; nowMs?: number } = {},
): BotUpdateIngestResult {
  return store.ingestBotUpdate({
    updateId,
    rawJson: JSON.stringify({
      update_id: updateId,
      message: { message_id: messageId, chat: { id: CHAT.chatId } },
    }),
    chat: CHAT,
    message: message(messageId),
    addressed: true,
    maxAttempts: options.maxAttempts,
    nowMs: options.nowMs,
  });
}

function message(messageId: number, overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    date: "2026-07-30T12:00:00.000Z",
    senderId: "42",
    senderName: "owner",
    text: "@bot answer this",
    rawJson: JSON.stringify({ message_id: messageId }),
    ...overrides,
  };
}

function assertAddressedAckHasReservation(store: MessageStore, result: BotUpdateIngestResult): void {
  assert.equal(result.update.addressed, true);
  assert.ok(result.turn, "addressed update must reserve a turn before exposing ackUpdateId");
  assert.equal(result.turn.updateId, result.update.updateId);
  assert.equal(
    store.getBotTurnByTrigger(result.turn.chatId, result.turn.triggerMessageId)?.id,
    result.turn.id,
  );
}
