import assert from "node:assert/strict";
import { test } from "node:test";
import type { DigestModelRouter } from "../src/digests.js";
import { safeDreamErrorCode } from "../src/dream/diagnostics.js";
import {
  shortenDreamMemoryBlock,
  type DreamShortenGenerate,
  type DreamShortenGenerateResult,
  type ShortenMemoryBlockOptions,
} from "../src/dream/shorten-memory.js";
import { ModelRoutingError } from "../src/providers/model-router.js";
import {
  DREAM_CHAT_ID,
  DREAM_YESTERDAY,
  dreamDomAbortError,
  dreamFixtureStore,
  dreamTimeoutRouter,
  makeDreamConsolidator,
  seedDreamInteraction,
} from "./support/dream.js";

const BLOCK = "ORIGINAL memory block: chat facts to compress";
const MAX_CHARS = 2_000;
const TARGET_CHARS = Math.floor(MAX_CHARS * 0.85);

type ShortenCallParams = Parameters<DreamShortenGenerate>[0];

/** Fake generate replaying scripted results; the last entry repeats. */
function scriptedShortenGenerate(
  calls: ShortenCallParams[],
  results: readonly DreamShortenGenerateResult[],
): DreamShortenGenerate {
  return (params) => {
    calls.push(params);
    const result = results[Math.min(calls.length - 1, results.length - 1)]!;
    return Promise.resolve(result);
  };
}

function promptOf(call: ShortenCallParams): string {
  assert.equal(typeof call.prompt, "string");
  return call.prompt as string;
}

function shortenWith(
  generate: DreamShortenGenerate,
  overrides: Partial<Parameters<typeof shortenDreamMemoryBlock>[0]> = {},
): Promise<{
  text: string;
  model: string;
  providerId: string;
  fallbackCount: number;
}> {
  return shortenDreamMemoryBlock({
    router: dreamTimeoutRouter(["timeouttest:shorten-a"]),
    block: BLOCK,
    maxChars: MAX_CHARS,
    maxOutputTokens: 8_192,
    candidateTimeoutMs: 60_000,
    generate,
    ...overrides,
  });
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw.");
}

test("shortening re-asks after oversized output and succeeds inside one candidate", async () => {
  const calls: ShortenCallParams[] = [];
  const oversizedText = `first-oversized-output ${"u".repeat(5_000)}`;

  const result = await shortenWith(
    scriptedShortenGenerate(calls, [
      { text: oversizedText, finishReason: "stop" },
      { text: "shortened memory facts", finishReason: "stop" },
    ]),
  );

  assert.equal(result.text, "shortened memory facts");
  assert.ok(result.text.length <= MAX_CHARS);
  assert.equal(result.providerId, "timeouttest");
  assert.ok(result.model.includes("shorten-a"));
  assert.equal(result.fallbackCount, 0);

  assert.equal(calls.length, 2);
  // Both attempts re-compress the original block, never the prior output.
  for (const call of calls) {
    assert.ok(promptOf(call).includes(BLOCK));
    assert.ok(promptOf(call).includes(`${MAX_CHARS}`));
    assert.ok(promptOf(call).includes(`${TARGET_CHARS}`));
    assert.equal(call.tools, undefined);
    assert.equal(call.maxRetries, 0);
    const stopWhen = call.stopWhen as (...args: unknown[]) => boolean;
    assert.equal(stopWhen(), false);
  }
  // Safe retry feedback: only the previous length and the hard max, never
  // the previous output text (no stateful leakage between attempts).
  assert.ok(!promptOf(calls[0]!).includes("Предыдущий ответ"));
  const retryPrompt = promptOf(calls[1]!);
  assert.ok(retryPrompt.includes(`${oversizedText.length}`));
  assert.ok(!retryPrompt.includes("first-oversized-output"));
  // Fresh deadline signal per attempt.
  assert.notEqual(calls[0]!.abortSignal, calls[1]!.abortSignal);
});

