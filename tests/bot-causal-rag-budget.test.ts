import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CausalRagContextBuilder,
  MAX_CAUSAL_RAG_PACKET_CHARS,
  type CausalRagCache,
} from "../src/bot/causal-rag/index.js";
import type { StoredMessage } from "../src/store.js";

const CHAT = "-100123";

test("history timeout degrades to recent context without an error payload", async () => {
  const builder = new CausalRagContextBuilder({
    cache: cache({
      async search() {
        return new Promise(() => {});
      },
    }),
    historyTimeoutMs: 100,
  });
  const startedAt = Date.now();
  const result = await builder.build({
    chatId: CHAT,
    triggerMessageId: 10,
    triggerText: "напомни обсуждение",
    context: [message(9, "recent survives")],
  });
  assert.equal(result.historyAttempted, true);
  assert.equal(result.historyDegraded, true);
  assert.match(result.packet, /recent survives/);
  assert.ok(Date.now() - startedAt < 500, "automatic history retrieval must stay bounded");
  assert.doesNotMatch(result.packet, /timeout|error|cache/iu);
});

test("history failure never projects a provider error into the packet", async () => {
  const builder = new CausalRagContextBuilder({
    cache: cache({
      async search() {
        throw new Error("provider token SECRET_VALUE must not reach Codex");
      },
    }),
  });
  const result = await builder.build({
    chatId: CHAT,
    triggerMessageId: 10,
    triggerText: "напомни обсуждение",
    context: [message(9, "recent survives")],
  });
  assert.equal(result.historyDegraded, true);
  assert.doesNotMatch(result.packet, /SECRET|token|provider/iu);
});

test("packet remains below hard budget with opaque labels and no raw message ids", async () => {
  const builder = new CausalRagContextBuilder({
    cache: cache({
      async search() {
        return {
          mode: "hybrid",
          messages: Array.from({ length: 8 }, (_, index) => message(700 + index, "h".repeat(4_000))),
        };
      },
    }),
  });
  const result = await builder.build({
    chatId: CHAT,
    triggerMessageId: 1_000,
    triggerText: "напомни историю",
    context: Array.from({ length: 12 }, (_, index) => message(900 + index, "c".repeat(3_000))),
  });
  assert.ok(result.packet.length <= MAX_CAUSAL_RAG_PACKET_CHARS);
  assert.match(result.packet, /〔C1〕/);
  assert.match(result.packet, /〔H1〕/);
  assert.doesNotMatch(result.packet, /\b(?:700|701|900|901|1000)\b/);
});

function cache(overrides: Partial<CausalRagCache> = {}): CausalRagCache {
  return {
    async search() {
      return { messages: [], mode: "keyword" };
    },
    getDigests() {
      return { digests: [] };
    },
    ...overrides,
  };
}

function message(messageId: number, text: string): StoredMessage {
  return { chatId: CHAT, messageId, senderId: "sender", senderName: "Алиса", date: "2026-08-26T08:00:00.000Z", text };
}
