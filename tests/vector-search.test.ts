import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blobToVector,
  cosineSimilarity,
  createBlobCosineScorer,
  embeddingNamespace,
  localBgeM3Namespace,
  vectorToBlob,
} from "../src/embeddings.js";
import { MessageStore } from "../src/store.js";
import { rowToEmbeddingChunk } from "../src/storage/mappers.js";
import { VectorRag } from "../src/vector-rag.js";
import {
  CHAT,
  config,
  mockEmbeddingFetch,
  mockFetch,
  namespace,
} from "./support/vector-rag.js";

test("vector decoding rejects corrupt blob sizes, dimensions, and values", () => {
  assert.throws(
    () => blobToVector(new Uint8Array([1, 2, 3])),
    /byte length must be divisible by 4/u,
  );
  assert.throws(
    () => blobToVector(vectorToBlob([1, 0]), 3),
    /expected 3 dimensions but received 2/u,
  );
  const nonFinite = Buffer.alloc(4);
  nonFinite.writeFloatLE(Number.NaN, 0);
  assert.throws(
    () => blobToVector(nonFinite),
    /non-finite/u,
  );
  assert.throws(
    () => cosineSimilarity([1], [1, 0]),
    /same dimensions/u,
  );
});

test("blob cosine scorer validates candidates in one pass without caching a stale vector", () => {
  const query = [1, 0];
  const scoreBlob = createBlobCosineScorer(query);
  const blob = vectorToBlob([1, 0]);
  assert.equal(scoreBlob(blob, 2), 1);

  // A post-construction mutation cannot bypass the finite-query validation.
  query[0] = Number.NaN;
  assert.equal(scoreBlob(blob, 2), 1);

  // The scorer owns only the validated query. It must observe the BLOB passed
  // to each call directly, rather than retaining a materialized candidate.
  blob.writeFloatLE(0, 0);
  blob.writeFloatLE(1, 4);
  assert.equal(scoreBlob(blob, 2), 0);

  const unaligned = new Uint8Array(new ArrayBuffer(9), 1, 8);
  unaligned.set(blob);
  assert.equal(scoreBlob(unaligned, 2), 0, "unaligned BLOB uses the portable reader");

  assert.throws(
    () => scoreBlob(new Uint8Array([1, 2, 3]), 2),
    /byte length must be divisible by 4/u,
  );
  assert.throws(
    () => scoreBlob(vectorToBlob([1]), 2),
    /expected 2 dimensions but received 1/u,
  );
  const nonFinite = Buffer.alloc(8);
  nonFinite.writeFloatLE(1, 0);
  nonFinite.writeFloatLE(Number.NaN, 4);
  assert.throws(() => scoreBlob(nonFinite, 2), /non-finite/u);
  assert.throws(
    () => createBlobCosineScorer([Number.NaN]),
    /finite vector values/u,
  );
});

test("embedding row mapper rejects a BLOB with the wrong dimension", () => {
  assert.throws(
    () =>
      rowToEmbeddingChunk({
        id: 1,
        chat_id: "chat",
        start_message_id: 1,
        end_message_id: 1,
        message_count: 1,
        text: "text",
        embedding_model: "model",
        embedding_dimensions: 2,
        embedding: vectorToBlob([1]),
        content_hash: "hash",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    /Embedding BLOB has 1 dimensions but row declares 2/u,
  );
});

test("embedding indexing respects chunk and character budgets", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(
    config({ chunkMessages: 1, maxChunksPerRun: 2, maxCharsPerRun: 500_000 }),
    store,
  );
  store.upsertMessages(
    CHAT,
    [1, 2, 3, 4, 5].map((messageId) => ({
      chatId: CHAT.chatId,
      messageId,
      senderName: "alice",
      text: `budget message ${messageId}`,
    })),
  );

  const estimate = vectorRag.estimateIndexCachedMessages({ chatId: CHAT.chatId, limitChunks: 10 });
  assert.equal(estimate.requestedLimitChunks, 10);
  assert.equal(estimate.limitChunks, 2);
  assert.equal(estimate.budget.truncatedByChunkBudget, true);
  assert.equal(estimate.estimatedChunks, 2);

  const result = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 10,
    confirmFirstRun: true,
  });
  assert.equal(result.chunksCreated, 2);
  assert.equal(result.messagesCovered, 2);
  assert.equal(result.coverage.uncovered_messages, 3);

  const charBudgetStore = new MessageStore(":memory:");
  const charBudgetRag = new VectorRag(config({ maxCharsPerRun: 1 }), charBudgetStore);
  charBudgetStore.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "too large" }]);
  const charEstimate = charBudgetRag.estimateIndexCachedMessages({ chatId: CHAT.chatId, limitChunks: 10 });
  assert.equal(charEstimate.estimatedChunks, 0);
  assert.equal(charEstimate.budget.truncatedByCharBudget, true);
});

