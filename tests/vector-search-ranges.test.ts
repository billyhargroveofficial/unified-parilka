import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import { VectorRag } from "../src/vector-rag.js";
import {
  CHAT,
  config,
  mockEmbeddingFetch,
  namespace,
} from "./support/vector-rag.js";

test("vector hits hydrate exact chunk message ids across empty messages", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config(), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "media", text: "" },
    { chatId: CHAT.chatId, messageId: 3, senderName: "bob", text: "needle beta" },
  ]);

  await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });
  const [chunk] = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: namespace(),
    model: config().embeddings.model,
    dimensions: config().embeddings.dimensions,
  });
  assert.deepEqual(chunk?.messageIds, [1, 3]);
  assert.equal(chunk?.startMessageId, 1);
  assert.equal(chunk?.endMessageId, 3);

  const search = await vectorRag.search({ chatId: CHAT.chatId, query: "needle", limit: 1, includeMessages: true });
  assert.deepEqual(
    search.hits[0]?.messages.map((message) => message.messageId),
    [1, 3],
  );
});

test("vector range filters trim after windows and exclude before-boundary crossing chunks", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ chunkMessages: 3 }), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "outside alpha" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "needle beta" },
    { chatId: CHAT.chatId, messageId: 3, senderName: "carol", text: "needle gamma" },
  ]);

  await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });

  const after = await vectorRag.search({
    chatId: CHAT.chatId,
    query: "needle",
    afterId: 1,
    limit: 5,
    includeMessages: true,
  });
  assert.deepEqual(after.hits[0]?.chunk.messageIds, [2, 3]);
  assert.deepEqual(
    after.hits[0]?.messages.map((message) => message.messageId),
    [2, 3],
  );
  assert.equal(after.hits[0]?.chunk.startMessageId, 2);
  assert.doesNotMatch(after.hits[0]?.chunk.text ?? "", /outside alpha/);

  const before = await vectorRag.search({
    chatId: CHAT.chatId,
    query: "needle",
    beforeId: 2,
    limit: 5,
    includeMessages: true,
  });
  assert.equal(before.candidateCount, 0);
  assert.deepEqual(before.hits, []);
  assert.deepEqual(before.sparseHits, []);
  // The sole indexed chunk spans ids 1..3. Returning just id 1 after the
  // fact would still score an embedding built from ids 2 and 3, so strict
  // causality excludes the crossing chunk before any dense/sparse scoring.

  const keywordHits = store.searchWithRank({
    chatId: CHAT.chatId,
    query: "needle",
    afterId: 1,
    limit: 10,
  });
  const hybrid = vectorRag.hybrid(keywordHits, after.hits, 10);

  assert.equal(hybrid.some((hit) => hit.messageId === 1 || hit.startMessageId === 1), false);
  assert.equal(hybrid.some((hit) => hit.source === "hybrid" && hit.messageId === 2), true);
});
