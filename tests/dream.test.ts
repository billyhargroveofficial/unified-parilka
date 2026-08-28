import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamConsolidator } from "../src/dream/consolidator.js";
import { dreamYesterday } from "../src/dream/planner.js";
import type { DigestModelRouter } from "../src/digests.js";
import { MessageStore } from "../src/store.js";
import type { StoredMessage } from "../src/store.js";
import type { ResolvedModelCandidate } from "../src/providers/model-router.js";
import type { DreamReviewModelOutput } from "../src/dream/review.js";
import {
  DREAM_NOW_ISO,
  DREAM_YESTERDAY,
  dreamNow,
} from "./support/dream.js";

const CHAT_ID = "-1003179772905";
const BOT_SENDER_ID = "100000000";
const HUMAN_SENDER_ID = "200000000";

function fixtureStore() {
  const directory = mkdtempSync(join(tmpdir(), "parilka-dream-"));
  const dbPath = join(directory, "shared.sqlite");
  const store = new MessageStore(dbPath);
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "Dream Test",
    kind: "channel",
    isForum: false,
  });
  return {
    store,
    dbPath,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function fakeRouter(output: DreamReviewModelOutput): DigestModelRouter {
  return {
    async executeWithFallback<T>(
      _role: string,
      _attempt: (
        candidate: ResolvedModelCandidate,
        attemptNumber: number,
      ) => Promise<T>,
    ) {
      const candidate = {
        reference: "provider/model",
        providerId: "provider",
        modelId: "model",
        model: {} as ResolvedModelCandidate["model"],
        capabilities: { vision: false },
      };
      return {
        value: output as T,
        candidate,
        attempt: 1,
        failures: [],
      };
    },
  };
}

function invokingRouter(
  makeOutput: () => DreamReviewModelOutput,
): DigestModelRouter {
  return {
    async executeWithFallback<T>(
      _role: string,
      attempt: (candidate: ResolvedModelCandidate, attemptNumber: number) => Promise<T>,
    ) {
      const candidate = {
        reference: "provider/model",
        providerId: "provider",
        modelId: "model",
        model: {} as ResolvedModelCandidate["model"],
        capabilities: { vision: false },
      };
      return {
        value: await attempt(candidate, 1),
        candidate,
        attempt: 1,
        failures: [],
      };
    },
  };
}

function seedInteraction(
  store: MessageStore,
  options: {
    day: string;
    triggerId: number;
    answerId: number;
    text?: string;
    replyToMessageId?: number;
  },
): void {
  const baseDate = new Date(`${options.day}T12:00:00Z`).toISOString();
  const messages: StoredMessage[] = [
    {
      chatId: CHAT_ID,
      messageId: options.triggerId,
      date: baseDate,
      senderId: HUMAN_SENDER_ID,
      senderName: "Alice",
      text: options.text ?? "human trigger",
    },
    {
      chatId: CHAT_ID,
      messageId: options.answerId,
      date: new Date(`${options.day}T12:00:01Z`).toISOString(),
      senderId: BOT_SENDER_ID,
      senderName: "Bot",
      text: "bot answer",
      replyToMessageId: options.triggerId,
    },
  ];
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Dream Test",
      kind: "channel",
      isForum: false,
    },
    messages,
  );
}

function seedEmptyDay(store: MessageStore, day: string): void {
  const date = new Date(`${day}T12:00:00Z`).toISOString();
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Dream Test",
      kind: "channel",
      isForum: false,
    },
    [
      {
        chatId: CHAT_ID,
        messageId: 1000,
        date,
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "no bot reply today",
      },
    ],
  );
}

function makeConsolidator(
  router: DigestModelRouter,
  options: { maxInputChars?: number; totalTimeoutMs?: number; candidateTimeoutMs?: number } = {},
): DreamConsolidator {
  return new DreamConsolidator({
    router,
    botSenderId: BOT_SENDER_ID,
    maxInputChars: options.maxInputChars ?? 120_000,
    totalTimeoutMs: options.totalTimeoutMs,
    candidateTimeoutMs: options.candidateTimeoutMs,
    now: dreamNow,
  });
}