test("shortening keeps shortening_output_too_large when every attempt stays oversized", async () => {
  const calls: ShortenCallParams[] = [];
  const oversizedText = `OVERSIZED-LEAK ${"z".repeat(5_000)}`;

  const error = await captureError(() =>
    shortenWith(
      scriptedShortenGenerate(calls, [
        { text: oversizedText, finishReason: "stop" },
      ]),
    ),
  );

  assert.ok(error instanceof ModelRoutingError);
  assert.equal(error.code, "candidates_exhausted");
  assert.equal(error.attempts.length, 1);
  assert.equal(error.attempts[0]?.decision.reason, "invalid_output");
  assert.equal(
    safeDreamErrorCode(error),
    "candidates_exhausted:invalid_output:shortening_output_too_large",
  );
  const lastInvalid = error.cause as { code?: string; modelFallback?: boolean };
  assert.equal(lastInvalid.code, "shortening_output_too_large");
  assert.equal(lastInvalid.modelFallback, true);

  assert.equal(calls.length, 2);
  assert.ok(promptOf(calls[1]!).includes(`${oversizedText.length}`));
  assert.ok(!promptOf(calls[0]!).includes("OVERSIZED-LEAK"));
  assert.ok(!promptOf(calls[1]!).includes("OVERSIZED-LEAK"));
});

test("shortening re-asks after empty output and succeeds", async () => {
  const calls: ShortenCallParams[] = [];

  const result = await shortenWith(
    scriptedShortenGenerate(calls, [
      { text: "   ", finishReason: "stop" },
      { text: "compact facts", finishReason: "stop" },
    ]),
  );

  assert.equal(result.text, "compact facts");
  assert.equal(calls.length, 2);
  // Empty output is not an overrun: the re-ask carries no overrun feedback.
  assert.ok(!promptOf(calls[1]!).includes("Предыдущий ответ"));
  assert.ok(promptOf(calls[1]!).includes(BLOCK));
});

test("shortening keeps empty_shortening when every attempt is empty", async () => {
  const calls: ShortenCallParams[] = [];

  const error = await captureError(() =>
    shortenWith(
      scriptedShortenGenerate(calls, [{ text: "", finishReason: "stop" }]),
    ),
  );

  assert.ok(error instanceof ModelRoutingError);
  assert.equal(
    safeDreamErrorCode(error),
    "candidates_exhausted:invalid_output:empty_shortening",
  );
  assert.equal(calls.length, 2);
});

test("shortening re-asks after incomplete finish and succeeds", async () => {
  const calls: ShortenCallParams[] = [];

  const result = await shortenWith(
    scriptedShortenGenerate(calls, [
      { text: "partial output cut off", finishReason: "length" },
      { text: "complete facts", finishReason: "stop" },
    ]),
  );

  assert.equal(result.text, "complete facts");
  assert.equal(calls.length, 2);
  assert.ok(promptOf(calls[1]!).includes(BLOCK));
});

test("shortening keeps incomplete finish machine code when attempts exhaust", async () => {
  const calls: ShortenCallParams[] = [];

  const error = await captureError(() =>
    shortenWith(
      scriptedShortenGenerate(calls, [
        { text: "partial output cut off", finishReason: "length" },
      ]),
    ),
  );

  assert.ok(error instanceof ModelRoutingError);
  assert.equal(error.attempts[0]?.decision.reason, "invalid_output");
  assert.equal(
    safeDreamErrorCode(error),
    "candidates_exhausted:invalid_output:incomplete_shortening:length",
  );
  assert.equal(calls.length, 2);
});

test("shortening content-filter stays terminal without internal retry", async () => {
  const calls: ShortenCallParams[] = [];

  const error = await captureError(() =>
    shortenWith(
      scriptedShortenGenerate(calls, [
        { text: "", finishReason: "content-filter" },
      ]),
    ),
  );

  assert.ok(error instanceof ModelRoutingError);
  assert.equal(error.code, "terminal_error");
  assert.equal(error.attempts.length, 1);
  assert.equal(error.attempts[0]?.decision.reason, "content_filter");
  assert.equal(safeDreamErrorCode(error), "terminal_error:content_filter");
  assert.equal(calls.length, 1);
});

