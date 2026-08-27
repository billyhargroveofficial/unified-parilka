import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprintEmbeddingSource,
  renderEmbeddingChunkSource,
} from "../src/embedding-source.js";
import type { EmbeddingChunkVector } from "../src/embeddings.js";
import { MessageStore, type StoredMessage } from "../src/store.js";
import type { ChatInfo } from "../src/telegram/types.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};
const CHUNK_MAX_CHARS = 1_600;
const CHUNK_NAMESPACE = "test";
const CHUNK_MODEL = "test-model";
const CHUNK_DIMENSIONS = 2;

test("identical reconciliation re-upsert keeps committed chunks clean", () => {
  const store = new MessageStore(":memory:");
  const original = message(1, { text: "semantically identical update" });
  store.upsertMessages(CHAT, [original]);
  commitChunk(store, [original]);

  store.upsertMessages(CHAT, [{ ...original }]);
  store.upsertMessages(CHAT, [
    message(1, {
      text: "semantically identical update",
      rawJson: JSON.stringify({ views: 7 }),
    }),
  ]);

  assertClean(store, 1);
  const [stats] = store.getEmbeddingStats(CHAT.chatId, {
    namespace: CHUNK_NAMESPACE,
  });
  assert.equal(Number(stats?.dirty_chunks), 0);
  assert.equal(Number(stats?.indexed_messages), 1);
  store.close();
});

test("reconciliation replay of a whole recent window does not re-dirty chunks", () => {
  const store = new MessageStore(":memory:");
  const originals = [
    message(1, { text: "first" }),
    message(2, { senderName: "Bob", text: "second" }),
    message(3, { senderId: "99", senderName: undefined, text: "third" }),
  ];
  store.upsertMessages(CHAT, originals);
  commitChunk(store, originals);

  store.upsertMessages(CHAT, [
    { ...originals[2]! },
    { ...originals[0]!, rawJson: JSON.stringify({ views: 1 }) },
    { ...originals[1]!, replyToMessageId: 1, topicId: 5 },
  ]);

  const [stats] = store.getEmbeddingStats(CHAT.chatId, {
    namespace: CHUNK_NAMESPACE,
  });
  assert.equal(Number(stats?.dirty_chunks), 0);
  assert.equal(Number(stats?.indexed_messages), 3);
  assert.equal(Number(stats?.uncovered_messages), 0);
  store.close();
});

test("reply/topic/raw_json edits without embedding source change stay clean", () => {
  const store = new MessageStore(":memory:");
  const original = message(1, { text: "stable source" });
  store.upsertMessages(CHAT, [original]);
  commitChunk(store, [original]);

  store.upsertMessages(CHAT, [
    message(1, {
      text: "stable source",
      replyToMessageId: 9,
      topicId: 3,
      rawJson: JSON.stringify({ views: 42, forwards: 2 }),
    }),
  ]);

  assertClean(store, 1);
  store.close();
});

test("rich reconciliation without text keeps canonical text and stays clean", () => {
  const store = new MessageStore(":memory:");
  const original = message(1, { text: "canonical projection" });
  store.upsertMessages(CHAT, [original]);
  commitChunk(store, [original]);

  store.upsertMessages(CHAT, [
    message(1, { text: "", textAvailable: false }),
  ]);

  const [stored] = store.getHistory({
    chatId: CHAT.chatId,
    limit: 1,
    order: "asc",
  });
  assert.equal(stored?.text, "canonical projection");
  assertClean(store, 1);
  store.close();
});

