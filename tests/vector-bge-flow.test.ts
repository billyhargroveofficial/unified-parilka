import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CanonicalBotReadCache } from "../src/bot/read-cache.js";
import { LOCAL_BGE_M3_DIMENSIONS } from "../src/config/types.js";
import { localBgeM3Namespace, vectorToBlob } from "../src/embeddings.js";
import type { StoredMessage } from "../src/store.js";
import { MessageStore } from "../src/store.js";
import type { ChatInfo } from "../src/telegram-client.js";
import { VectorRag } from "../src/vector-rag.js";
import { baseAppConfig } from "./support/app-config.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "supergroup",
};

function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(token, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/u)
    .filter(Boolean);
}

function denseOf(text: string): number[] {
  const vector = new Array<number>(LOCAL_BGE_M3_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    vector[hashToken(token) % LOCAL_BGE_M3_DIMENSIONS] = 1;
  }
  const norm = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  return norm === 0
    ? vector
    : vector.map((value) => value / norm);
}

function sparseOf(text: string): Array<{ token_id: number; weight: number }> {
  const weights = new Map<number, number>();
  for (const [index, token] of tokenize(text).entries()) {
    const tokenId = hashToken(token) % 200_000;
    const weight = 1 + 1 / (index + 2);
    weights.set(tokenId, Math.max(weights.get(tokenId) ?? 0, weight));
  }
  return [...weights.entries()].map(([token_id, weight]) => ({
    token_id,
    weight: Number(weight.toFixed(6)),
  }));
}

/**
 * Deterministic fake of the operator BGE-M3 service: same wire contract,
 * hashed-token model. Rerank favors candidates containing "маркер" so the
 * test can observe a reorder; `failRerank` simulates a broken rerank pass.
 */
function startFakeBgeService(): Promise<{
  origin: string;
  failRerank: { value: boolean };
  close: () => Promise<void>;
}> {
  const failRerank = { value: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      try {
        if (req.url === "/health") {
          reply(200, {
            status: "ok",
            model: "BAAI/bge-m3",
            contract: "bge-m3-v1",
          });
          return;
        }
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<string, unknown>;
        if (req.url === "/encode") {
          const texts = body.texts as string[];
          reply(200, {
            model: "BAAI/bge-m3",
            contract: "bge-m3-v1",
            results: texts.map((text) => ({
              dense: denseOf(text),
              sparse: sparseOf(text),
            })),
          });
          return;
        }
        if (req.url === "/rerank") {
          if (failRerank.value) {
            reply(500, { error: "rerank broken" });
            return;
          }
          const candidates = body.candidates as string[];
          const count = candidates.length;
          reply(200, {
            model: "BAAI/bge-m3",
            contract: "bge-m3-v1",
            scores: candidates.map((candidate, index) =>
              Number(
                (
                  (tokenize(candidate).includes("маркер") ? 10 : 0) +
                  (count - index) / 1000
                ).toFixed(6),
              ),
            ),
          });
          return;
        }
        reply(404, { error: "not_found" });
      } catch {
        reply(400, { error: "bad_request" });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("fake BGE-M3 service failed to bind");
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        failRerank,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function message(messageId: number, text: string): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    date: `2026-08-0${Math.min(6, messageId)}T12:00:00.000Z`,
    senderId: `user-${messageId}`,
    senderName: `user_${messageId}`,
    text,
  };
}

function localRagConfig(origin: string) {
  const config = baseAppConfig();
  config.embeddings = {
    ...config.embeddings,
    enabled: true,
    backend: "local_bge_m3",
    apiKey: "",
    localEndpoint: origin,
    localRequestTimeoutMs: 5_000,
    rerankTimeoutMs: 2_000,
    rerankMaxCandidates: 4,
    maxRetries: 1,
    retryInitialMs: 0,
    retryMaxMs: 5,
    chunkMessages: 2,
    chunkMaxChars: 1_600,
    searchLimit: 6,
  };
  return config;
}

function fixtureStore(t: TestContext): MessageStore {
  const dir = mkdtempSync(join(tmpdir(), "parilka-bge-flow-"));
  const store = new MessageStore(join(dir, "messages.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test("local BGE-M3 indexes dense+sparse in one pass and searches three channels", async (t) => {
  const service = await startFakeBgeService();
  t.after(() => service.close());
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    message(1, "обсуждали релиз парилки в пятницу"),
    message(2, "релиз перенесли на понедельник"),
    message(3, "совсем другой разговор о погоде"),
    message(4, "маркерное сообщение для rerank"),
  ]);

  const config = localRagConfig(service.origin);
  const rag = new VectorRag(config, store);
  assert.equal(rag.backendKind, "local_bge_m3");
  assert.ok(rag.supportsSparse);
  assert.ok(rag.supportsRerank);

  const estimate = rag.estimateIndexCachedMessages({
    chatId: CHAT.chatId,
  });
  assert.equal(estimate.provider, "Local BGE-M3 (loopback)");
  assert.equal(estimate.baseUrl, "loopback");
  assert.match(estimate.privacy, /does not leave this machine/);
  assert.ok(estimate.requiresConfirmation);

  const indexed = await rag.indexCachedMessages({
    chatId: CHAT.chatId,
    confirmFirstRun: true,
  });
  assert.ok(indexed.chunksCreated >= 2);
  // One encode pass must have stored learned sparse postings too.
  const postings = store.getSparseTermPostings({
    chatId: CHAT.chatId,
    namespace: indexed.namespace,
    model: "bge-m3",
    dimensions: LOCAL_BGE_M3_DIMENSIONS,
    terms: sparseOf("релиз").map(({ token_id, weight }) => ({
      tokenId: token_id,
      weight,
    })),
    limit: 10,
  });
  assert.ok(postings.length >= 1, "sparse postings must be committed");

  const found = await rag.search({
    chatId: CHAT.chatId,
    query: "когда релиз",
    limit: 4,
  });
  assert.equal(found.available, true);
  assert.equal(found.backend, "local_bge_m3");
  assert.ok(found.hits.length >= 1, "dense channel returns hits");
  assert.equal(found.sparseAvailable, true);
  assert.ok(found.sparseHits.length >= 1, "sparse channel returns hits");
});

