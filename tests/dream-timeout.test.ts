import assert from "node:assert/strict";
import { test } from "node:test";
import { safeDreamErrorCode } from "../src/dream/diagnostics.js";
import {
  runDreamReview,
  type DreamReviewGenerate,
} from "../src/dream/review.js";
import {
  shortenDreamMemoryBlock,
  type DreamShortenGenerate,
  type DreamShortenGenerateResult,
} from "../src/dream/shorten-memory.js";
import { ModelRoutingError } from "../src/providers/model-router.js";
import {
  DREAM_CHAT_ID,
  dreamDomAbortError,
  dreamFixtureStore,
  dreamNodeAbortError,
  dreamTimeoutRouter,
} from "./support/dream.js";

/** Fake generate that honors only the deadline signal and rejects on abort. */
function abortAwaitingShortenGenerate(
  calls: Array<Parameters<DreamShortenGenerate>[0]>,
  makeAbortError: () => Error,
): DreamShortenGenerate {
  return (params) => {
    calls.push(params);
    return new Promise<DreamShortenGenerateResult>((_resolve, reject) => {
      const signal = params.abortSignal;
      if (!signal) {
        reject(new Error("Shortening must provide a candidate deadline signal."));
        return;
      }
      const onAbort = () => reject(makeAbortError());
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
}

function abortAwaitingReviewGenerate(
  calls: Array<Parameters<DreamReviewGenerate>[0]>,
): DreamReviewGenerate {
  return (params) => {
    calls.push(params);
    // Never resolves on its own: only the deadline abort ends the attempt.
    return new Promise((_resolve, reject) => {
      const signal = params.abortSignal;
      if (!signal) {
        reject(new Error("Review must provide an abort signal."));
        return;
      }
      const onAbort = () => reject(dreamDomAbortError());
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw.");
}

function assertTransportTimeoutDiagnostic(error: unknown): void {
  assert.ok(error instanceof ModelRoutingError);
  assert.equal(error.code, "candidates_exhausted");
  const machine = safeDreamErrorCode(error);
  assert.equal(machine, "candidates_exhausted:transport:ETIMEDOUT");
  assert.ok(!machine.includes("ABORT_ERR"));
  assert.ok(!machine.endsWith(":20"));
}

test("shorten producer wraps DOM abort code 20 expiry as transport ETIMEDOUT", async () => {
  const router = dreamTimeoutRouter(["timeouttest:shorten-a"]);
  const calls: Array<Parameters<DreamShortenGenerate>[0]> = [];

  const error = await captureError(() =>
    shortenDreamMemoryBlock({
      router,
      block: "oversized memory block",
      maxChars: 2_000,
      maxOutputTokens: 8_192,
      candidateTimeoutMs: 500,
      generate: abortAwaitingShortenGenerate(calls, dreamDomAbortError),
    }),
  );

  assertTransportTimeoutDiagnostic(error);
  assert.ok(error instanceof ModelRoutingError);
  // The real router invoked the attempt callback and recorded the failure.
  assert.equal(error.attempts.length, 1);
  assert.equal(error.attempts[0]?.decision.reason, "transport");
  // The configured deadline wrapper keeps the provider abort in cause.
  const timedOut = error.cause as {
    code?: string;
    cause?: { name?: string; code?: number };
  };
  assert.equal(timedOut.code, "ETIMEDOUT");
  assert.equal(timedOut.cause?.name, "AbortError");
  assert.equal(timedOut.cause?.code, 20);

  // Bounded internal retry: both attempts of the default budget hit the
  // candidate deadline before the candidate is exhausted. Every attempt is
  // tool-free, SDK retries disabled, stopWhen stays false, and each gets a
  // fresh deadline signal (no state shared between attempts).
  assert.equal(calls.length, 2);
  for (const params of calls) {
    assert.equal(params.tools, undefined);
    assert.equal(params.maxRetries, 0);
    assert.equal(typeof params.stopWhen, "function");
    const stopWhen = params.stopWhen as (...args: unknown[]) => boolean;
    assert.equal(stopWhen(), false);
    assert.ok(params.abortSignal);
  }
  assert.notEqual(calls[0]!.abortSignal, calls[1]!.abortSignal);
});

test("shorten producer wraps ABORT_ERR expiry as transport ETIMEDOUT too", async () => {
  const router = dreamTimeoutRouter(["timeouttest:shorten-a"]);
  const calls: Array<Parameters<DreamShortenGenerate>[0]> = [];

  const error = await captureError(() =>
    shortenDreamMemoryBlock({
      router,
      block: "oversized memory block",
      maxChars: 2_000,
      maxOutputTokens: 8_192,
      candidateTimeoutMs: 500,
      maxCandidateAttempts: 1,
      generate: abortAwaitingShortenGenerate(calls, dreamNodeAbortError),
    }),
  );

  assertTransportTimeoutDiagnostic(error);
  assert.ok(error instanceof ModelRoutingError);
  const timedOut = error.cause as { code?: string; cause?: { code?: string } };
  assert.equal(timedOut.code, "ETIMEDOUT");
  assert.equal(timedOut.cause?.code, "ABORT_ERR");
  // maxCandidateAttempts=1 keeps the single-call shape: no internal retry.
  assert.equal(calls.length, 1);
});

test("runDreamReview exhausted candidate timeout maps to transport ETIMEDOUT", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-cand-timeout-");
  try {
    const router = dreamTimeoutRouter(["timeouttest:review-a"]);
    const calls: Array<Parameters<DreamReviewGenerate>[0]> = [];

    const error = await captureError(() =>
      runDreamReview({
        router,
        store,
        chatId: DREAM_CHAT_ID,
        sourceMessageId: 2,
        sourceText: '{"text":"interaction"}',
        currentMemory: "",
        maxCandidateAttempts: 1,
        candidateTimeoutMs: 500,
        totalTimeoutMs: 1_000,
        generate: abortAwaitingReviewGenerate(calls),
      }),
    );

    assertTransportTimeoutDiagnostic(error);
    assert.ok(error instanceof ModelRoutingError);
    assert.equal(error.attempts.length, 1);
    assert.equal(error.attempts[0]?.decision.reason, "transport");
    // Candidate deadline wrapper preserves the provider abort error in cause.
    const timedOut = error.cause as { code?: string; cause?: { name?: string } };
    assert.equal(timedOut.code, "ETIMEDOUT");
    assert.equal(timedOut.cause?.name, "AbortError");
    // No internal retry remains: a single attempt exhausted the candidate.
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test("runDreamReview internal total deadline reports transport ETIMEDOUT, not abort", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-total-timeout-");
  try {
    const router = dreamTimeoutRouter([
      "timeouttest:review-a",
      "timeouttest:review-b",
    ]);
    let generateCalls = 0;
    // Ignores the per-candidate abort and outlives both the candidate timeout
    // (500 ms) and the total deadline (1000 ms), so the total-expiry branch is
    // the one that classifies the failure for the first candidate.
    const generate: DreamReviewGenerate = async () => {
      generateCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      throw Object.assign(new Error("late invalid output"), {
        name: "BotAgentProtocolError",
        code: "empty_review",
        modelFallback: true,
      });
    };

    const error = await captureError(() =>
      runDreamReview({
        router,
        store,
        chatId: DREAM_CHAT_ID,
        sourceMessageId: 2,
        sourceText: '{"text":"interaction"}',
        currentMemory: "",
        maxCandidateAttempts: 1,
        candidateTimeoutMs: 500,
        totalTimeoutMs: 1_000,
        generate,
      }),
    );

    assertTransportTimeoutDiagnostic(error);
    assert.ok(error instanceof ModelRoutingError);
    const timedOut = error.cause as { code?: string };
    assert.equal(timedOut.code, "ETIMEDOUT");
    // The expired total deadline rejects the second candidate in the precheck
    // without ever starting another model call.
    assert.equal(generateCalls, 1);
  } finally {
    cleanup();
  }
});
