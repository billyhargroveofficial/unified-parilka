import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runDreamReview,
  type DreamReviewGenerate,
} from "../src/dream/review.js";
import { buildReviewToolSet } from "../src/dream/review-tools.js";
import { StagedKnowledgeOverlay } from "../src/dream/staged-knowledge.js";
import { MAX_FAST_CHAT_MEMORY_ITEMS } from "../src/store.js";
import type { DigestModelRouter } from "../src/digests.js";
import type { ResolvedModelCandidate } from "../src/providers/model-router.js";
import {
  DREAM_CHAT_ID,
  DREAM_YESTERDAY,
  dreamFixtureStore,
} from "./support/dream.js";

function candidate(reference: string): ResolvedModelCandidate {
  return {
    reference,
    providerId: reference.split("/")[0] ?? "provider",
    modelId: reference.split("/")[1] ?? "model",
    model: {} as ResolvedModelCandidate["model"],
    capabilities: { vision: false },
  };
}

async function executeTool(
  tools: Record<string, unknown>,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools[name] as
    | { execute?: (args: unknown) => Promise<unknown> }
    | undefined;
  if (tool?.execute == null) {
    throw new Error(`Tool ${name} is missing execute.`);
  }
  return tool.execute(input);
}

test("review_save_chat_skill creates then patches similar skill on staged overlay only", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-skill-tool-");
  try {
    const dayStage = new StagedKnowledgeOverlay(store, {
      now: () => 1_700_000_000_000,
    });
    const tools = buildReviewToolSet({
      chatId: DREAM_CHAT_ID,
      sourceMessageId: 2,
      nowMs: 1_700_000_000_000,
      store: dayStage,
    }) as Record<string, unknown>;

    const createdRaw = await executeTool(tools, "review_save_chat_skill", {
      name: "release-playbook",
      description: "Safe release workflow for this bot",
      instructions: "triggers; procedure; pitfalls; verify",
    });
    const created = JSON.parse(String(createdRaw)) as {
      ok: boolean;
      patched: boolean;
    };
    assert.equal(created.ok, true);
    assert.equal(created.patched, false);

    const afterCreate = dayStage.listChatSkills(DREAM_CHAT_ID);
    assert.equal(afterCreate.length, 1);
    assert.equal(afterCreate[0]?.name, "release-playbook");
    assert.equal(
      afterCreate[0]?.instructions,
      "triggers; procedure; pitfalls; verify",
    );
    // SQLite must stay untouched until day commit.
    assert.equal(store.listChatSkills(DREAM_CHAT_ID).length, 0);

    const patchedRaw = await executeTool(tools, "review_save_chat_skill", {
      name: "release playbook update",
      description: "Safe release workflow for this bot team",
      instructions: "triggers; improved procedure; pitfalls; verify carefully",
    });
    const patched = JSON.parse(String(patchedRaw)) as {
      ok: boolean;
      patched: boolean;
    };
    assert.equal(patched.ok, true);
    assert.equal(patched.patched, true);

    const afterPatch = dayStage.listChatSkills(DREAM_CHAT_ID);
    assert.equal(afterPatch.length, 1);
    assert.equal(afterPatch[0]?.name, "release-playbook");
    assert.equal(
      afterPatch[0]?.instructions,
      "triggers; improved procedure; pitfalls; verify carefully",
    );
    assert.equal(
      afterPatch[0]?.description,
      "Safe release workflow for this bot team",
    );
    assert.equal(store.listChatSkills(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    assert.equal(store.getChatMemory(DREAM_CHAT_ID), undefined);
  } finally {
    cleanup();
  }
});

test("runDreamReview discards failed attempt tool writes and merges only success", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-iso-");
  try {
    const dayStage = new StagedKnowledgeOverlay(store, {
      now: () => 1_700_000_000_000,
    });
    let generateCalls = 0;

    const generate: DreamReviewGenerate = async (params) => {
      generateCalls += 1;
      const tools = params.tools as Record<string, unknown>;
      if (generateCalls === 1) {
        await executeTool(tools, "review_remember_fast", {
          title: "failed-attempt-note",
          note: "must be discarded",
        });
        return {
          text: "incomplete body",
          finishReason: "length",
          toolCalls: [{ toolName: "review_remember_fast" }],
        };
      }
      await executeTool(tools, "review_remember_fast", {
        title: "success-attempt-note",
        note: "must merge into day stage",
      });
      await executeTool(tools, "review_remember_lesson", {
        title: "success-lesson",
        problem: "p",
        solution: "s",
        whenToApply: "w",
      });
      return {
        text: "merged final memory",
        finishReason: "stop",
        toolCalls: [
          { toolName: "review_remember_fast" },
          { toolName: "review_remember_lesson" },
        ],
      };
    };

    const first = candidate("provider/first");
    const second = candidate("provider/second");
    const router: DigestModelRouter = {
      async executeWithFallback(_role, attempt) {
        const failures: Array<{
          candidate: string;
          providerId: string;
          modelId: string;
          attempt: number;
          decision: { fallback: boolean; reason: "invalid_output" };
        }> = [];
        try {
          const value = await attempt(first, 1);
          return { value, candidate: first, attempt: 1, failures };
        } catch {
          failures.push({
            candidate: first.reference,
            providerId: first.providerId,
            modelId: first.modelId,
            attempt: 1,
            decision: { fallback: true, reason: "invalid_output" },
          });
          const value = await attempt(second, 2);
          return { value, candidate: second, attempt: 2, failures };
        }
      },
    };

    const result = await runDreamReview({
      router,
      store: dayStage,
      chatId: DREAM_CHAT_ID,
      sourceMessageId: 2,
      sourceText: '{"text":"interaction"}',
      currentMemory: "",
      maxMemoryChars: 2_000,
      maxOutputTokens: 8_192,
      generate,
    });

    assert.equal(result.finishReason, "stop");
    assert.equal(result.final, "merged final memory");
    assert.equal(generateCalls, 2);

    const stagedFast = dayStage.listFastChatMemory(DREAM_CHAT_ID);
    assert.deepEqual(
      stagedFast.map((item) => item.title).sort(),
      ["success-attempt-note"],
    );
    assert.equal(
      stagedFast.some((item) => item.title === "failed-attempt-note"),
      false,
    );
    assert.equal(dayStage.listChatLessons(DREAM_CHAT_ID)[0]?.title, "success-lesson");
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listChatLessons(DREAM_CHAT_ID).length, 0);
  } finally {
    cleanup();
  }
});

