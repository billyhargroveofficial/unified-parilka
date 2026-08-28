import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRoutingError } from "../src/providers/model-router.js";
import type { DigestModelRouter } from "../src/digests.js";
import {
  DREAM_CHAT_ID,
  DREAM_YESTERDAY,
  dreamFakeRouter,
  dreamFixtureStore,
  dreamNow,
  makeDreamConsolidator,
  seedDreamInteraction,
  seedDreamTwoBatches,
  writeDreamKnowledge,
} from "./support/dream.js";

test("dream failure after tool writes discards knowledge and preserves originals", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-stage-");
  try {
    seedDreamInteraction(store, {
      day: DREAM_YESTERDAY,
      triggerId: 1,
      answerId: 2,
    });
    store.upsertChatMemory({
      chatId: DREAM_CHAT_ID,
      memoryText: "original memory",
      lastConsolidatedMessageId: 1,
    });
    store.upsertFastChatMemory({
      chatId: DREAM_CHAT_ID,
      title: "pre-existing",
      note: "keep me",
      sourceMessageId: 1,
    });

    const result = await makeDreamConsolidator(
      dreamFakeRouter({ text: "", toolCalls: 0, finishReason: "stop" }),
      {
        runReview: async (options) => {
          writeDreamKnowledge(options.store, 2);
          throw Object.assign(new Error("model failed after tools"), {
            code: "boom_after_tools",
          });
        },
      },
    ).run(store, { chatId: DREAM_CHAT_ID });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error, "boom_after_tools");
    }
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.memoryText, "original memory");
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.lastConsolidatedMessageId, 1);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID)[0]?.title, "pre-existing");
    assert.equal(store.listChatLessons(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listChatSkills(DREAM_CHAT_ID).length, 0);
    const failed = store.listDreamDays({ chatId: DREAM_CHAT_ID, status: "failed" });
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.error, "boom_after_tools");
  } finally {
    cleanup();
  }
});

test("dream oversized final with failed shortening discards stage", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-stage-");
  try {
    seedDreamInteraction(store, {
      day: DREAM_YESTERDAY,
      triggerId: 1,
      answerId: 2,
    });
    store.upsertChatMemory({
      chatId: DREAM_CHAT_ID,
      memoryText: "original memory",
      lastConsolidatedMessageId: 1,
    });

    const router: DigestModelRouter = {
      async executeWithFallback() {
        throw new ModelRoutingError(
          "candidates_exhausted",
          "summary",
          [
            {
              candidate: "provider/model",
              providerId: "provider",
              modelId: "model",
              attempt: 1,
              decision: { fallback: true, reason: "invalid_output" },
            },
          ],
          Object.assign(new Error("shortening still too large"), {
            name: "BotAgentProtocolError",
            code: "shortening_output_too_large",
            modelFallback: true,
          }),
        );
      },
    };

    const result = await makeDreamConsolidator(router, {
      maxMemoryChars: 2_000,
      runReview: async (options) => {
        options.store.upsertFastChatMemory({
          chatId: DREAM_CHAT_ID,
          title: "from review",
          note: "should not land",
          sourceMessageId: 2,
        });
        return {
          applied: true,
          model: "provider/model",
          providerId: "provider",
          fallbackCount: 0,
          toolCalls: 1,
          finishReason: "stop",
          final: "x".repeat(5_000),
        };
      },
    }).run(store, { chatId: DREAM_CHAT_ID });

    const expected =
      "candidates_exhausted:invalid_output:shortening_output_too_large";
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error, expected);
    }
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.memoryText, "original memory");
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    assert.equal(
      store.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY })?.error,
      expected,
    );
  } finally {
    cleanup();
  }
});