test("rag_bm25_search cache fuses three channels and reranks top-K", async (t) => {
  const service = await startFakeBgeService();
  t.after(() => service.close());
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    message(1, "сообщение маркер для перестановки"),
    message(2, "релиз обсудили и запланировали"),
    message(3, "релиз подтвердили вчера"),
  ]);
  const config = localRagConfig(service.origin);
  const rag = new VectorRag(config, store);
  await rag.indexCachedMessages({
    chatId: CHAT.chatId,
    confirmFirstRun: true,
  });

  const cache = new CanonicalBotReadCache({
    store,
    vector: rag,
    rerankMaxCandidates: 3,
  });
  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "релиз",
    limit: 3,
    signal: new AbortController().signal,
  });

  assert.equal(result.mode, "hybrid");
  assert.ok(result.channels, "channel status must be explicit");
  assert.equal(result.channels?.bm25, "ok");
  assert.equal(result.channels?.dense, "ok");
  assert.equal(result.channels?.sparse, "ok");
  assert.equal(result.channels?.rerank, "ok");
  assert.deepEqual(result.degradedChannels, []);
  assert.equal(
    result.messages[0]?.messageId,
    1,
    "rerank must move the marker message to the front",
  );
});

test("causal beforeId excludes crossing chunks before dense/sparse scoring, fusion, and rerank", async (t) => {
  const service = await startFakeBgeService();
  t.after(() => service.close());
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    message(1, "safe alpha needle"),
    message(2, "safe beta needle"),
    message(3, "crossing pretrigger probe"),
    message(4, "crossing pretrigger continuation"),
    message(5, "trigger only needle"),
  ]);
  const config = localRagConfig(service.origin);
  const namespace = localBgeM3Namespace(
    "bge-m3",
    LOCAL_BGE_M3_DIMENSIONS,
  );
  // The third chunk starts before the causal boundary but its vector and
  // sparse postings include the trigger. It must never become a candidate.
  store.upsertEmbeddingChunks([
    chunk(1, 1, "safe alpha needle"),
    chunk(2, 2, "safe beta needle"),
    chunk(3, 5, "crossing pretrigger probe\ntrigger only needle"),
  ]);
  const rag = new VectorRag(config, store);

  const direct = await rag.search({
    chatId: CHAT.chatId,
    query: "needle",
    beforeId: 5,
    limit: 8,
    includeMessages: true,
  });
  assert.equal(direct.candidateCount, 2, "crossing dense BLOB must not be scored");
  assert.equal(direct.sparseCandidateCount, 2, "crossing sparse postings must not be scored");
  assert.deepEqual(
    direct.hits.map((hit) => hit.chunk.id),
    [1, 2],
  );
  assert.deepEqual(
    direct.sparseHits.map((hit) => hit.chunk.id),
    [1, 2],
  );

  let rerankCandidates: string[] | undefined;
  const cache = new CanonicalBotReadCache({
    store,
    vector: {
      supportsSparse: rag.supportsSparse,
      search: rag.search.bind(rag),
      fuseChannels: rag.fuseChannels.bind(rag),
      async rerank({ candidates }) {
        rerankCandidates = [...candidates];
        return {
          available: true,
          scores: candidates.map((_, index) => candidates.length - index),
        };
      },
    },
    rerankMaxCandidates: 8,
  });
  const fused = await cache.search({
    chatId: CHAT.chatId,
    query: "needle",
    beforeId: 5,
    limit: 8,
    signal: new AbortController().signal,
  });
  assert.equal(fused.channels?.rerank, "ok");
  assert.deepEqual(
    fused.messages.map((item) => item.messageId),
    [1, 2],
  );
  assert.deepEqual(rerankCandidates, ["safe alpha needle", "safe beta needle"]);

  function chunk(
    startMessageId: number,
    endMessageId: number,
    text: string,
  ) {
    const messageIds = Array.from(
      { length: endMessageId - startMessageId + 1 },
      (_, index) => startMessageId + index,
    );
    return {
      chatId: CHAT.chatId,
      startMessageId,
      endMessageId,
      messageIds,
      messageCount: messageIds.length,
      text,
      namespace,
      model: "bge-m3",
      dimensions: LOCAL_BGE_M3_DIMENSIONS,
      embedding: vectorToBlob(denseOf(text)),
      contentHash: `causal-${startMessageId}-${endMessageId}`,
      sparseTerms: sparseOf(text).map(({ token_id, weight }) => ({
        tokenId: token_id,
        weight,
      })),
    };
  }
});

