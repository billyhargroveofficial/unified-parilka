import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DREAM_CHAT_ID,
  DREAM_YESTERDAY,
  dreamFakeRouter,
  dreamFixtureStore,
  makeDreamConsolidator,
  seedDreamInteraction,
  writeDreamKnowledge,
} from "./support/dream.js";

const OTHER_CHAT = "-1009999999999";

test("commitDreamDay rolls back knowledge and memory when final day upsert fails", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-commit-");
  try {
    store.upsertChatMemory({
      chatId: DREAM_CHAT_ID,
      memoryText: "pre-existing memory",
      lastConsolidatedMessageId: 7,
    });
    store.upsertFastChatMemory({
      chatId: DREAM_CHAT_ID,
      title: "kept-note",
      note: "must survive rollback",
      sourceMessageId: 1,
    });
    store.upsertDreamDay({
      chatId: DREAM_CHAT_ID,
      day: DREAM_YESTERDAY,
      status: "running",
      interactionCount: 1,
      attempts: 2,
      firstMessageId: 1,
      lastMessageId: 2,
      sourceHash: "abc",
      updatedAtMs: 100,
    });

    // Valid fast + lesson + memory first; failure is injected only on the final
    // day upsert so memory is actually written before the transaction aborts.
    assert.throws(
      () =>
        store.commitDreamDay({
          day: {
            chatId: DREAM_CHAT_ID,
            // Invalid calendar day fails inside upsertDreamDayLocked after
            // fast/lesson/memory Locked writes have already run.
            day: "2026-13-40",
            status: "completed",
            interactionCount: 1,
            attempts: 2,
            firstMessageId: 1,
            lastMessageId: 2,
            sourceHash: "abc",
            completedAtMs: 200,
            updatedAtMs: 200,
          },
          memory: {
            chatId: DREAM_CHAT_ID,
            memoryText: "leaked replacement memory",
            lastConsolidatedMessageId: 99,
            updatedAtMs: 200,
          },
          fast: [
            {
              chatId: DREAM_CHAT_ID,
              title: "valid-first-write",
              note: "would leak without rollback",
              sourceMessageId: 2,
              updatedAtMs: 200,
            },
          ],
          lessons: [
            {
              chatId: DREAM_CHAT_ID,
              title: "valid-lesson",
              problem: "p",
              solution: "s",
              whenToApply: "w",
              sourceMessageId: 2,
              updatedAtMs: 200,
            },
          ],
          skills: [],
        }),
      /calendar day/i,
    );

    const afterMemory = store.getChatMemory(DREAM_CHAT_ID);
    const afterFast = store.listFastChatMemory(DREAM_CHAT_ID);
    const afterLessons = store.listChatLessons(DREAM_CHAT_ID);
    const afterDay = store.getDreamDay({
      chatId: DREAM_CHAT_ID,
      day: DREAM_YESTERDAY,
    });

    assert.equal(afterMemory?.memoryText, "pre-existing memory");
    assert.equal(afterMemory?.lastConsolidatedMessageId, 7);
    assert.equal(afterFast.length, 1);
    assert.equal(afterFast[0]?.title, "kept-note");
    assert.equal(
      afterFast.some((item) => item.title === "valid-first-write"),
      false,
    );
    assert.equal(afterLessons.length, 0);
    assert.equal(afterDay?.status, "running");
    assert.equal(afterDay?.attempts, 2);
    assert.equal(afterDay?.day, DREAM_YESTERDAY);
    assert.equal(afterDay?.completedAtMs, undefined);
  } finally {
    cleanup();
  }
});

test("commitDreamDay rejects cross-chat knowledge bundles before writing", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-commit-");
  try {
    store.upsertChat({
      chatId: OTHER_CHAT,
      requested: OTHER_CHAT,
      title: "Other",
      kind: "channel",
      isForum: false,
    });
    store.upsertChatMemory({
      chatId: DREAM_CHAT_ID,
      memoryText: "target chat memory",
    });

    assert.throws(
      () =>
        store.commitDreamDay({
          day: {
            chatId: DREAM_CHAT_ID,
            day: DREAM_YESTERDAY,
            status: "completed",
            interactionCount: 0,
            attempts: 1,
          },
          fast: [
            {
              chatId: OTHER_CHAT,
              title: "foreign",
              note: "wrong chat",
              sourceMessageId: 1,
            },
          ],
          lessons: [],
          skills: [],
        }),
      /chatId mismatch/,
    );

    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listFastChatMemory(OTHER_CHAT).length, 0);
    assert.equal(
      store.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }),
      undefined,
    );
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.memoryText, "target chat memory");
  } finally {
    cleanup();
  }
});

test("dream commitDreamDay failure marks day failed and does not leak stage", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-commit-");
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

    const originalCommit = store.commitDreamDay.bind(store);
    store.commitDreamDay = ((input) => {
      // Only inject failure for the specific day being tested.
      if (input.day.day === DREAM_YESTERDAY) {
        throw Object.assign(new Error("injected commit failure"), {
          code: "commit_injected_failure",
        });
      }
      return originalCommit(input);
    }) as typeof store.commitDreamDay;

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
            final: "leaked replacement memory",
          };
        },
      },
    ).run(store, { chatId: DREAM_CHAT_ID });

    // Restore for cleanup assertions on the same store instance.
    store.commitDreamDay = originalCommit;

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error, "commit_injected_failure");
      const failedDay = result.days.find((day) => day.day === DREAM_YESTERDAY);
      assert.ok(failedDay);
      assert.equal(failedDay.status, "failed");
      assert.equal(failedDay.error, "commit_injected_failure");
      // Planner is oldest-first; later calendar days must not run after failure.
      assert.equal(
        result.days.some((day) => day.day > DREAM_YESTERDAY),
        false,
      );
    }

    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.memoryText, "original memory");
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.lastConsolidatedMessageId, 1);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID)[0]?.title, "pre-existing");
    assert.equal(store.listChatLessons(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listChatSkills(DREAM_CHAT_ID).length, 0);

    const day = store.getDreamDay({
      chatId: DREAM_CHAT_ID,
      day: DREAM_YESTERDAY,
    });
    assert.equal(day?.status, "failed");
    assert.equal(day?.error, "commit_injected_failure");
    assert.equal(day?.completedAtMs, undefined);
  } finally {
    cleanup();
  }
});