test("shortening maxCandidateAttempts=1 keeps a single call", async () => {
  const calls: ShortenCallParams[] = [];

  const error = await captureError(() =>
    shortenWith(
      scriptedShortenGenerate(calls, [
        { text: "y".repeat(5_000), finishReason: "stop" },
      ]),
      { maxCandidateAttempts: 1 },
    ),
  );

  assert.ok(error instanceof ModelRoutingError);
  assert.equal(
    safeDreamErrorCode(error),
    "candidates_exhausted:invalid_output:shortening_output_too_large",
  );
  assert.equal(calls.length, 1);
});

const INVALID_BOUND_CASES: ReadonlyArray<{
  label: string;
  overrides: Partial<ShortenMemoryBlockOptions>;
  field: string;
}> = [
  { label: "maxChars NaN", overrides: { maxChars: Number.NaN }, field: "maxChars" },
  { label: "maxChars below min", overrides: { maxChars: 499 }, field: "maxChars" },
  { label: "maxChars above max", overrides: { maxChars: 4_001 }, field: "maxChars" },
  { label: "maxOutputTokens NaN", overrides: { maxOutputTokens: Number.NaN }, field: "maxOutputTokens" },
  { label: "maxOutputTokens below min", overrides: { maxOutputTokens: 63 }, field: "maxOutputTokens" },
  { label: "maxOutputTokens above max", overrides: { maxOutputTokens: 32_769 }, field: "maxOutputTokens" },
];

function forbiddenRouter(counter: { count: number }): DigestModelRouter {
  return {
    executeWithFallback(): Promise<never> {
      counter.count += 1;
      return Promise.reject(
        new Error("router must not run for invalid shorten bounds"),
      );
    },
  };
}

test("shortening rejects invalid maxChars/maxOutputTokens before router or generate work", async () => {
  for (const c of INVALID_BOUND_CASES) {
    const routerCounter = { count: 0 };
    const generateCalls: ShortenCallParams[] = [];
    const error = await captureError(() =>
      shortenDreamMemoryBlock({
        router: forbiddenRouter(routerCounter),
        block: BLOCK,
        maxChars: MAX_CHARS,
        maxOutputTokens: 8_192,
        candidateTimeoutMs: 60_000,
        generate: scriptedShortenGenerate(generateCalls, [
          { text: "must not run", finishReason: "stop" },
        ]),
        ...c.overrides,
      }),
    );
    assert.ok(error instanceof Error, c.label);
    assert.match(error.message, /must be an integer between/, c.label);
    assert.ok(error.message.includes(c.field), c.label);
    assert.equal(routerCounter.count, 0, c.label);
    assert.equal(generateCalls.length, 0, c.label);
  }
});

test("shortening retries the same candidate after its attempt deadline expires", async () => {
  const calls: ShortenCallParams[] = [];
  const generate: DreamShortenGenerate = (params) => {
    calls.push(params);
    if (calls.length === 1) {
      // First attempt hangs until its own candidate deadline aborts it.
      return new Promise<DreamShortenGenerateResult>((_, reject) => {
        const signal = params.abortSignal;
        if (!signal || signal.aborted) {
          reject(dreamDomAbortError());
          return;
        }
        signal.addEventListener("abort", () => reject(dreamDomAbortError()), {
          once: true,
        });
      });
    }
    return Promise.resolve({ text: "facts after timeout", finishReason: "stop" });
  };

  const result = await shortenWith(generate, { candidateTimeoutMs: 500 });

  assert.equal(result.text, "facts after timeout");
  assert.ok(result.model.includes("shorten-a"));
  assert.equal(result.fallbackCount, 0);
  assert.equal(calls.length, 2);
  // Fresh deadline signal per internal attempt, same candidate.
  assert.notEqual(calls[0]!.abortSignal, calls[1]!.abortSignal);
  assert.equal(calls[1]!.abortSignal?.aborted, false);
});

