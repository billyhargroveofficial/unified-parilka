import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fingerprintEmbeddingSource } from "../src/embedding-source.js";
import {
  MAX_SPARSE_QUERY_TERMS,
  MessageStore,
  type SparseTerm,
  type StoredMessage,
} from "../src/store.js";
import type { ChatInfo } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "supergroup",
};
const NAMESPACE = "test-namespace";
const MODEL = "bge-m3";
const DIMENSIONS = 4;

function tempStore(t: TestContext): MessageStore {
  const dir = mkdtempSync(join(tmpdir(), "parilka-sparse-postings-"));
  const store = new MessageStore(join(dir, "messages.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function tempStorePath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "parilka-sparse-rehearsal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "messages.sqlite");
}

function message(messageId: number, text: string): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    date: `2026-08-0${Math.min(9, messageId)}T12:00:00.000Z`,
    senderId: `user-${messageId}`,
    senderName: `user_${messageId}`,
    text,
  };
}

function embeddingVector(seed: number): Buffer {
  const buffer = Buffer.alloc(DIMENSIONS * 4);
  for (let index = 0; index < DIMENSIONS; index += 1) {
    buffer.writeFloatLE((seed + index) / 16, index * 4);
  }
  return buffer;
}

function chunkInput(params: {
  messages: StoredMessage[];
  sparseTerms?: SparseTerm[];
  namespace?: string;
}) {
  const messages = params.messages;
  const text = messages
    .map(
      (item) =>
        `[${item.messageId} ${item.date}] ${item.senderName}: ${item.text}`,
    )
    .join("\n");
  return {
    chatId: CHAT.chatId,
    startMessageId: messages[0]!.messageId,
    endMessageId: messages.at(-1)!.messageId,
    messageIds: messages.map((item) => item.messageId),
    messageCount: messages.length,
    text,
    namespace: params.namespace ?? NAMESPACE,
    model: MODEL,
    dimensions: DIMENSIONS,
    embedding: embeddingVector(messages[0]!.messageId),
    contentHash: fingerprintEmbeddingSource(text),
    ...(params.sparseTerms === undefined
      ? {}
      : { sparseTerms: params.sparseTerms }),
  };
}

test("fresh schema v21 creates sparse postings objects and is idempotent", (t) => {
  const dbPath = tempStorePath(t);
  const store = new MessageStore(dbPath);
  assert.equal(store.getSchemaVersion(), 24);
  store.close();
  // Second open must be a no-op migration over identical objects.
  const reopened = new MessageStore(dbPath);
  assert.equal(reopened.getSchemaVersion(), 24);
  reopened.close();
});

test("temp-DB rehearsal migrates v20 to v21 idempotently", (t) => {
  const dbPath = tempStorePath(t);
  const seed = new MessageStore(dbPath);
  seed.close();

  const downgrade = new DatabaseSync(dbPath);
  try {
    downgrade.exec(`
      PRAGMA user_version = 20;
      DROP INDEX IF EXISTS idx_embedding_sparse_terms_lookup;
      DROP TABLE IF EXISTS message_embedding_sparse_terms;
      DROP TRIGGER IF EXISTS embedding_chunks_ad;
      CREATE TRIGGER embedding_chunks_ad AFTER DELETE ON message_embedding_chunks BEGIN
        DELETE FROM message_embedding_chunk_messages WHERE chunk_id = old.id;
      END;
    `);
  } finally {
    downgrade.close();
  }

  const migrated = new MessageStore(dbPath);
  try {
    assert.equal(migrated.getSchemaVersion(), 24);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_embedding_sparse_terms'",
        )
        .get() as Record<string, unknown> | undefined;
      assert.ok(table, "sparse postings table must exist after migration");
      const index = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_embedding_sparse_terms_lookup'",
        )
        .get() as Record<string, unknown> | undefined;
      assert.ok(index, "sparse lookup index must exist after migration");
      const trigger = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'embedding_chunks_ad'",
        )
        .get() as Record<string, unknown> | undefined;
      assert.match(
        String(trigger?.sql ?? ""),
        /message_embedding_sparse_terms/,
        "delete trigger must clean sparse postings",
      );
      const quick = db.prepare("PRAGMA quick_check").all();
      assert.equal(String(Object.values(quick[0]!)[0]), "ok");
    } finally {
      db.close();
    }
  } finally {
    migrated.close();
  }

  // Idempotent second migration pass.
  const again = new MessageStore(dbPath);
    assert.equal(again.getSchemaVersion(), 24);
  again.close();
});