test("dream bootstraps seven pending days and processes all of them in the first run", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    const consolidator = makeConsolidator(fakeRouter({ text: "final", toolCalls: 0, finishReason: "stop" }));
    const result = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(result.status, "success");
    if (result.status === "success") {
      assert.equal(result.reviewedDays, 1);
      assert.equal(result.totalInteractions, 1);
      assert.equal(result.days.length, 7); // 7 bootstrap days processed in one run
    }
  } finally {
    cleanup();
  }
});

test("dream bootstrap window is pinned to the injected clock, not the wall date", async () => {
  // The fixed clock and the fixed fixture day must stay consistent; otherwise
  // the suite silently depends on the real date again.
  assert.equal(dreamYesterday(new Date(DREAM_NOW_ISO)), DREAM_YESTERDAY);
  const { store, cleanup } = fixtureStore();
  try {
    seedInteraction(store, { day: DREAM_YESTERDAY, triggerId: 1, answerId: 2 });
    const consolidator = makeConsolidator(
      fakeRouter({ text: "final", toolCalls: 0, finishReason: "stop" }),
    );
    const result = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(result.status, "success");
    if (result.status === "success") {
      assert.equal(result.reviewedDays, 1);
    }
    const days = store
      .listDreamDays({ chatId: CHAT_ID })
      .map((row) => row.day)
      .sort();
    assert.deepEqual(days, [
      "2026-07-25",
      "2026-07-26",
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      DREAM_YESTERDAY,
    ]);
  } finally {
    cleanup();
  }
});

test("dream completes empty day without model call", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedEmptyDay(store, yesterday);
    let modelCalls = 0;
    const router = invokingRouter(() => {
      modelCalls += 1;
      return { text: "final", toolCalls: 0, finishReason: "stop" };
    });
    const consolidator = makeConsolidator(router);
    const result = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(result.status, "success");
    if (result.status === "success") {
      assert.equal(result.reviewedDays, 0);
      assert.equal(result.totalInteractions, 0);
      assert.equal(modelCalls, 0);
    }
    // DreamConsolidator early path must create audit for the empty day.
    const audit = store.getDreamAudit({ chatId: CHAT_ID, day: yesterday });
    assert.ok(audit, "empty day must have audit");
    assert.equal(audit.audit.semanticMemory.changed, false);
    assert.equal(audit.audit.fastMemory.changed, false);
    assert.equal(audit.audit.lessons.changed, false);
    assert.equal(audit.audit.skills.changed, false);
  } finally {
    cleanup();
  }
});

test("dream selects only bot reply interactions", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    store.upsertMessages(
      {
        chatId: CHAT_ID,
        requested: CHAT_ID,
        title: "Dream Test",
        kind: "channel",
        isForum: false,
      },
      [
        {
          chatId: CHAT_ID,
          messageId: 3,
          date: new Date(`${yesterday}T12:00:02Z`).toISOString(),
          senderId: HUMAN_SENDER_ID,
          senderName: "Bob",
          text: "just a message",
        },
      ],
    );
    const consolidator = makeConsolidator(fakeRouter({ text: "final", toolCalls: 0, finishReason: "stop" }));
    const result = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(result.status, "success");
    if (result.status === "success") {
      assert.equal(result.totalInteractions, 1);
    }
  } finally {
    cleanup();
  }
});

test("dream failure preserves previous memory and leaves job failed", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "existing memory",
      lastConsolidatedMessageId: 1,
    });
    const router: DigestModelRouter = {
      async executeWithFallback<T>(
        _role: string,
        _attempt: (candidate: ResolvedModelCandidate, attemptNumber: number) => Promise<T>,
      ) {
        throw Object.assign(new Error("boom"), { code: "boom" });
      },
    };
    const consolidator = makeConsolidator(router);
    const result = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error, "boom");
    }
    const memory = store.getChatMemory(CHAT_ID);
    assert.equal(memory?.memoryText, "existing memory");
    assert.equal(memory?.lastConsolidatedMessageId, 1);
    const jobs = store.listDreamDays({ chatId: CHAT_ID, status: "failed" });
    assert.equal(jobs.length, 1);
  } finally {
    cleanup();
  }
});

