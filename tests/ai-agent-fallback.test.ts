import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import {
  candidate,
  makeAgent,
  mockModel,
  request,
  response,
  toolCall,
  toolResponse,
} from "./support/ai-agent.js";
import { ModelRoutingError } from "../src/providers/model-router.js";

test("content filtering is terminal and never tries the backup provider", async () => {
  const blocked = mockModel([response([], "content-filter")]);
  const backup = mockModel([
    response(
      [{ type: "text", text: "ответ запасной модели" }],
      "stop",
    ),
  ]);
  const fixture = makeAgent([
    candidate("primary:blocked", blocked),
    candidate("backup:working", backup),
  ]);

  await assert.rejects(fixture.agent.run(request()), (error) => {
    assert.ok(error instanceof ModelRoutingError);
    assert.equal(error.code, "terminal_error");
    assert.equal(error.attempts[0]?.decision.reason, "content_filter");
    return true;
  });
  assert.equal(blocked.doGenerateCalls.length, 1);
  assert.equal(backup.doGenerateCalls.length, 0);
});

test("empty stop with two candidates falls back to backup after local retry", async () => {
  // Primary: empty stop → local no-tools retry → still empty
  // → empty_final (fallbackEligible=true) → router falls back
  const primary = mockModel([
    response([], "stop"),
    response([], "stop"),
  ]);
  const backup = mockModel([
    response([{ type: "text", text: "ответ запасной модели" }], "stop"),
  ]);
  const fixture = makeAgent([
    candidate("primary:empty", primary),
    candidate("backup:working", backup),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "ответ запасной модели");
  assert.equal(primary.doGenerateCalls.length, 2);
  assert.deepEqual(primary.doGenerateCalls[1]?.toolChoice, { type: "none" });
  assert.equal(backup.doGenerateCalls.length, 1);
  const retryLog = fixture.logs.find(
    (record) => record.event === "bot.agent.empty_final_retry",
  );
  assert.ok(retryLog);
  assert.equal(retryLog.candidate, "primary:empty");
});

test("single-candidate empty_final exhaustion gives safe diagnostics via ModelRoutingError", async () => {
  // Single candidate: empty → retry → empty → empty_final (fallbackEligible=true)
  // → router has only one candidate → ModelRoutingError("candidates_exhausted")
  const model = mockModel([
    response([], "stop"),
    response([], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:only", model)]);

  await assert.rejects(fixture.agent.run(request()), (error) => {
    assert.ok(error instanceof ModelRoutingError);
    assert.equal(error.code, "candidates_exhausted");
    assert.equal(error.attempts.length, 1);
    assert.equal(error.attempts[0]?.decision.reason, "invalid_output");
    return true;
  });

  // bot.agent.failed diagnostics match Oracle requirements
  const failedLog = fixture.logs.find(
    (record) => record.event === "bot.agent.failed",
  );
  assert.ok(failedLog);
  assert.equal(failedLog.routingCode, "candidates_exhausted");
  assert.deepEqual(failedLog.routingAttemptReasons, ["invalid_output"]);
  assert.equal(failedLog.leafCode, "empty_final");
  // code is from ModelRoutingError itself (safeErrorCode prefers .code)
  assert.equal(failedLog.code, "candidates_exhausted");
  // Verify no prompt/body/content leaks
  assert.equal("text" in failedLog, false);
  assert.equal("prompt" in failedLog, false);
  assert.equal("body" in failedLog, false);
  assert.equal("content" in failedLog, false);
});

test("provider fallback keeps bounded carried tool data", async () => {
  const first = mockModel([
    toolResponse([
      toolCall("first-1", "rag_bm25_search", {
        query: "first-one",
      }),
      toolCall("first-2", "rag_bm25_search", {
        query: "first-two",
      }),
    ]),
    Object.assign(new Error("socket reset"), {
      code: "ECONNRESET",
    }) as never,
  ]);
  const second = mockModel([
    toolResponse([
      toolCall("second-1", "rag_bm25_search", {
        query: "second-one",
      }),
      toolCall("second-2", "rag_bm25_search", {
        query: "second-two",
      }),
      toolCall("second-3", "rag_bm25_search", {
        query: "second-three",
      }),
      toolCall("second-4", "rag_bm25_search", {
        query: "second-four",
      }),
      toolCall("second-5", "rag_bm25_search", {
        query: "second-denied",
      }),
    ]),
    response(
      [{ type: "text", text: "собранный финал" }],
      "stop",
    ),
  ]);
  const fixture = makeAgent([
    candidate("primary:unstable", first),
    candidate("backup:stable", second),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "собранный финал");
  assert.equal(fixture.searchCalls, 7);
  assert.match(
    JSON.stringify(second.doGenerateCalls[0]?.prompt),
    /Результат уже выполненного инструмента из предыдущего раунда/,
  );
  assert.match(
    JSON.stringify(second.doGenerateCalls[0]?.prompt),
    /first-one/,
  );
  assert.ok(second.doGenerateCalls[1]?.tools);
});

test("an external abort is terminal and never tries the backup provider", async () => {
  const first = new MockLanguageModelV4({
    doGenerate: async (options) =>
      await new Promise<LanguageModelV4GenerateResult>(
        (_resolve, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException(
                  "The operation was aborted",
                  "AbortError",
                ),
              ),
            { once: true },
          );
        },
      ),
  });
  const backup = mockModel([
    response(
      [{ type: "text", text: "не должен запуститься" }],
      "stop",
    ),
  ]);
  const fixture = makeAgent([
    candidate("primary:slow", first),
    candidate("backup:no", backup),
  ]);
  const controller = new AbortController();
  const running = fixture.agent.run(
    request({ signal: controller.signal }),
  );

  setImmediate(() => controller.abort());

  await assert.rejects(running, (error) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(first.doGenerateCalls.length, 1);
  assert.equal(backup.doGenerateCalls.length, 0);
});

test("a live-turn TimeoutError becomes a transport failure and falls back", async () => {
  const timeout = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new DOMException(
        "Step timeout of 100ms exceeded",
        "TimeoutError",
      );
    },
  });
  const backup = mockModel([
    response([{ type: "text", text: "таймаут пережит" }], "stop"),
  ]);
  const fixture = makeAgent([
    candidate("primary:timeout", timeout),
    candidate("backup:ok", backup),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "таймаут пережит");
  assert.equal(timeout.doGenerateCalls.length, 1);
  assert.equal(backup.doGenerateCalls.length, 1);
});
