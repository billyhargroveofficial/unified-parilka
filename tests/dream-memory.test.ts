import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamConsolidator } from "../src/dream/consolidator.js";
import type { DigestModelRouter } from "../src/digests.js";
import { MessageStore } from "../src/store.js";
import type { StoredMessage } from "../src/store.js";
import type { ResolvedModelCandidate } from "../src/providers/model-router.js";
import type { DreamReviewModelOutput } from "../src/dream/review.js";
import { DREAM_YESTERDAY, dreamNow } from "./support/dream.js";

const CHAT_ID = "-1003179772905";
const BOT_SENDER_ID = "100000000";
const HUMAN_SENDER_ID = "200000000";

function fixtureStore() {
  const directory = mkdtempSync(join(tmpdir(), "parilka-dream-mem-"));
  const dbPath = join(directory, "shared.sqlite");
  const store = new MessageStore(dbPath);
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "Dream Memory Test",
    kind: "channel",
    isForum: false,
  });
  return {
    store,
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

function seedInteraction(
  store: MessageStore,
  options: {
    day: string;
    triggerId: number;
    answerId: number;
    text?: string;
    answerText?: string;
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
      text: options.answerText ?? "bot answer",
      replyToMessageId: options.triggerId,
    },
  ];
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Dream Memory Test",
      kind: "channel",
      isForum: false,
    },
    messages,
  );
}

function seedLargeInteraction(
  store: MessageStore,
  options: {
    day: string;
    triggerId: number;
    answerId: number;
    answerLength: number;
  },
): void {
  seedInteraction(store, {
    day: options.day,
    triggerId: options.triggerId,
    answerId: options.answerId,
    answerText: "x".repeat(options.answerLength),
  });
}

function makeConsolidator(
  router: DigestModelRouter,
  options: {
    maxInputChars?: number;
    maxMemoryChars?: number;
    totalTimeoutMs?: number;
    candidateTimeoutMs?: number;
    runReview?: typeof import("../src/dream/review.js").runDreamReview;
  } = {},
): DreamConsolidator {
  return new DreamConsolidator({
    router,
    botSenderId: BOT_SENDER_ID,
    maxInputChars: options.maxInputChars ?? 120_000,
    maxMemoryChars: options.maxMemoryChars ?? 2_000,
    totalTimeoutMs: options.totalTimeoutMs,
    candidateTimeoutMs: options.candidateTimeoutMs,
    runReview: options.runReview,
    now: dreamNow,
  });
}

test("dream semantic memory replaces current block, not appends", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "old memory",
      lastConsolidatedMessageId: 1,
    });
    const consolidator = makeConsolidator(
      fakeRouter({ text: "replacement memory", toolCalls: 0, finishReason: "stop" }),
    );
    const result = await consolidator.run(store, { chatId: CHAT_ID });
    assert.equal(result.status, "success");
    const memory = store.getChatMemory(CHAT_ID);
    assert.equal(memory?.memoryText, "replacement memory");
  } finally {
    cleanup();
  }
});

function seedNonOverlappingInteractions(store: MessageStore): void {
  seedLargeInteraction(store, {
    day: DREAM_YESTERDAY,
    triggerId: 1,
    answerId: 2,
    answerLength: 80_000,
  });
  // Ensure the second interaction window does not overlap the first (keep
  // more than 30 live rows after the first answer and 8 before the second).
  const filler: StoredMessage[] = [];
  for (let i = 3; i <= 50; i += 1) {
    filler.push({
      chatId: CHAT_ID,
      messageId: i,
      date: new Date(`${DREAM_YESTERDAY}T12:${String(i).padStart(2, "0")}:00Z`).toISOString(),
      senderId: HUMAN_SENDER_ID,
      senderName: "Alice",
      text: `filler ${i}`,
    });
  }
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Dream Memory Test",
      kind: "channel",
      isForum: false,
    },
    filler,
  );
  seedLargeInteraction(store, {
    day: DREAM_YESTERDAY,
    triggerId: 51,
    answerId: 52,
    answerLength: 80_000,
  });
}

test("dream second batch sees staged memory from first batch", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedNonOverlappingInteractions(store);

    const seenMemories: (string | undefined)[] = [];
    const outputs: DreamReviewModelOutput[] = [
      { text: "batch one memory", toolCalls: 0, finishReason: "stop" },
      { text: "batch two memory", toolCalls: 0, finishReason: "stop" },
    ];
    let outputIndex = 0;
    const runReview = async (
      options: Parameters<typeof import("../src/dream/review.js").runDreamReview>[0],
    ) => {
      seenMemories.push(options.currentMemory);
      const output = outputs[outputIndex]!;
      outputIndex += 1;
      return {
        applied: true,
        model: "provider/model",
        providerId: "provider",
        fallbackCount: 0,
        toolCalls: output.toolCalls,
        finishReason: output.finishReason,
        final: output.text,
      };
    };

    const consolidator = makeConsolidator(fakeRouter({ text: "", toolCalls: 0, finishReason: "stop" }), {
      maxInputChars: 1_000,
      runReview,
    });
    await consolidator.run(store, { chatId: CHAT_ID });

    assert.deepEqual(seenMemories, ["", "batch one memory"]);
    assert.equal(store.getChatMemory(CHAT_ID)?.memoryText, "batch two memory");
  } finally {
    cleanup();
  }
});