test("real embedding source edits still dirty committed chunks", () => {
  const cases: Array<{
    name: string;
    base: StoredMessage;
    changed: StoredMessage;
  }> = [
    {
      name: "text",
      base: message(1, { text: "before edit" }),
      changed: message(1, { text: "after edit" }),
    },
    {
      name: "date",
      base: message(1, { text: "same text" }),
      changed: message(1, { date: "2026-08-06T12:00:00.000Z", text: "same text" }),
    },
    {
      name: "senderName",
      base: message(1, { text: "same text" }),
      changed: message(1, { senderName: "Bob", text: "same text" }),
    },
    {
      name: "senderId fallback",
      base: message(1, { senderId: "42", senderName: undefined, text: "same text" }),
      changed: message(1, { senderId: "999", senderName: undefined, text: "same text" }),
    },
    {
      name: "deletedAt",
      base: message(1, { text: "same text" }),
      changed: message(1, { deletedAt: "2026-08-05T13:00:00.000Z", text: "same text" }),
    },
  ];

  for (const { name, base, changed } of cases) {
    const store = new MessageStore(":memory:");
    store.upsertMessages(CHAT, [base]);
    commitChunk(store, [base]);

    store.upsertMessages(CHAT, [changed]);

    assertDirty(store, 1, `${name} edit must dirty the chunk`);
    store.close();
  }
});

test("bot update replay of an identical message keeps chunks clean", () => {
  const store = new MessageStore(":memory:");
  const original = message(7, { text: "@bot hello" });
  store.upsertMessages(CHAT, [original]);
  commitChunk(store, [original]);

  ingestBotMessage(store, 101, { ...original });
  ingestBotMessage(store, 102, {
    ...original,
    rawJson: JSON.stringify({ message_id: 7 }),
  });

  assertClean(store, 7);
  store.close();
});

test("bot update that edits the message source dirties the chunk", () => {
  const store = new MessageStore(":memory:");
  const original = message(7, { text: "@bot hello" });
  store.upsertMessages(CHAT, [original]);
  commitChunk(store, [original]);

  ingestBotMessage(store, 101, message(7, { text: "@bot edited" }));

  assertDirty(store, 7, "bot message edit must dirty the chunk");
  store.close();
});

function message(
  messageId: number,
  overrides: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    date: "2026-08-05T12:00:00.000Z",
    senderId: "42",
    senderName: "Alice",
    text: "base text",
    ...overrides,
  };
}

function commitChunk(store: MessageStore, messages: StoredMessage[]): void {
  const sorted = [...messages].sort((a, b) => a.messageId - b.messageId);
  const text = renderEmbeddingChunkSource(sorted, CHUNK_MAX_CHARS);
  const vector: EmbeddingChunkVector = {
    chatId: CHAT.chatId,
    startMessageId: sorted[0]!.messageId,
    endMessageId: sorted.at(-1)!.messageId,
    messageIds: sorted.map((item) => item.messageId),
    messageCount: sorted.length,
    text,
    namespace: CHUNK_NAMESPACE,
    model: CHUNK_MODEL,
    dimensions: CHUNK_DIMENSIONS,
    embedding: Buffer.alloc(CHUNK_DIMENSIONS * 4),
    contentHash: fingerprintEmbeddingSource(text),
  };
  const result = store.commitEmbeddingChunksIfCurrent(
    [vector],
    CHUNK_MAX_CHARS,
  );
  assert.equal(result.committedChunks, 1, "fixture chunk must commit");
}

function chunksContaining(
  store: MessageStore,
  messageId: number,
): Array<{ dirtyAt?: string }> {
  return store
    .getEmbeddingChunks({
      chatId: CHAT.chatId,
      namespace: CHUNK_NAMESPACE,
      model: CHUNK_MODEL,
      dimensions: CHUNK_DIMENSIONS,
      includeDirty: true,
    })
    .filter(
      (chunk) =>
        chunk.startMessageId <= messageId && messageId <= chunk.endMessageId,
    );
}

function assertClean(store: MessageStore, messageId: number): void {
  const matching = chunksContaining(store, messageId);
  assert.equal(matching.length, 1, "message must stay in exactly one chunk");
  assert.equal(matching[0]!.dirtyAt, undefined);
}

function assertDirty(
  store: MessageStore,
  messageId: number,
  label: string,
): void {
  const matching = chunksContaining(store, messageId);
  assert.equal(matching.length, 1, "message must stay in exactly one chunk");
  assert.notEqual(matching[0]!.dirtyAt, undefined, label);
}

function ingestBotMessage(
  store: MessageStore,
  _updateId: number,
  botMessage: StoredMessage,
): void {
  store.upsertMessages(CHAT, [botMessage]);
}