test("embedding dimension mismatch fails indexing clearly", async (t) => {
  mockFetch(t, async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ dimensions: 2 }), store);
  store.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" }]);

  await assert.rejects(
    () =>
      vectorRag.indexCachedMessages({
        chatId: CHAT.chatId,
        limitChunks: 1,
        confirmFirstRun: true,
      }),
    /Embedding API returned 3 dimensions for input 0; expected TELEGRAM_EMBEDDINGS_DIMENSIONS=2/,
  );
  assert.equal(
    store.getEmbeddingChunks({
      chatId: CHAT.chatId,
      namespace: namespace({ dimensions: 2 }),
      model: config().embeddings.model,
      dimensions: 2,
    }).length,
    0,
  );
});

test("vector search uses actual query dimensions for mixed indexes", async (t) => {
  mockFetch(t, async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ dimensions: undefined }), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "two dimensional needle" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "three dimensional distractor" },
  ]);
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1,
      endMessageId: 1,
      messageIds: [1],
      messageCount: 1,
      text: "two dimensional needle",
      namespace: namespace({ dimensions: undefined }),
      model: config().embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([1, 0]),
      contentHash: "two",
    },
    {
      chatId: CHAT.chatId,
      startMessageId: 2,
      endMessageId: 2,
      messageIds: [2],
      messageCount: 1,
      text: "three dimensional distractor",
      namespace: namespace({ dimensions: undefined }),
      model: config().embeddings.model,
      dimensions: 3,
      embedding: vectorToBlob([1, 0, 0]),
      contentHash: "three",
    },
  ]);

  const result = await vectorRag.search({ chatId: CHAT.chatId, query: "needle", limit: 10, includeMessages: true });

  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.chunk.dimensions, 2);
  assert.equal(result.hits[0]?.messages[0]?.messageId, 1);
  assert.deepEqual(
    result.stats.map((row) => row.dimensions).sort(),
    [2, 3],
  );
});

test("changing provider or model starts a separate confirmed namespace", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const firstConfig = config();
  const firstRag = new VectorRag(firstConfig, store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "namespace alpha" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "namespace beta" },
  ]);

  const first = await firstRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });
  assert.equal(first.namespace, embeddingNamespace(firstConfig));
  assert.equal(first.normalizationVersion, "l2-v1");

  const providerConfig = config({ baseUrl: "https://embeddings.example.test/v1" });
  const providerEstimate = new VectorRag(providerConfig, store).estimateIndexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
  });
  assert.notEqual(providerEstimate.namespace, first.namespace);
  assert.equal(providerEstimate.firstRun, true);
  assert.equal(providerEstimate.requiresConfirmation, true);
  assert.equal(providerEstimate.existingChunks, 0);
  assert.equal(providerEstimate.coverage.indexed_messages, 0);
  assert.equal(providerEstimate.coverage.uncovered_messages, 2);

  const modelConfig = config({ model: "other-embedding-model" });
  const modelEstimate = new VectorRag(modelConfig, store).estimateIndexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
  });
  assert.notEqual(modelEstimate.namespace, first.namespace);
  assert.equal(modelEstimate.firstRun, true);
  assert.equal(modelEstimate.requiresConfirmation, true);
  assert.equal(modelEstimate.coverage.uncovered_messages, 2);

  const stats = store.getEmbeddingStats(CHAT.chatId);
  assert.equal(stats.some((row) => row.namespace === first.namespace), true);
});

test("embedding estimate and namespace exclude URL credentials", () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "credential safety" },
  ]);
  const firstConfig = config({
    baseUrl: "https://alice:password@embeddings.example.test/v1?api_key=first&region=eu",
  });
  const rotatedConfig = config({
    baseUrl: "https://bob:other@embeddings.example.test/v1?api_key=second&region=eu",
  });
  const otherEndpointConfig = config({
    baseUrl: "https://bob:other@embeddings.example.test/v1?api_key=second&region=us",
  });

  const estimate = new VectorRag(firstConfig, store).estimateIndexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
  });

  assert.equal(estimate.baseUrl.includes("password"), false);
  assert.equal(estimate.baseUrl.includes("first"), false);
  assert.equal(estimate.baseUrl.includes("alice"), false);
  assert.equal(embeddingNamespace(firstConfig), embeddingNamespace(rotatedConfig));
  assert.notEqual(embeddingNamespace(firstConfig), embeddingNamespace(otherEndpointConfig));
});