test("dream failure in batch two preserves original memory", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedNonOverlappingInteractions(store);
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "original memory",
      lastConsolidatedMessageId: 1,
    });

    let batch = 0;
    const runReview = async (
      options: Parameters<typeof import("../src/dream/review.js").runDreamReview>[0],
    ) => {
      batch += 1;
      if (batch === 2) {
        throw new Error("batch two failed");
      }
      return {
        applied: true,
        model: "provider/model",
        providerId: "provider",
        fallbackCount: 0,
        toolCalls: 0,
        finishReason: "stop",
        final: "staged from batch one",
      };
    };

    const consolidator = makeConsolidator(fakeRouter({ text: "", toolCalls: 0, finishReason: "stop" }), {
      maxInputChars: 1_000,
      runReview,
    });
    const result = await consolidator.run(store, { chatId: CHAT_ID });

    assert.equal(result.status, "failed");
    const memory = store.getChatMemory(CHAT_ID);
    assert.equal(memory?.memoryText, "original memory");
    assert.equal(memory?.lastConsolidatedMessageId, 1);
  } finally {
    cleanup();
  }
});

test("dream routes oversized final through tool-free shortening", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });

    let summaryCalls = 0;
    const router: DigestModelRouter = {
      async executeWithFallback<T>(
        role: string,
        _attempt: (
          candidate: ResolvedModelCandidate,
          attemptNumber: number,
        ) => Promise<T>,
      ) {
        summaryCalls += 1;
        const candidate = {
          reference: "provider/model",
          providerId: "provider",
          modelId: "model",
          model: {} as ResolvedModelCandidate["model"],
          capabilities: { vision: false },
        };
        const output = summaryCalls === 1
          ? { text: "x".repeat(5_000), toolCalls: 0, finishReason: "stop" }
          : { text: "shortened", toolCalls: 0, finishReason: "stop" };
        return {
          value: output as T,
          candidate,
          attempt: 1,
          failures: [],
        };
      },
    };

    const consolidator = makeConsolidator(router, { maxMemoryChars: 2_000 });
    await consolidator.run(store, { chatId: CHAT_ID });

    assert.equal(store.getChatMemory(CHAT_ID)?.memoryText, "shortened");
    assert.equal(summaryCalls, 2);
  } finally {
    cleanup();
  }
});

test("dream rejects incomplete finish reason and preserves memory", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "original memory",
      lastConsolidatedMessageId: 1,
    });

    const consolidator = makeConsolidator(
      fakeRouter({ text: "ok", toolCalls: 0, finishReason: "content-filter" }),
    );
    const result = await consolidator.run(store, { chatId: CHAT_ID });

    assert.equal(result.status, "failed");
    const memory = store.getChatMemory(CHAT_ID);
    assert.equal(memory?.memoryText, "original memory");
  } finally {
    cleanup();
  }
});

test("dream stop with empty final fails and preserves memory and watermark", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    seedInteraction(store, { day: yesterday, triggerId: 1, answerId: 2 });
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "original memory",
      lastConsolidatedMessageId: 1,
    });

    const consolidator = makeConsolidator(
      fakeRouter({ text: "", toolCalls: 0, finishReason: "stop" }),
    );
    const result = await consolidator.run(store, { chatId: CHAT_ID });

    assert.equal(result.status, "failed");
    const memory = store.getChatMemory(CHAT_ID);
    assert.equal(memory?.memoryText, "original memory");
    assert.equal(memory?.lastConsolidatedMessageId, 1);
  } finally {
    cleanup();
  }
});

test("dream empty day does not change semantic memory", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    const yesterday = DREAM_YESTERDAY;
    store.upsertMessages(
      {
        chatId: CHAT_ID,
        requested: CHAT_ID,
        title: "Dream Memory Test",
        kind: "channel",
        isForum: false,
      },
      [
        {
          chatId: CHAT_ID,
          messageId: 1000,
          date: new Date(`${yesterday}T12:00:00Z`).toISOString(),
          senderId: HUMAN_SENDER_ID,
          senderName: "Alice",
          text: "no bot reply today",
        },
      ],
    );
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "untouched memory",
      lastConsolidatedMessageId: 1,
    });

    const calls: string[] = [];
    const router: DigestModelRouter = {
      async executeWithFallback<T>(
        _role: string,
        _attempt: (
          candidate: ResolvedModelCandidate,
          attemptNumber: number,
        ) => Promise<T>,
      ) {
        throw new Error("must not be called");
      },
    };
    const originalUpsert = store.upsertChatMemory.bind(store);
    store.upsertChatMemory = (input) => {
      calls.push(input.memoryText);
      return originalUpsert(input);
    };

    const consolidator = makeConsolidator(router);
    const result = await consolidator.run(store, { chatId: CHAT_ID });

    assert.equal(result.status, "success");
    assert.equal(calls.length, 0);
    assert.equal(store.getChatMemory(CHAT_ID)?.memoryText, "untouched memory");
  } finally {
    cleanup();
  }
});