test("shortening falls back to the next candidate with a fresh budget and clean state", async () => {
  const calls: ShortenCallParams[] = [];
  const oversizedText = `fallback-oversized ${"v".repeat(5_000)}`;

  const result = await shortenWith(
    scriptedShortenGenerate(calls, [
      { text: oversizedText, finishReason: "stop" },
      { text: oversizedText, finishReason: "stop" },
      { text: "second candidate facts", finishReason: "stop" },
    ]),
    {
      router: dreamTimeoutRouter([
        "timeouttest:shorten-a",
        "timeouttest:shorten-b",
      ]),
      maxCandidateAttempts: 2,
    },
  );

  assert.equal(result.text, "second candidate facts");
  assert.ok(result.model.includes("shorten-b"));
  assert.equal(result.providerId, "timeouttest");
  assert.equal(result.fallbackCount, 1);
  assert.equal(calls.length, 3);

  // The fresh candidate restarts its internal budget with no numeric overrun
  // feedback and no output text carried over from the failed candidate.
  const freshPrompt = promptOf(calls[2]!);
  assert.ok(freshPrompt.includes(BLOCK));
  assert.ok(!freshPrompt.includes("Предыдущий ответ"));
  assert.ok(!freshPrompt.includes(`${oversizedText.length}`));
  assert.ok(!freshPrompt.includes("fallback-oversized"));
});

test("shortening total deadline reports transport ETIMEDOUT, not abort", async () => {
  const router = dreamTimeoutRouter([
    "timeouttest:shorten-a",
    "timeouttest:shorten-b",
  ]);
  let generateCalls = 0;
  // Ignores the per-candidate abort and outlives both the candidate timeout
  // (500 ms) and the total deadline (1000 ms), so the total-expiry branch is
  // the one that classifies the failure for the first candidate.
  const generate: DreamShortenGenerate = async () => {
    generateCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    throw Object.assign(new Error("late invalid output"), {
      name: "BotAgentProtocolError",
      code: "empty_shortening",
      modelFallback: true,
    });
  };

  const error = await captureError(() =>
    shortenDreamMemoryBlock({
      router,
      block: BLOCK,
      maxChars: MAX_CHARS,
      maxOutputTokens: 8_192,
      candidateTimeoutMs: 500,
      totalTimeoutMs: 1_000,
      maxCandidateAttempts: 1,
      generate,
    }),
  );

  assert.ok(error instanceof ModelRoutingError);
  assert.equal(error.code, "candidates_exhausted");
  assert.equal(
    safeDreamErrorCode(error),
    "candidates_exhausted:transport:ETIMEDOUT",
  );
  const timedOut = error.cause as { code?: string };
  assert.equal(timedOut.code, "ETIMEDOUT");
  assert.ok(!safeDreamErrorCode(error).endsWith(":20"));
  // The expired total deadline rejects the second candidate in the precheck
  // without ever starting another model call.
  assert.equal(generateCalls, 1);
});

test("dream discards stage and keeps diagnostic when every shortening attempt stays oversized", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-shorten-");
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

    const oversizedText = "x".repeat(5_000);
    const shortenCalls: ShortenCallParams[] = [];
    const result = await makeDreamConsolidator(
      dreamTimeoutRouter(["timeouttest:shorten-a"]),
      {
        maxMemoryChars: MAX_CHARS,
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
            final: oversizedText,
          };
        },
        shortenMemory: (options) =>
          shortenDreamMemoryBlock({
            ...options,
            generate: scriptedShortenGenerate(shortenCalls, [
              { text: oversizedText, finishReason: "stop" },
            ]),
          }),
      },
    ).run(store, { chatId: DREAM_CHAT_ID });

    const expected =
      "candidates_exhausted:invalid_output:shortening_output_too_large";
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error, expected);
    }
    // The real bounded retry ran both internal attempts before giving up.
    assert.equal(shortenCalls.length, 2);
    // The whole day stage is discarded; nothing reaches SQLite.
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.memoryText, "original memory");
    assert.equal(store.getChatMemory(DREAM_CHAT_ID)?.lastConsolidatedMessageId, 1);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listChatLessons(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listChatSkills(DREAM_CHAT_ID).length, 0);
    assert.equal(
      store.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY })?.error,
      expected,
    );
  } finally {
    cleanup();
  }
});