test("commit stores dense and sparse atomically and rejects stale source", (t) => {
  const store = tempStore(t);
  const messages = [message(1, "первое сообщение"), message(2, "второе")];
  store.upsertMessages(CHAT, messages);

  const terms: SparseTerm[] = [
    { tokenId: 11, weight: 0.7 },
    { tokenId: 5, weight: 0.2 },
  ];
  const committed = store.commitEmbeddingChunksIfCurrent(
    [chunkInput({ messages, sparseTerms: terms })],
    1_600,
  );
  assert.equal(committed.committedChunks, 1);
  const postings = store.getSparseTermPostings({
    chatId: CHAT.chatId,
    namespace: NAMESPACE,
    model: MODEL,
    dimensions: DIMENSIONS,
    terms: [{ tokenId: 11, weight: 1 }],
    limit: 10,
  });
  assert.equal(postings.length, 1);
  assert.ok(Math.abs(postings[0]!.score - 0.7) < 1e-6);

  const tampered = chunkInput({
    messages,
    sparseTerms: [{ tokenId: 99, weight: 0.9 }],
  });
  const stale = store.commitEmbeddingChunksIfCurrent(
    [{ ...tampered, contentHash: "deadbeef" }],
    1_600,
  );
  assert.equal(stale.committedChunks, 0);
  assert.equal(stale.staleRanges.length, 1);
  const untouched = store.getSparseTermPostings({
    chatId: CHAT.chatId,
    namespace: NAMESPACE,
    model: MODEL,
    dimensions: DIMENSIONS,
    terms: [{ tokenId: 99, weight: 1 }],
    limit: 10,
  });
  assert.equal(untouched.length, 0, "stale commit must not write postings");
});

test("upsert replaces postings and delete cascades them away", (t) => {
  const store = tempStore(t);
  const messages = [message(1, "обсуждение релиза")];
  store.upsertMessages(CHAT, messages);

  store.commitEmbeddingChunksIfCurrent(
    [chunkInput({ messages, sparseTerms: [{ tokenId: 3, weight: 0.5 }] })],
    1_600,
  );
  store.commitEmbeddingChunksIfCurrent(
    [
      chunkInput({
        messages,
        sparseTerms: [{ tokenId: 7, weight: 0.8 }],
      }),
    ],
    1_600,
  );
  assert.equal(
    store.getSparseTermPostings({
      chatId: CHAT.chatId,
      namespace: NAMESPACE,
      model: MODEL,
      dimensions: DIMENSIONS,
      terms: [{ tokenId: 3, weight: 1 }],
      limit: 10,
    }).length,
    0,
    "old postings must be replaced",
  );
  assert.equal(
    store.getSparseTermPostings({
      chatId: CHAT.chatId,
      namespace: NAMESPACE,
      model: MODEL,
      dimensions: DIMENSIONS,
      terms: [{ tokenId: 7, weight: 1 }],
      limit: 10,
    }).length,
    1,
  );

  const deleted = store.deleteEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: NAMESPACE,
  });
  assert.equal(deleted, 1);
  assert.equal(
    store.getSparseTermPostings({
      chatId: CHAT.chatId,
      namespace: NAMESPACE,
      model: MODEL,
      dimensions: DIMENSIONS,
      terms: [{ tokenId: 7, weight: 1 }],
      limit: 10,
    }).length,
    0,
    "deleting the parent chunk must cascade postings",
  );
});

test("dirty chunks are excluded from sparse retrieval", (t) => {
  const store = tempStore(t);
  const messages = [message(1, "исходный текст")];
  store.upsertMessages(CHAT, messages);
  store.commitEmbeddingChunksIfCurrent(
    [chunkInput({ messages, sparseTerms: [{ tokenId: 2, weight: 0.4 }] })],
    1_600,
  );

  store.markMessagesDeleted(CHAT.chatId, [1]);

  assert.deepEqual(
    store.getSparseTermPostings({
      chatId: CHAT.chatId,
      namespace: NAMESPACE,
      model: MODEL,
      dimensions: DIMENSIONS,
      terms: [{ tokenId: 2, weight: 1 }],
      limit: 10,
    }),
    [],
  );
  assert.deepEqual(
    store.searchSparseChunks({
      chatId: CHAT.chatId,
      namespace: NAMESPACE,
      model: MODEL,
      dimensions: DIMENSIONS,
      terms: [{ tokenId: 2, weight: 1 }],
      limit: 10,
    }),
    [],
  );
});