test("rerank failure keeps first-stage order and reports degradation", async (t) => {
  const service = await startFakeBgeService();
  t.after(() => service.close());
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    message(1, "маркер перестановки тут"),
    message(2, "релиз обсудили и запланировали"),
    message(3, "релиз подтвердили вчера"),
  ]);
  const config = localRagConfig(service.origin);
  const rag = new VectorRag(config, store);
  await rag.indexCachedMessages({
    chatId: CHAT.chatId,
    confirmFirstRun: true,
  });

  const baseline = await new CanonicalBotReadCache({
    store,
    vector: rag,
    rerankMaxCandidates: 0,
  }).search({
    chatId: CHAT.chatId,
    query: "релиз",
    limit: 3,
    signal: new AbortController().signal,
  });
  assert.equal(baseline.channels?.rerank, "skipped");

  service.failRerank.value = true;
  const degraded = await new CanonicalBotReadCache({
    store,
    vector: rag,
    rerankMaxCandidates: 3,
  }).search({
    chatId: CHAT.chatId,
    query: "релиз",
    limit: 3,
    signal: new AbortController().signal,
  });

  assert.equal(degraded.channels?.rerank, "unavailable");
  assert.ok(
    degraded.degradedChannels?.includes("rerank_unavailable"),
    "degraded rerank must be visible in degradedChannels",
  );
  assert.deepEqual(
    degraded.messages.map(({ messageId }) => messageId),
    baseline.messages.map(({ messageId }) => messageId),
    "first-stage order survives a broken rerank",
  );
});

test("local backend outage degrades rag search to BM25 only", async (t) => {
  const service = await startFakeBgeService();
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    message(1, "релиз запланирован на пятницу"),
    message(2, "простой разговор"),
  ]);
  const config = localRagConfig(service.origin);
  const rag = new VectorRag(config, store);
  await rag.indexCachedMessages({
    chatId: CHAT.chatId,
    confirmFirstRun: true,
  });
  await service.close();

  const cache = new CanonicalBotReadCache({
    store,
    vector: rag,
    rerankMaxCandidates: 3,
  });
  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "релиз",
    limit: 3,
    signal: new AbortController().signal,
  });

  assert.equal(result.mode, "keyword");
  assert.equal(result.channels?.bm25, "ok");
  assert.equal(result.channels?.dense, "failed");
  assert.equal(result.channels?.sparse, "failed");
  assert.ok(result.degradedChannels?.includes("semantic_failed"));
  assert.deepEqual(
    result.messages.map(({ messageId }) => messageId),
    [1],
  );

  // keyword_search / slice contract stays provider-free and operational.
  const found = cache.findMessages({
    chatId: CHAT.chatId,
    query: "релиз",
    match: "all",
    includeBot: true,
    order: "relevance",
    limit: 5,
  });
  assert.deepEqual(
    found.map(({ messageId }) => messageId),
    [1],
  );
});
