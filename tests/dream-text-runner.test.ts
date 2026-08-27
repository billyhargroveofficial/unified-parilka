import assert from "node:assert/strict";
import { test } from "node:test";
import type { DreamTextRunner } from "../src/dream/text-runner.js";
import { runDreamReview } from "../src/dream/review.js";
import { shortenDreamMemoryBlock } from "../src/dream/shorten-memory.js";
import { StagedKnowledgeOverlay } from "../src/dream/staged-knowledge.js";
import { DREAM_CHAT_ID, dreamFixtureStore } from "./support/dream.js";

test("Dream text runner dispatch is schema-validated and only successful attempt merges", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-text-");
  try {
    const stage = new StagedKnowledgeOverlay(store, { now: () => 1_700_000_000_000 });
    let calls = 0;
    const runner: DreamTextRunner = {
      async runText(options) {
        calls += 1;
        assert.equal(options.dynamicTools.length, 8);
        if (calls === 1) {
          await options.dispatch("review_remember_fast", {
            title: "discarded model write",
            note: "this must not escape the failed attempt",
          });
          return {
            text: "partial",
            finishReason: "length",
            toolCalls: 1,
            model: "gpt-5.6-luna",
            providerId: "openai-responses",
          };
        }
        await assert.rejects(
          options.dispatch("review_remember_fast", { title: "missing note" }),
          { name: "DreamReviewToolInputError" },
        );
        await options.dispatch("review_remember_fast", {
          title: "kept model write",
          note: "only this write is staged",
        });
        return {
          text: "valid final memory",
          finishReason: "stop",
          toolCalls: 1,
          model: "gpt-5.6-luna",
          providerId: "openai-responses",
        };
      },
    };

    const result = await runDreamReview({
      textRunner: runner,
      store: stage,
      chatId: DREAM_CHAT_ID,
      sourceMessageId: 2,
      sourceText: '{"text":"interaction"}',
      maxCandidateAttempts: 2,
    });

    assert.equal(result.final, "valid final memory");
    assert.equal(result.model, "gpt-5.6-luna");
    assert.equal(result.providerId, "openai-responses");
    assert.equal(calls, 2);
    assert.deepEqual(
      stage.listFastChatMemory(DREAM_CHAT_ID).map((item) => item.title),
      ["kept model write"],
    );
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
  } finally {
    cleanup();
  }
});

test("Dream text shortening re-asks the original block after oversized output", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const runner: DreamTextRunner = {
    async runText(options) {
      prompts.push(options.prompt);
      calls += 1;
      return {
        text: calls === 1 ? "x".repeat(2_100) : "compact remembered facts",
        finishReason: "stop",
        toolCalls: 0,
        model: "gpt-5.6-luna",
        providerId: "openai-responses",
      };
    },
  };
  const result = await shortenDreamMemoryBlock({
    textRunner: runner,
    block: "original stable memory",
    maxChars: 2_000,
    maxOutputTokens: 8_192,
    candidateTimeoutMs: 60_000,
  });

  assert.equal(result.text, "compact remembered facts");
  assert.equal(calls, 2);
  assert.ok(prompts.every((prompt) => prompt.includes("original stable memory")));
  assert.ok(prompts[1]?.includes("2100"));
});