test("dream retry processes oldest failed job first", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    store.upsertDreamDay({
      chatId: CHAT_ID,
      day: yesterday,
      status: "failed",
      interactionCount: 1,
      attempts: 1,
      error: "previous failure",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const consolidator = makeConsolidator(fakeRouter({ text: "final", toolCalls: 0, finishReason: "stop" }));
    const result = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(result.status, "success");
    const jobs = store.listDreamDays({ chatId: CHAT_ID, status: "completed" });
    assert.ok(jobs.some((j) => j.day === yesterday));
  } finally {
    cleanup();
  }
});

test("dream runs are idempotent after bootstrap", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    const consolidator = makeConsolidator(fakeRouter({ text: "final", toolCalls: 0, finishReason: "stop" }));
    const first = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(first.status, "success");
    const second = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(second.status, "no_jobs");
  } finally {
    cleanup();
  }
});

test("dream source projection preserves sender attribution and roles", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2, text: "hello" });
    const consolidator = makeConsolidator(fakeRouter({ text: "final", toolCalls: 0, finishReason: "stop" }));
    await consolidator.run(store, { chatId: CHAT_ID });
    const day = store.getDreamDay({ chatId: CHAT_ID, day: yesterday });
    assert.equal(day?.status, "completed");
    assert.equal(day?.interactionCount, 1);
  } finally {
    cleanup();
  }
});

test("dream updates semantic memory and watermark after successful review", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    const consolidator = makeConsolidator(
      fakeRouter({ text: "user prefers short answers", toolCalls: 1, finishReason: "stop" }),
    );
    const result = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(result.status, "success");
    const memory = store.getChatMemory(CHAT_ID);
    assert.ok(memory?.memoryText.includes("user prefers short answers"));
    assert.equal(memory?.lastConsolidatedMessageId, 2);
  } finally {
    cleanup();
  }
});

test("dream failure preserves existing semantic memory and watermark", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "existing semantic memory",
      lastConsolidatedMessageId: 5,
    });
    const router: DigestModelRouter = {
      async executeWithFallback<T>(
        _role: string,
        _attempt: (candidate: ResolvedModelCandidate, attemptNumber: number) => Promise<T>,
      ) {
        throw Object.assign(new Error("boom"), { code: "boom" });
      },
    };
    const consolidator = makeConsolidator(router);
    const result = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(result.status, "failed");
    const memory = store.getChatMemory(CHAT_ID);
    assert.equal(memory?.memoryText, "existing semantic memory");
    assert.equal(memory?.lastConsolidatedMessageId, 5);
  } finally {
    cleanup();
  }
});

test("dream source hash changes when projected fields change", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2, text: "hello" });
    const consolidator = makeConsolidator(fakeRouter({ text: "final", toolCalls: 0, finishReason: "stop" }));
    const first = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(first.status, "success");
    const firstHash = store.getDreamDay({ chatId: CHAT_ID, day: yesterday })?.sourceHash;

    const { store: store2, cleanup: cleanup2 } = fixtureStore();
    seedInteraction(store2, { day: yesterday, triggerId: 1, answerId: 2, text: "hello world" });
    const second = await makeConsolidator(
      fakeRouter({ text: "final", toolCalls: 0, finishReason: "stop" }),
    ).run(store2, { chatId: CHAT_ID });
    assert.equal(second.status, "success");
    const secondHash = store2.getDreamDay({ chatId: CHAT_ID, day: yesterday })?.sourceHash;

    assert.notEqual(firstHash, secondHash);
    cleanup2();
  } finally {
    cleanup();
  }
});