test("dream batch two failure discards batch one knowledge writes", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-stage-");
  try {
    seedDreamTwoBatches(store);
    store.upsertChatMemory({
      chatId: DREAM_CHAT_ID,
      memoryText: "original memory",
      lastConsolidatedMessageId: 1,
    });

    let batch = 0;
    const result = await makeDreamConsolidator(
      dreamFakeRouter({ text: "", toolCalls: 0, finishReason: "stop" }),
      {
        maxInputChars: 1_000,
        runReview: async (options) => {
          batch += 1;
          options.store.upsertFastChatMemory({
            chatId: DREAM_CHAT_ID,
            title: `batch-${batch}-note`,
            note: `note ${batch}`,
            sourceMessageId: batch === 1 ? 2 : 52,
          });
          options.store.upsertChatLesson({
            chatId: DREAM_CHAT_ID,
            title: `batch-${batch}-lesson`,
            problem: "p",
            solution: "s",
            whenToApply: "w",
            sourceMessageId: batch === 1 ? 2 : 52,
          });
          if (batch === 2) {
            throw Object.assign(new Error("batch two failed"), {
              code: "batch_two_failed",
            });
          }
          return {
            applied: true,
            model: "provider/model",
            providerId: "provider",
            fallbackCount: 0,
            toolCalls: 2,
            finishReason: "stop",
            final: "staged from batch one",
          };
        },
      },
    ).run(store, { chatId: DREAM_CHAT_ID });

    assert.equal(result.status, "failed");
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.memoryText, "original memory");
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.lastConsolidatedMessageId, 1);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listChatLessons(DREAM_CHAT_ID).length, 0);
  } finally {
    cleanup();
  }
});

test("dream staged knowledge from batch one is visible to batch two reads", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-stage-");
  try {
    seedDreamTwoBatches(store);
    const seenFastTitles: string[][] = [];
    let batch = 0;

    const result = await makeDreamConsolidator(
      dreamFakeRouter({ text: "", toolCalls: 0, finishReason: "stop" }),
      {
        maxInputChars: 1_000,
        runReview: async (options) => {
          batch += 1;
          seenFastTitles.push(
            options.store
              .listFastChatMemory(DREAM_CHAT_ID)
              .map((item) => item.title),
          );
          options.store.upsertFastChatMemory({
            chatId: DREAM_CHAT_ID,
            title: `batch-${batch}`,
            note: `note ${batch}`,
            sourceMessageId: batch === 1 ? 2 : 52,
          });
          return {
            applied: true,
            model: "provider/model",
            providerId: "provider",
            fallbackCount: 0,
            toolCalls: 1,
            finishReason: "stop",
            final: `memory after batch ${batch}`,
          };
        },
      },
    ).run(store, { chatId: DREAM_CHAT_ID });

    assert.equal(result.status, "success");
    assert.deepEqual(seenFastTitles, [[], ["batch-1"]]);
    assert.equal(
      store.getChatMemory(DREAM_CHAT_ID)?.memoryText,
      "memory after batch 2",
    );
    assert.deepEqual(
      store
        .listFastChatMemory(DREAM_CHAT_ID)
        .map((item) => item.title)
        .sort(),
      ["batch-1", "batch-2"],
    );
  } finally {
    cleanup();
  }
});

test("dream successful atomic commit writes knowledge, memory, watermark and day", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-stage-");
  try {
    seedDreamInteraction(store, {
      day: DREAM_YESTERDAY,
      triggerId: 1,
      answerId: 2,
    });

    const result = await makeDreamConsolidator(
      dreamFakeRouter({ text: "", toolCalls: 0, finishReason: "stop" }),
      {
        runReview: async (options) => {
          writeDreamKnowledge(options.store, 2);
          return {
            applied: true,
            model: "provider/model",
            providerId: "provider",
            fallbackCount: 0,
            toolCalls: 3,
            finishReason: "stop",
            final: "user prefers short answers",
          };
        },
      },
    ).run(store, { chatId: DREAM_CHAT_ID });

    assert.equal(result.status, "success");
    assert.equal(
      store.getChatMemory(DREAM_CHAT_ID)?.memoryText,
      "user prefers short answers",
    );
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.lastConsolidatedMessageId, 2);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID)[0]?.title, "fast-note");
    assert.equal(store.listChatLessons(DREAM_CHAT_ID)[0]?.title, "lesson");
    assert.equal(store.listChatSkills(DREAM_CHAT_ID)[0]?.name, "skill");
    assert.equal(
      store.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY })?.status,
      "completed",
    );
  } finally {
    cleanup();
  }
});