test("runDreamReview internal timeout retry discards first attempt tool writes", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-iso-");
  try {
    const dayStage = new StagedKnowledgeOverlay(store);
    let generateCalls = 0;

    const generate: DreamReviewGenerate = async (params) => {
      generateCalls += 1;
      const tools = params.tools as Record<string, unknown>;
      if (generateCalls === 1) {
        await executeTool(tools, "review_remember_fast", {
          title: "timeout-note",
          note: "discarded on retry",
        });
        // Exceed candidateTimeoutMs so the controller aborts; the review loop
        // retries the same candidate with a fresh attempt overlay.
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (params.abortSignal?.aborted) {
          throw Object.assign(new Error("candidate aborted"), {
            name: "AbortError",
            code: "ABORT_ERR",
          });
        }
        return {
          text: "late",
          finishReason: "length",
          toolCalls: [{ toolName: "review_remember_fast" }],
        };
      }
      await executeTool(tools, "review_remember_fast", {
        title: "retry-success-note",
        note: "kept after retry",
      });
      return {
        text: "ok after retry",
        finishReason: "stop",
        toolCalls: [{ toolName: "review_remember_fast" }],
      };
    };

    const cand = candidate("provider/solo");
    const router: DigestModelRouter = {
      async executeWithFallback(_role, attempt) {
        return {
          value: await attempt(cand, 1),
          candidate: cand,
          attempt: 1,
          failures: [],
        };
      },
    };

    const result = await runDreamReview({
      router,
      store: dayStage,
      chatId: DREAM_CHAT_ID,
      sourceMessageId: 2,
      sourceText: "{}",
      maxCandidateAttempts: 2,
      candidateTimeoutMs: 500,
      totalTimeoutMs: 10_000,
      generate,
    });

    assert.equal(result.final, "ok after retry");
    assert.ok(generateCalls >= 2);
    assert.deepEqual(
      dayStage.listFastChatMemory(DREAM_CHAT_ID).map((item) => item.title),
      ["retry-success-note"],
    );
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
  } finally {
    cleanup();
  }
});