test("searchSparseChunks hydrates scored chunks with message ids", (t) => {
  const store = tempStore(t);
  const first = [message(1, "альфа")];
  const second = [message(2, "бета")];
  store.upsertMessages(CHAT, [...first, ...second]);
  store.commitEmbeddingChunksIfCurrent(
    [
      chunkInput({ messages: first, sparseTerms: [{ tokenId: 1, weight: 0.9 }] }),
      chunkInput({ messages: second, sparseTerms: [{ tokenId: 1, weight: 0.3 }] }),
    ],
    1_600,
  );

  const hits = store.searchSparseChunks({
    chatId: CHAT.chatId,
    namespace: NAMESPACE,
    model: MODEL,
    dimensions: DIMENSIONS,
    terms: [{ tokenId: 1, weight: 1 }],
    limit: 10,
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.chunk.startMessageId, 1);
  assert.ok(hits[0]!.score > hits[1]!.score);
  assert.deepEqual(hits[0]!.chunk.messageIds, [1]);

  const otherNamespace = store.searchSparseChunks({
    chatId: CHAT.chatId,
    namespace: "other",
    model: MODEL,
    dimensions: DIMENSIONS,
    terms: [{ tokenId: 1, weight: 1 }],
    limit: 10,
  });
  assert.equal(otherNamespace.length, 0, "namespace isolation is enforced");
});

test("window filters prevent out-of-window starvation", (t) => {
  const store = tempStore(t);
  const early = [
    message(1, "раннее сообщение окна"),
    message(2, "раннее продолжение окна"),
  ];
  const late = [
    message(3, "позднее сообщение окна"),
    message(4, "позднее продолжение окна"),
  ];
  store.upsertMessages(CHAT, [...early, ...late]);
  store.commitEmbeddingChunksIfCurrent(
    [
      chunkInput({
        messages: early,
        sparseTerms: [{ tokenId: 77, weight: 0.9 }],
      }),
    ],
    1_600,
  );
  store.commitEmbeddingChunksIfCurrent(
    [
      chunkInput({
        messages: late,
        sparseTerms: [{ tokenId: 77, weight: 0.1 }],
      }),
    ],
    1_600,
  );

  // The early chunk has the higher score; without the window filter it
  // would starve the in-window candidate at limit 1.
  const afterWindow = store.searchSparseChunks({
    chatId: CHAT.chatId,
    namespace: NAMESPACE,
    model: MODEL,
    dimensions: DIMENSIONS,
    terms: [{ tokenId: 77, weight: 1 }],
    limit: 1,
    afterId: 2,
  });
  assert.equal(afterWindow.length, 1);
  assert.equal(afterWindow[0]!.chunk.startMessageId, 3);

  const beforeWindow = store.searchSparseChunks({
    chatId: CHAT.chatId,
    namespace: NAMESPACE,
    model: MODEL,
    dimensions: DIMENSIONS,
    terms: [{ tokenId: 77, weight: 1 }],
    limit: 1,
    beforeId: 3,
  });
  assert.equal(beforeWindow.length, 1);
  assert.equal(beforeWindow[0]!.chunk.startMessageId, 1);

  const postings = store.getSparseTermPostings({
    chatId: CHAT.chatId,
    namespace: NAMESPACE,
    model: MODEL,
    dimensions: DIMENSIONS,
    terms: [{ tokenId: 77, weight: 1 }],
    limit: 10,
    afterId: 2,
  });
  assert.equal(postings.length, 1);
});

test("hydration stays bounded and ordered across id batches", (t) => {
  const store = tempStore(t);
  const chunks = Array.from({ length: 1_200 }, (_unused, index) => {
    const messageId = index + 1;
    return {
      chatId: CHAT.chatId,
      startMessageId: messageId,
      endMessageId: messageId,
      messageIds: [messageId],
      messageCount: 1,
      text: `chunk ${messageId}`,
      namespace: NAMESPACE,
      model: MODEL,
      dimensions: DIMENSIONS,
      embedding: embeddingVector(messageId),
      contentHash: `hash-${messageId}`,
      sparseTerms: [{ tokenId: 55, weight: 0.5 }],
    };
  });
  store.upsertEmbeddingChunks(chunks);

  // 1200 ids exceed one hydration batch (500); the implementation must
  // batch the IN clause without losing posting order.
  const hits = store.searchSparseChunks({
    chatId: CHAT.chatId,
    namespace: NAMESPACE,
    model: MODEL,
    dimensions: DIMENSIONS,
    terms: [{ tokenId: 55, weight: 1 }],
    limit: 1_200,
  });
  assert.equal(hits.length, 1_200);
  for (const [index, hit] of hits.entries()) {
    assert.equal(hit.chunk.startMessageId, index + 1);
  }
});

test("sparse term bounds are validated", (t) => {
  const store = tempStore(t);
  assert.throws(() =>
    store.getSparseTermPostings({
      chatId: CHAT.chatId,
      namespace: NAMESPACE,
      model: MODEL,
      dimensions: DIMENSIONS,
      terms: [{ tokenId: -1, weight: 1 }],
      limit: 10,
    }),
  );
  assert.throws(() =>
    store.getSparseTermPostings({
      chatId: CHAT.chatId,
      namespace: NAMESPACE,
      model: MODEL,
      dimensions: DIMENSIONS,
      terms: [{ tokenId: 1, weight: Number.NaN }],
      limit: 10,
    }),
  );
  const overflow = Array.from(
    { length: MAX_SPARSE_QUERY_TERMS + 1 },
    (_unused, index) => ({ tokenId: index, weight: 0.1 }),
  );
  assert.throws(() =>
    store.getSparseTermPostings({
      chatId: CHAT.chatId,
      namespace: NAMESPACE,
      model: MODEL,
      dimensions: DIMENSIONS,
      terms: overflow,
      limit: 10,
    }),
  );
  assert.throws(() =>
    store.commitEmbeddingChunksIfCurrent(
      [
        chunkInput({
          messages: [message(1, "текст")],
          sparseTerms: [{ tokenId: 1, weight: 0 }],
        }),
      ],
      1_600,
    ),
  );
});
