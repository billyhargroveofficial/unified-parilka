import assert from "node:assert/strict";
import { test } from "node:test";
import { LoadAPIKeyError } from "ai";
import { z } from "zod";
import {
  ModelContentFilterError,
  ModelRouter,
  ModelRoutingError,
  classifyModelFallback,
} from "../src/providers/model-router.js";
import {
  apiError,
  captureError,
  config,
  ENV,
} from "./support/model-router.js";

test("fallback classifier permits provider-local availability failures but not bad requests", () => {
  const validationError = captureError(() => z.string().parse(42));
  const cases: Array<{
    name: string;
    error: unknown;
    expected: ReturnType<typeof classifyModelFallback>;
  }> = [
    {
      name: "transport code",
      error: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      expected: { fallback: true, reason: "transport" },
    },
    {
      name: "retryable fetch",
      error: apiError(undefined, true),
      expected: { fallback: true, reason: "transport" },
    },
    {
      name: "429",
      error: apiError(429),
      expected: { fallback: true, reason: "rate_limit" },
    },
    {
      name: "5xx",
      error: apiError(503),
      expected: { fallback: true, reason: "server_error" },
    },
    {
      name: "content filter",
      error: new ModelContentFilterError("blocked"),
      expected: { fallback: false, reason: "content_filter" },
    },
    {
      name: "auth status",
      error: apiError(401),
      expected: { fallback: true, reason: "auth" },
    },
    {
      name: "missing key",
      error: new LoadAPIKeyError({ message: "missing key" }),
      expected: { fallback: true, reason: "auth" },
    },
    {
      name: "validation",
      error: validationError,
      expected: { fallback: false, reason: "validation" },
    },
    {
      name: "abort",
      error: Object.assign(new Error("aborted"), { name: "AbortError" }),
      expected: { fallback: false, reason: "abort" },
    },
    {
      name: "candidate timeout wrapped around provider abort",
      error: Object.assign(new Error("candidate timed out"), {
        code: "ETIMEDOUT",
        cause: Object.assign(new Error("aborted"), { name: "AbortError" }),
      }),
      expected: { fallback: true, reason: "transport" },
    },
    {
      name: "request timeout",
      error: apiError(408, true),
      expected: { fallback: true, reason: "transport" },
    },
    {
      name: "bad request even if provider marked retryable",
      error: apiError(400, true),
      expected: { fallback: false, reason: "client_error" },
    },
    {
      name: "generic retryable flag",
      error: Object.assign(new Error("not a transport failure"), {
        retryable: true,
      }),
      expected: { fallback: false, reason: "other" },
    },
  ];

  for (const scenario of cases) {
    assert.deepEqual(
      classifyModelFallback(scenario.error),
      scenario.expected,
      scenario.name,
    );
  }
});

test("fallback attempts preserve configured order and return model attribution", async () => {
  const input = config();
  input.roles.turn = [
    "openai_primary:gpt-first",
    "anthropic_backup:claude-second",
    "openai_primary:gpt-third",
  ];
  const router = new ModelRouter(input, { env: ENV });
  const attempted: string[] = [];

  await assert.rejects(
    router.executeWithFallback(
      "turn",
      async (candidate, attemptNumber) => {
        attempted.push(candidate.reference);
        if (attemptNumber === 1) {
          throw apiError(429);
        }
        throw new ModelContentFilterError("blocked");
      },
    ),
    (error) => {
      assert.equal((error as Error).name, "ModelRoutingError");
      return true;
    },
  );

  assert.deepEqual(attempted, [
    "openai_primary:gpt-first",
    "anthropic_backup:claude-second",
  ]);
});

test("router preserves AbortError identity and never reaches a backup candidate", async () => {
  const router = new ModelRouter(config(), { env: ENV });
  const abort = Object.assign(new Error("operator stopped the turn"), {
    name: "AbortError",
  });
  const attempts: string[] = [];

  await assert.rejects(
    router.executeWithFallback(
      "turn",
      async (candidate) => {
        attempts.push(candidate.reference);
        throw abort;
      },
    ),
    (error) => error === abort,
  );
  assert.deepEqual(attempts, [config().roles.turn[0]]);
});

test("an expired subscription falls through and exhausted retryable candidates are typed", async () => {
  const input = config();
  input.roles.turn = [
    "openai_primary:gpt-first",
    "anthropic_backup:claude-second",
  ];
  const router = new ModelRouter(input, { env: ENV });
  const terminalAttempts: string[] = [];

  const authFallback = await router.executeWithFallback(
    "turn",
    async (candidate, attempt) => {
      terminalAttempts.push(candidate.reference);
      if (attempt === 1) {
        throw new LoadAPIKeyError({ message: "invalid subscription" });
      }
      return "backup completed";
    },
  );
  assert.equal(authFallback.value, "backup completed");
  assert.equal(authFallback.failures[0]?.decision.reason, "auth");
  assert.deepEqual(terminalAttempts, input.roles.turn);

  await assert.rejects(
    router.executeWithFallback("turn", async () => {
      throw apiError(503);
    }),
    (error) => {
      assert.ok(error instanceof ModelRoutingError);
      assert.equal(error.code, "candidates_exhausted");
      assert.deepEqual(
        error.attempts.map(({ candidate }) => candidate),
        input.roles.turn,
      );
      return true;
    },
  );
});