test("dream retry after failed stage does not duplicate knowledge on success", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-stage-");
  try {
    seedDreamInteraction(store, {
      day: DREAM_YESTERDAY,
      triggerId: 1,
      answerId: 2,
    });
    let attempt = 0;
    const c = makeDreamConsolidator(
      dreamFakeRouter({ text: "", toolCalls: 0, finishReason: "stop" }),
      {
        runReview: async (options) => {
          attempt += 1;
          options.store.upsertFastChatMemory({
            chatId: DREAM_CHAT_ID,
            title: "stable fact",
            note: "one note only",
            sourceMessageId: 2,
          });
          options.store.upsertChatLesson({
            chatId: DREAM_CHAT_ID,
            title: "stable lesson",
            problem: "p",
            solution: "s",
            whenToApply: "w",
            sourceMessageId: 2,
          });
          if (attempt === 1) {
            throw Object.assign(new Error("first attempt fails"), {
              code: "first_fail",
            });
          }
          return {
            applied: true,
            model: "provider/model",
            providerId: "provider",
            fallbackCount: 0,
            toolCalls: 2,
            finishReason: "stop",
            final: "consolidated",
          };
        },
      },
    );

    assert.equal((await c.run(store, { chatId: DREAM_CHAT_ID })).status, "failed");
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listChatLessons(DREAM_CHAT_ID).length, 0);

    assert.equal((await c.run(store, { chatId: DREAM_CHAT_ID })).status, "success");
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    assert.equal(store.listChatLessons(DREAM_CHAT_ID).length, 1);
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.memoryText, "consolidated");

    assert.equal((await c.run(store, { chatId: DREAM_CHAT_ID })).status, "no_jobs");
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    assert.equal(store.listChatLessons(DREAM_CHAT_ID).length, 1);
  } finally {
    cleanup();
  }
});

test("dream persists concrete ModelRoutingError diagnostics without provider text", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-stage-");
  try {
    seedDreamInteraction(store, {
      day: DREAM_YESTERDAY,
      triggerId: 1,
      answerId: 2,
    });
    const expected =
      "candidates_exhausted:invalid_output:incomplete_review:length";
    const router: DigestModelRouter = {
      async executeWithFallback() {
        throw new ModelRoutingError(
          "candidates_exhausted",
          "summary",
          [
            {
              candidate: "provider/secret-model",
              providerId: "provider",
              modelId: "secret-model",
              attempt: 1,
              decision: { fallback: true, reason: "invalid_output" },
            },
          ],
          Object.assign(
            new Error("Provider said: sk-abcdefghijklmnopqrstuvwxyz"),
            {
              name: "BotAgentProtocolError",
              code: "incomplete_review:length",
              modelFallback: true,
            },
          ),
        );
      },
    };

    const result = await makeDreamConsolidator(router).run(store, {
      chatId: DREAM_CHAT_ID,
    });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error, expected);
      assert.ok(!result.error.includes("sk-"));
      assert.ok(!result.error.includes("Provider said"));
    }
    const day = store.getDreamDay({
      chatId: DREAM_CHAT_ID,
      day: DREAM_YESTERDAY,
    });
    assert.equal(day?.error, expected);
    assert.ok(day?.error && !day.error.includes("sk-"));
  } finally {
    cleanup();
  }
});

test("dream default maxOutputTokens is 8192 while maxMemoryChars stays 2000", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-stage-");
  try {
    seedDreamInteraction(store, {
      day: DREAM_YESTERDAY,
      triggerId: 1,
      answerId: 2,
    });
    let seenMaxOutput: number | undefined;
    let seenMaxMemory: number | undefined;

    const { DreamConsolidator } = await import("../src/dream/consolidator.js");
    await new DreamConsolidator({
      router: dreamFakeRouter({ text: "ok", toolCalls: 0, finishReason: "stop" }),
      botSenderId: "100000000",
      now: dreamNow,
      runReview: async (options) => {
        seenMaxOutput = options.maxOutputTokens;
        seenMaxMemory = options.maxMemoryChars;
        return {
          applied: true,
          model: "provider/model",
          providerId: "provider",
          fallbackCount: 0,
          toolCalls: 0,
          finishReason: "stop",
          final: "ok",
        };
      },
    }).run(store, { chatId: DREAM_CHAT_ID });

    assert.equal(seenMaxOutput, 8_192);
    assert.equal(seenMaxMemory, 2_000);
    assert.throws(
      () =>
        new DreamConsolidator({
          router: dreamFakeRouter({
            text: "ok",
            toolCalls: 0,
            finishReason: "stop",
          }),
          botSenderId: "100000000",
          maxMemoryChars: 4_001,
        }),
    );
  } finally {
    cleanup();
  }
});