test("explicit stale updatedAtMs cannot regress or collide on shared clock", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-clock-");
  try {
    const fixedNow = 1_700_000_000_000;
    const stage = new StagedKnowledgeOverlay(store, { now: () => fixedNow });

    const first = stage.upsertFastChatMemory({
      chatId: DREAM_CHAT_ID,
      title: "first",
      note: "advanced the shared clock",
      sourceMessageId: 1,
    });
    assert.equal(first.updatedAtMs, fixedNow);

    // Explicit request older than the already-advanced clock.
    const stale = stage.upsertFastChatMemory({
      chatId: DREAM_CHAT_ID,
      title: "stale-explicit",
      note: "must not regress or collide",
      sourceMessageId: 2,
      updatedAtMs: fixedNow - 10_000,
    });
    assert.ok(stale.updatedAtMs > first.updatedAtMs);
    assert.notEqual(stale.updatedAtMs, first.updatedAtMs);

    const third = stage.upsertFastChatMemory({
      chatId: DREAM_CHAT_ID,
      title: "third",
      note: "continues strictly after stale-corrected write",
      sourceMessageId: 3,
    });
    assert.ok(third.updatedAtMs > stale.updatedAtMs);

    // observe() itself returns the effective last, not the raw older input.
    const { createLogicalClock } = await import(
      "../src/dream/staged-knowledge.js"
    );
    const clock = createLogicalClock(() => fixedNow);
    assert.equal(clock.next(), fixedNow);
    assert.equal(clock.observe(fixedNow - 1), fixedNow);
    assert.equal(clock.observe(fixedNow + 5), fixedNow + 5);
  } finally {
    cleanup();
  }
});

test("staged fast capacity keeps newest tool-call order under fixed wall clock", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-cap-");
  try {
    const fixedNow = 1_700_000_000_000;
    const dayStage = new StagedKnowledgeOverlay(store, {
      now: () => fixedNow,
    });

    // Titles where reverse-lexicographic order diverges from insertion order:
    // z-old is the oldest tool call; n-new is the newest. Without a shared
    // monotonic clock, fixed wall-time pruning would keep z-old and drop n-new.
    const titles = [
      "z-old",
      "y",
      "x",
      "w",
      "v",
      "u",
      "t",
      "s",
      "r",
      "q",
      "p",
      "o",
      "n-new",
    ];
    assert.equal(titles.length, MAX_FAST_CHAT_MEMORY_ITEMS + 1);

    for (let i = 0; i < titles.length; i += 1) {
      dayStage.upsertFastChatMemory({
        chatId: DREAM_CHAT_ID,
        title: titles[i]!,
        note: `body-${i + 1}`,
        sourceMessageId: i + 1,
      });
    }

    // Discarded fork still advances the shared logical clock.
    const discarded = dayStage.fork();
    discarded.upsertFastChatMemory({
      chatId: DREAM_CHAT_ID,
      title: "discarded-only",
      note: "never merged",
      sourceMessageId: 99,
    });

    const listed = dayStage.listFastChatMemory(DREAM_CHAT_ID);
    assert.equal(listed.length, MAX_FAST_CHAT_MEMORY_ITEMS);
    assert.equal(listed.some((item) => item.title === "z-old"), false);
    assert.equal(listed.some((item) => item.title === "n-new"), true);
    assert.equal(listed.some((item) => item.title === "discarded-only"), false);
    assert.deepEqual(
      listed.map((item) => item.title),
      titles.slice(1).reverse(),
    );

    const staged = dayStage.exportStagedWrites(DREAM_CHAT_ID);
    store.commitDreamDay({
      day: {
        chatId: DREAM_CHAT_ID,
        day: DREAM_YESTERDAY,
        status: "completed",
        interactionCount: 0,
        attempts: 1,
        completedAtMs: fixedNow,
        updatedAtMs: fixedNow,
      },
      fast: staged.fast,
      lessons: [],
      skills: [],
    });

    const committed = store.listFastChatMemory(DREAM_CHAT_ID);
    assert.equal(committed.length, MAX_FAST_CHAT_MEMORY_ITEMS);
    assert.deepEqual(
      committed.map((item) => item.title),
      listed.map((item) => item.title),
    );
  } finally {
    cleanup();
  }
});
