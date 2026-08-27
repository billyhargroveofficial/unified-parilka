import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBotRagRuntimeConfig } from "../src/bot/responses/rag-runtime-config.js";

test("bot RAG uses only fixed local BGE-M3 with fast bounded defaults", () => {
  const config = parseBotRagRuntimeConfig({});
  assert.equal(config.vector.embeddings.backend, "local_bge_m3");
  assert.equal(config.vector.embeddings.localEndpoint, "http://127.0.0.1:8767");
  assert.equal(config.vector.embeddings.apiKey, "");
  assert.equal(config.vector.embeddings.maxRetries, 0);
  assert.equal(config.vector.embeddings.vectorCandidateLimit, 50_000);
  assert.equal(config.rerankMaxCandidates, 8);
  assert.equal(config.automaticTimeoutMs, 2_500);
});

test("bot RAG rejects every non-loopback or path-bearing endpoint", () => {
  for (const endpoint of [
    "https://127.0.0.1:8767",
    "http://localhost:8767",
    "http://10.0.0.1:8767",
    "http://127.0.0.1:8767/path",
    "http://user:pass@127.0.0.1:8767",
  ]) {
    assert.throws(
      () => parseBotRagRuntimeConfig({ PARILKA_BOT_RAG_LOCAL_ENDPOINT: endpoint }),
      /loopback HTTP origin/u,
    );
  }
});

test("bot RAG bounds latency and rerank configuration", () => {
  assert.throws(
    () => parseBotRagRuntimeConfig({ PARILKA_BOT_RAG_AUTOMATIC_TIMEOUT_MS: "10001" }),
    /AUTOMATIC_TIMEOUT_MS/u,
  );
  assert.throws(
    () => parseBotRagRuntimeConfig({ PARILKA_BOT_RAG_RERANK_MAX_CANDIDATES: "17" }),
    /RERANK_MAX_CANDIDATES/u,
  );
});
