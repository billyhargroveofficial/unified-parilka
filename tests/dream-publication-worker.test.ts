import assert from "node:assert/strict";
import { test } from "node:test";
import { DreamPublicationWorker } from "../src/bot/dream-publication-worker.js";
import { TelegramBotApiRejectedError } from "../src/bot/telegram-bot-api.js";
import { MessageStore } from "../src/store.js";

const CHAT_ID = "-1003179772905";
const HASH = "a".repeat(64);

function enqueue(
  store: MessageStore,
  overrides: Partial<Parameters<MessageStore["enqueueDreamPublication"]>[0]> = {},
) {
  return store.enqueueDreamPublication({
    id: "dream-worker-publication",
    dedupeKey: "dream-worker/dedupe",
    payloadHash: HASH,
    chatId: CHAT_ID,
    markdown: "🌙 Dream digest",
    plainText: "🌙 Dream digest",
    nowMs: 1_000,
    ...overrides,
  });
}

function worker(
  store: MessageStore,
  sendMessage: (
    chatId: string,
    text: string,
    options: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>,
  overrides: Partial<ConstructorParameters<typeof DreamPublicationWorker>[0]> = {},
) {
  return new DreamPublicationWorker({
    store,
    telegram: { sendMessage },
    workerId: "dream-worker:1",
    allowedChatId: CHAT_ID,
    now: () => 1_001,
    ...overrides,
  });
}

test("Dream worker sends one unthreaded permanent plain-text digest and ACKs it", async () => {
  const store = new MessageStore(":memory:");
  try {
    const publication = enqueue(store);
    const calls: unknown[][] = [];
    const result = await worker(store, async (...args) => {
      calls.push(args);
      return { message_id: 77 };
    }).runOnce();

    assert.deepEqual(result, {
      status: "sent",
      publicationId: publication.id,
      telegramMessageId: 77,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], CHAT_ID);
    assert.equal(calls[0]?.[1], "🌙 Dream digest");
    assert.equal(calls[0]?.[2], undefined);
    assert.ok(calls[0]?.[3] instanceof AbortSignal);
    const stored = store.getDreamPublication(publication.id);
    assert.equal(stored?.status, "sent");
    assert.equal(stored?.telegramMessageId, 77);
  } finally {
    store.close();
  }
});

test("Dream worker retries only definitive 429/5xx rejections with bounded schedules", async () => {
  const store = new MessageStore(":memory:");
  try {
    const publication = enqueue(store);
    const rateLimited = await worker(store, async () => {
      throw new TelegramBotApiRejectedError(429, "flood", { retry_after: 2 });
    }).runOnce();
    assert.deepEqual(rateLimited, {
      status: "retryable",
      publicationId: publication.id,
      retryAfterMs: 2_000,
    });
    assert.equal(store.getDreamPublication(publication.id)?.status, "queued");
    assert.equal(store.getDreamPublication(publication.id)?.retryNotBeforeMs, 3_001);

    const serverPublication = enqueue(store, {
      id: "dream-worker-server-error",
      dedupeKey: "dream-worker/server-error",
      payloadHash: "b".repeat(64),
      nowMs: 1_000,
    });
    const serverError = await worker(
      store,
      async () => {
        throw new TelegramBotApiRejectedError(500, "server");
      },
      { now: () => 1_001 },
    ).runOnce();
    assert.deepEqual(serverError, {
      status: "retryable",
      publicationId: serverPublication.id,
      retryAfterMs: 5_000,
    });
  } finally {
    store.close();
  }
});

test("Dream worker makes a definitive 4xx or invalid local payload terminal without sending", async () => {
  const store = new MessageStore(":memory:");
  try {
    const publication = enqueue(store);
    const rejected = await worker(store, async () => {
      throw new TelegramBotApiRejectedError(403, "forbidden");
    }).runOnce();
    assert.deepEqual(rejected, { status: "failed", publicationId: publication.id });
    assert.equal(store.getDreamPublication(publication.id)?.status, "failed");

    const invalid = enqueue(store, {
      id: "dream-worker-too-long",
      dedupeKey: "dream-worker/too-long",
      payloadHash: "b".repeat(64),
      plainText: "x".repeat(4_097),
    });
    let calls = 0;
    const invalidResult = await worker(store, async () => {
      calls += 1;
      return { message_id: 1 };
    }).runOnce();
    assert.deepEqual(invalidResult, { status: "failed", publicationId: invalid.id });
    assert.equal(calls, 0);
    assert.equal(store.getDreamPublication(invalid.id)?.status, "failed");
  } finally {
    store.close();
  }
});

test("Dream worker fences malformed, network, timeout and post-ACK persistence ambiguity as lost_ack", async () => {
  const store = new MessageStore(":memory:");
  try {
    const malformed = enqueue(store);
    const malformedResult = await worker(store, async () => ({})).runOnce();
    assert.deepEqual(malformedResult, { status: "lost_ack", publicationId: malformed.id });
    assert.equal(store.getDreamPublication(malformed.id)?.status, "lost_ack");

    const network = enqueue(store, {
      id: "dream-worker-network",
      dedupeKey: "dream-worker/network",
      payloadHash: "b".repeat(64),
    });
    const logs: Record<string, unknown>[] = [];
    const networkResult = await worker(store, async () => {
      throw Object.assign(new Error("https://bot-token.example/should-not-log"), { code: "ECONNRESET" });
    }, { logger: { info(record) { logs.push({ ...record }); }, warn(record) { logs.push({ ...record }); }, error(record) { logs.push({ ...record }); } } }).runOnce();
    assert.deepEqual(networkResult, { status: "lost_ack", publicationId: network.id });
    assert.equal(store.getDreamPublication(network.id)?.status, "lost_ack");
    assert.doesNotMatch(JSON.stringify(logs), /bot-token|Dream digest/u);

    const timedOut = enqueue(store, {
      id: "dream-worker-timeout",
      dedupeKey: "dream-worker/timeout",
      payloadHash: "c".repeat(64),
    });
    const timeoutResult = await worker(
      store,
      async (_chatId, _text, _options, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("late abort")), { once: true });
      }),
      { sendTimeoutMs: 1 },
    ).runOnce();
    assert.deepEqual(timeoutResult, { status: "lost_ack", publicationId: timedOut.id });
    assert.equal(store.getDreamPublication(timedOut.id)?.status, "lost_ack");

    const postAck = enqueue(store, {
      id: "dream-worker-post-ack",
      dedupeKey: "dream-worker/post-ack",
      payloadHash: "d".repeat(64),
    });
    Object.defineProperty(store, "markDreamPublicationSent", {
      value: () => false,
      configurable: true,
    });
    const postAckResult = await worker(store, async () => ({ message_id: 99 })).runOnce();
    assert.deepEqual(postAckResult, { status: "lost_ack", publicationId: postAck.id });
    assert.equal(store.getDreamPublication(postAck.id)?.status, "lost_ack");
  } finally {
    store.close();
  }
});

test("Dream worker keeps checking the durable queue at most thirty seconds apart", async () => {
  const store = new MessageStore(":memory:");
  try {
    const result = await worker(store, async () => ({ message_id: 1 })).runOnce();
    assert.deepEqual(result, { status: "idle", retryAfterMs: 30_000 });
  } finally {
    store.close();
  }
});
