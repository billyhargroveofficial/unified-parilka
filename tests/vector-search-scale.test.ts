import assert from "node:assert/strict";
import { test } from "node:test";
import { vectorToBlob } from "../src/embeddings.js";
import { MessageStore } from "../src/store.js";
import type { VectorBackend } from "../src/vector/backend.js";
import { VectorSearcher } from "../src/vector/search.js";
import { CHAT, config, namespace } from "./support/vector-rag.js";

test("dense search scores a large bounded corpus before hydrating only ranked memberships", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  const cfg = config({ dimensions: 2, vectorCandidateLimit: 50_000 });
  const ns = namespace({ dimensions: 2, vectorCandidateLimit: 50_000 });
  store.upsertEmbeddingChunks(
    Array.from({ length: 1_000 }, (_, index) => {
      const messageId = index + 1;
      return {
        chatId: CHAT.chatId,
        startMessageId: messageId,
        endMessageId: messageId,
        messageIds: [messageId],
        messageCount: 1,
        text: `chunk ${messageId}`,
        namespace: ns,
        model: cfg.embeddings.model,
        dimensions: 2,
        embedding: vectorToBlob(messageId <= 3 ? [1, 0] : [0, 1]),
        contentHash: `chunk-${messageId}`,
      };
    }),
  );
  const storePort = store as unknown as {
    getEmbeddingChunks: typeof store.getEmbeddingChunks;
    getEmbeddingChunkMessageIds: typeof store.getEmbeddingChunkMessageIds;
    getEmbeddingCoverageStats: typeof store.getEmbeddingCoverageStats;
  };
  const getChunks = storePort.getEmbeddingChunks.bind(store);
  const getMessageIds = storePort.getEmbeddingChunkMessageIds.bind(store);
  const getCoverageStats = storePort.getEmbeddingCoverageStats.bind(store);
  let requestedUnhydratedRows = 0;
  let hydratedRows = 0;
  let coverageCalls = 0;
  storePort.getEmbeddingChunks = (params) => {
    if (params.hydrateMessageIds === false) requestedUnhydratedRows += 1;
    return getChunks(params);
  };
  storePort.getEmbeddingChunkMessageIds = (params) => {
    hydratedRows += params.chunkIds.length;
    return getMessageIds(params);
  };
  storePort.getEmbeddingCoverageStats = (params) => {
    coverageCalls += 1;
    return getCoverageStats(params);
  };
  const backend: VectorBackend = {
    kind: "external_openai",
    model: cfg.embeddings.model,
    dimensions: 2,
    namespace: ns,
    supportsSparse: false,
    supportsRerank: false,
    maxEncodeBatch: 1,
    isConfigured: true,
    assertConfigured() {},
    providerLabel() { return "test"; },
    privacyNotice() { return "test"; },
    async encodeChunks() { return []; },
    async encodeQuery() { return { dense: [1, 0], sparseTerms: [] }; },
    async rerank() { return []; },
  };

  const result = await new VectorSearcher(cfg, store, backend, ns).search({
    chatId: CHAT.chatId,
    query: "needle",
    limit: 3,
    includeMessages: false,
  });

  assert.equal(result.available, true);
  assert.equal(result.candidateCount, 1_000);
  assert.equal(requestedUnhydratedRows, 1);
  assert.equal(hydratedRows, 3, "membership hydration must be proportional to ranked hits, not corpus size");
  assert.equal(coverageCalls, 0, "interactive search must not execute full-corpus coverage diagnostics");
  assert.deepEqual(result.hits.map((hit) => hit.chunk.messageIds), [[1], [2], [3]]);
});

test("lightweight search metadata preserves index identity while full stats retain coverage diagnostics", (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  const cfg = config({ dimensions: 2 });
  const ns = namespace({ dimensions: 2 });
  store.upsertMessages(CHAT, [{
    chatId: CHAT.chatId,
    messageId: 1,
    senderName: "alice",
    text: "metadata fixture",
  }]);
  store.upsertEmbeddingChunks([{
    chatId: CHAT.chatId,
    startMessageId: 1,
    endMessageId: 1,
    messageIds: [1],
    messageCount: 1,
    text: "metadata fixture",
    namespace: ns,
    model: cfg.embeddings.model,
    dimensions: 2,
    embedding: vectorToBlob([1, 0]),
    contentHash: "metadata",
  }]);

  const lightweight = store.getEmbeddingSearchStats(CHAT.chatId, { namespace: ns });
  const diagnostic = store.getEmbeddingStats(CHAT.chatId, { namespace: ns });
  assert.deepEqual(
    lightweight.map(indexIdentity),
    diagnostic.map(indexIdentity),
  );
  assert.equal(Object.hasOwn(lightweight[0]!, "cache_messages"), false);
  assert.equal(Number(diagnostic[0]?.cache_messages), 1);
  assert.equal(Number(diagnostic[0]?.indexed_messages), 1);
});

function indexIdentity(row: Record<string, unknown>): Record<string, unknown> {
  return {
    namespace: row.namespace,
    model: row.model,
    dimensions: row.dimensions,
    chunks: row.chunks,
    oldest_message_id: row.oldest_message_id,
    newest_message_id: row.newest_message_id,
    indexed_messages: row.indexed_messages,
    dirty_chunks: row.dirty_chunks,
    updated_at: row.updated_at,
  };
}