test("vector search only compares chunks from the current namespace", async (t) => {
  mockFetch(t, async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const store = new MessageStore(":memory:");
  const currentConfig = config({ baseUrl: "https://current-provider.example.test/v1" });
  const currentNamespace = embeddingNamespace(currentConfig);
  const otherNamespace = embeddingNamespace(config({ baseUrl: "https://other-provider.example.test/v1" }));
  const vectorRag = new VectorRag(currentConfig, store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "other namespace perfect match" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "current namespace weak match" },
  ]);
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1,
      endMessageId: 1,
      messageIds: [1],
      messageCount: 1,
      text: "other namespace perfect match",
      namespace: otherNamespace,
      model: currentConfig.embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([1, 0]),
      contentHash: "other",
    },
    {
      chatId: CHAT.chatId,
      startMessageId: 2,
      endMessageId: 2,
      messageIds: [2],
      messageCount: 1,
      text: "current namespace weak match",
      namespace: currentNamespace,
      model: currentConfig.embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([0, 1]),
      contentHash: "current",
    },
  ]);

  const result = await vectorRag.search({ chatId: CHAT.chatId, query: "perfect", limit: 5, includeMessages: true });

  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.chunk.namespace, currentNamespace);
  assert.equal(result.hits[0]?.messages[0]?.messageId, 2);
  assert.deepEqual(result.stats.map((row) => row.namespace), [currentNamespace]);
});

test("vector search refuses candidate sets above the configured bound", async (t) => {
  mockFetch(t, async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ dimensions: 2, vectorCandidateLimit: 1 }), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "first" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "second" },
  ]);
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1,
      endMessageId: 1,
      messageIds: [1],
      messageCount: 1,
      text: "first",
      namespace: namespace({ dimensions: 2, vectorCandidateLimit: 1 }),
      model: config().embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([1, 0]),
      contentHash: "first",
    },
    {
      chatId: CHAT.chatId,
      startMessageId: 2,
      endMessageId: 2,
      messageIds: [2],
      messageCount: 1,
      text: "second",
      namespace: namespace({ dimensions: 2, vectorCandidateLimit: 1 }),
      model: config().embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([0, 1]),
      contentHash: "second",
    },
  ]);

  const capped = await vectorRag.search({ chatId: CHAT.chatId, query: "first", limit: 1 });
  assert.equal(capped.available, false, "dense channel degrades instead of throwing");
  assert.match(capped.error ?? "", /Vector search candidate limit 1 exceeded/);
  assert.deepEqual(capped.hits, []);
  assert.equal(capped.candidateCount, 2);
  assert.equal(capped.candidateLimit, 1);
  assert.deepEqual(capped.sparseHits, []);
  assert.equal(capped.sparseAvailable, undefined, "external backend has no sparse channel");
  assert.equal(capped.backend, "external_openai");
});

test("local BGE-M3 dense cap exceeded but sparseAvailable true and sparseHits nonempty", async (t) => {
  const dimensions = 1024;
  const denseVec = Array<number>(dimensions).fill(0);
  denseVec[0] = 1;
  mockFetch(t, async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as {
      contract?: string;
      texts?: string[];
    };
    if (body.texts) {
      return new Response(
        JSON.stringify({
          contract: "bge-m3-v1",
          model: "BAAI/bge-m3",
          results: body.texts.map(() => ({
            dense: denseVec,
            sparse: [{ token_id: 1, weight: 0.5 }],
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 400 });
  });
  const cfg = config({
    backend: "local_bge_m3",
    localEndpoint: "http://127.0.0.1:8767",
    dimensions,
    vectorCandidateLimit: 1,
  });
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(cfg, store);
  const ns = localBgeM3Namespace("bge-m3", dimensions);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "first" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "second" },
  ]);
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1,
      endMessageId: 1,
      messageIds: [1],
      messageCount: 1,
      text: "first",
      namespace: ns,
      model: "bge-m3",
      dimensions,
      embedding: vectorToBlob(denseVec),
      contentHash: "first-hash",
      sparseTerms: [{ tokenId: 1, weight: 0.5 }],
    },
    {
      chatId: CHAT.chatId,
      startMessageId: 2,
      endMessageId: 2,
      messageIds: [2],
      messageCount: 1,
      text: "second",
      namespace: ns,
      model: "bge-m3",
      dimensions,
      embedding: vectorToBlob(denseVec),
      contentHash: "second-hash",
      sparseTerms: [{ tokenId: 1, weight: 0.3 }],
    },
  ]);

  const result = await vectorRag.search({ chatId: CHAT.chatId, query: "first", limit: 5, includeMessages: true });

  assert.equal(result.available, false, "dense channel degraded by candidate cap");
  assert.match(result.error ?? "", /Vector search candidate limit 1 exceeded/);
  assert.deepEqual(result.hits, []);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.sparseAvailable, true, "sparse channel remains available");
  assert.ok(result.sparseHits.length > 0, "sparse hits should be nonempty");
  assert.equal(result.sparseHits[0]?.chunk.dimensions, dimensions);
  assert.equal(result.backend, "local_bge_m3");
});
