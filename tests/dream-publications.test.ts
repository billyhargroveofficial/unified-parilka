import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import {
  DREAM_PUBLICATION_RESTART_LOST_ACK_ERROR,
} from "../src/storage/constants.js";

const CHAT_ID = "-1003179772905";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function enqueue(
  store: MessageStore,
  overrides: Partial<Parameters<MessageStore["enqueueDreamPublication"]>[0]> = {},
) {
  return store.enqueueDreamPublication({
    id: "dream-publication-1",
    dedupeKey: "dream/-1003179772905/2026-08-27/audit-a",
    payloadHash: HASH_A,
    chatId: CHAT_ID,
    markdown: "### Dream\n- saved `release-checklist`",
    plainText: "Dream: saved release-checklist",
    maxAttempts: 2,
    nowMs: 1_000,
    ...overrides,
  });
}

test("Dream publication enqueue is immutable and idempotent by dedupe key", () => {
  const store = new MessageStore(":memory:");
  try {
    const first = enqueue(store);
    const duplicate = enqueue(store, { id: "ignored-new-id", nowMs: 2_000 });
    assert.deepEqual(duplicate, first);
    assert.equal(store.getDreamPublicationByDedupeKey(first.dedupeKey)?.id, first.id);
    assert.throws(
      () => enqueue(store, { payloadHash: HASH_B }),
      /different immutable payload/,
    );
    assert.throws(
      () => enqueue(store, { payloadHash: "not-a-sha" }),
      /SHA-256/,
    );
  } finally {
    store.close();
  }
});

test("one CAS claim owns a due Dream publication and acknowledges it once", () => {
  const store = new MessageStore(":memory:");
  try {
    enqueue(store);
    const first = store.claimNextDreamPublication({
      chatId: CHAT_ID,
      workerId: "bot-notifications:1",
      nowMs: 1_001,
    });
    assert.equal(first?.status, "sending");
    assert.equal(first?.attempts, 1);
    assert.equal(
      store.claimNextDreamPublication({
        chatId: CHAT_ID,
        workerId: "bot-notifications:2",
        nowMs: 1_001,
      }),
      undefined,
    );
    assert.equal(
      store.markDreamPublicationSent({
        id: first!.id,
        workerId: "bot-notifications:2",
        telegramMessageId: 91,
        nowMs: 1_002,
      }),
      false,
    );
    assert.equal(
      store.markDreamPublicationSent({
        id: first!.id,
        workerId: "bot-notifications:1",
        telegramMessageId: 91,
        nowMs: 1_002,
      }),
      true,
    );
    const sent = store.getDreamPublication(first!.id);
    assert.equal(sent?.status, "sent");
    assert.equal(sent?.telegramMessageId, 91);
    assert.equal(sent?.completedAtMs, 1_002);
  } finally {
    store.close();
  }
});

test("a future-created Dream publication cannot be claimed early", () => {
  const store = new MessageStore(":memory:");
  try {
    enqueue(store, { nowMs: 5_000 });
    assert.equal(store.getNextDreamPublicationDueAt(CHAT_ID), 5_000);
    assert.equal(store.claimNextDreamPublication({
      chatId: CHAT_ID,
      workerId: "bot:1",
      nowMs: 4_999,
    }), undefined);
    assert.ok(store.claimNextDreamPublication({
      chatId: CHAT_ID,
      workerId: "bot:1",
      nowMs: 5_000,
    }));
  } finally {
    store.close();
  }
});

test("definitive retry schedules the next due time and exhausts to failed", () => {
  const store = new MessageStore(":memory:");
  try {
    enqueue(store);
    const first = store.claimNextDreamPublication({ chatId: CHAT_ID, workerId: "bot:1", nowMs: 1_001 });
    assert.ok(first);
    const queued = store.markDreamPublicationRetryableFailure({
      id: first.id,
      workerId: "bot:1",
      error: "TELEGRAM_429",
      retryNotBeforeMs: 2_000,
      nowMs: 1_002,
    });
    assert.equal(queued?.status, "queued");
    assert.equal(store.getNextDreamPublicationDueAt(CHAT_ID), 2_000);
    assert.equal(store.claimNextDreamPublication({ chatId: CHAT_ID, workerId: "bot:1", nowMs: 1_999 }), undefined);
    const second = store.claimNextDreamPublication({ chatId: CHAT_ID, workerId: "bot:1", nowMs: 2_000 });
    assert.equal(second?.attempts, 2);
    const failed = store.markDreamPublicationRetryableFailure({
      id: second!.id,
      workerId: "bot:1",
      error: "TELEGRAM_429",
      retryNotBeforeMs: 3_000,
      nowMs: 2_001,
    });
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.completedAtMs, 2_001);
    assert.equal(store.getNextDreamPublicationDueAt(CHAT_ID), undefined);
  } finally {
    store.close();
  }
});

test("lost acknowledgements and startup recovery are permanent no-retry fences", () => {
  const store = new MessageStore(":memory:");
  try {
    enqueue(store);
    const claimed = store.claimNextDreamPublication({ chatId: CHAT_ID, workerId: "bot:1", nowMs: 1_001 });
    assert.ok(claimed);
    assert.equal(
      store.markDreamPublicationLostAck({
        id: claimed.id,
        workerId: "bot:1",
        error: "publisher_timeout",
        nowMs: 1_002,
      }),
      true,
    );
    assert.equal(store.getDreamPublication(claimed.id)?.status, "lost_ack");
    assert.equal(store.claimNextDreamPublication({ chatId: CHAT_ID, workerId: "bot:2", nowMs: 2_000 }), undefined);

    enqueue(store, {
      id: "dream-publication-2",
      dedupeKey: "dream/-1003179772905/2026-08-28/audit-b",
      payloadHash: HASH_B,
    });
    assert.ok(store.claimNextDreamPublication({ chatId: CHAT_ID, workerId: "bot:1", nowMs: 2_001 }));
    assert.equal(store.reconcileDreamPublicationsOnStartup(2_002), 1);
    const recovered = store.getDreamPublication("dream-publication-2");
    assert.equal(recovered?.status, "lost_ack");
    assert.equal(recovered?.error, DREAM_PUBLICATION_RESTART_LOST_ACK_ERROR);
    assert.equal(store.reconcileDreamPublicationsOnStartup(2_003), 0);
  } finally {
    store.close();
  }
});

test("definitive rejection is a terminal failed fence", () => {
  const store = new MessageStore(":memory:");
  try {
    enqueue(store);
    const claimed = store.claimNextDreamPublication({
      chatId: CHAT_ID,
      workerId: "bot:1",
      nowMs: 1_001,
    });
    assert.ok(claimed);
    assert.equal(
      store.markDreamPublicationDefinitiveFailure({
        id: claimed.id,
        workerId: "bot:1",
        error: "TELEGRAM_400_CHAT_NOT_FOUND",
        nowMs: 1_002,
      }),
      true,
    );
    const failed = store.getDreamPublication(claimed.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.completedAtMs, 1_002);
    assert.equal(failed?.retryNotBeforeMs, undefined);
    assert.equal(
      store.claimNextDreamPublication({
        chatId: CHAT_ID,
        workerId: "bot:2",
        nowMs: 2_000,
      }),
      undefined,
    );
  } finally {
    store.close();
  }
});
