import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import { VectorRag } from "../src/vector-rag.js";
import { CHAT, config, namespace } from "./support/vector-rag.js";

test("hybrid ranking merges overlapping keyword and vector evidence", () => {
  const vectorRag = new VectorRag(config(), new MessageStore(":memory:"));
  const lexicalOnly = { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "lexical only" };
  const overlap = { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "shared evidence" };
  const vectorOnly = { chatId: CHAT.chatId, messageId: 3, senderName: "carol", text: "vector only" };

  const results = vectorRag.hybrid(
    [
      { message: lexicalOnly, rank: 0 },
      { message: overlap, rank: 0 },
    ],
    [
      {
        rank: 1,
        score: 0.99,
        chunk: {
          id: 20,
          startMessageId: 2,
          endMessageId: 2,
          messageCount: 1,
          messageIds: [2],
          text: "shared evidence chunk",
          namespace: namespace(),
          model: config().embeddings.model,
          dimensions: 2,
        },
        messages: [overlap],
      },
      {
        rank: 2,
        score: 0.98,
        chunk: {
          id: 30,
          startMessageId: 3,
          endMessageId: 3,
          messageCount: 1,
          messageIds: [3],
          text: "vector only chunk",
          namespace: namespace(),
          model: config().embeddings.model,
          dimensions: 2,
        },
        messages: [vectorOnly],
      },
    ],
    10,
  );

  assert.equal(results[0]?.source, "hybrid");
  assert.deepEqual(results[0]?.sources.sort(), ["keyword", "vector"]);
  assert.equal(results[0]?.messageId, 2);
  assert.equal(results.some((hit) => hit.source === "keyword" && hit.messageId === 1), true);
  assert.equal(results.some((hit) => hit.source === "vector" && hit.startMessageId === 3), true);
  assert.equal((results[0]?.score ?? 0) > (results[1]?.score ?? 0), true);
});
