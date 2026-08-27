import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OpenAiResponsesMaintenanceClientAdapter,
  type OpenAiResponsesTurnPort,
} from "../src/openai-responses/maintenance-client.js";
import {
  OPENAI_RESPONSES_MAINTENANCE_MODEL,
  OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
} from "../src/openai-responses/maintenance.js";
import type { RunResponsesTurnRequest, RunResponsesTurnResult } from "../src/openai-responses/contracts.js";

test("maintenance text facade pins Luna/fast and disables every non-text tool surface", async () => {
  const received: RunResponsesTurnRequest[] = [];
  const client = new OpenAiResponsesMaintenanceClientAdapter(fakeTurn(received));
  const result = await client.runText({
    model: OPENAI_RESPONSES_MAINTENANCE_MODEL,
    serviceTier: OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
    instructions: "summarize precisely",
    input: "source text",
    signal: new AbortController().signal,
    timeoutMs: 12_000,
    maxOutputTokens: 321,
    outputSchema: { type: "object", additionalProperties: false },
  });

  assert.equal(client.model, "gpt-5.6-luna");
  assert.equal(client.serviceTier, "fast");
  assert.equal(received.length, 1);
  const request = received[0]!;
  assert.deepEqual(request.localFunctions, []);
  assert.equal(request.hostedWebSearch, false);
  assert.equal(request.effort, "medium");
  assert.equal("image" in request, false);
  assert.equal(request.timeoutMs, 12_000);
  assert.equal(request.maxOutputTokens, 321);
  assert.equal(request.maxFunctionCalls, 1);
  assert.deepEqual(request.textJsonSchema, {
    name: "maintenance_output",
    schema: { type: "object", additionalProperties: false },
    strict: true,
  });
  assert.deepEqual(result, {
    text: "completed text",
    model: "gpt-5.6-luna",
    providerId: "openai-responses",
    completed: true,
    usage: { inputTokens: 3, outputTokens: 5 },
  });
});

test("maintenance Dream facade maps strict-false schemas and bounds host dispatch", async () => {
  let dispatchResult: unknown;
  const turn: OpenAiResponsesTurnPort = {
    async run(request) {
      assert.equal(request.hostedWebSearch, false);
      assert.equal(request.effort, "medium");
      assert.equal(request.localFunctions.length, 1);
      assert.deepEqual(request.localFunctions[0], {
        type: "function",
        name: "review_memory",
        description: "Writes a staged review note.",
        parameters: { type: "object" },
        strict: false,
      });
      dispatchResult = await request.dispatcher.dispatch(
        { callId: "call_1", name: "review_memory", arguments: { title: "kept" } },
        new AbortController().signal,
      );
      const rejected = await request.dispatcher.dispatch(
        { callId: "call_2", name: "unlisted", arguments: {} },
        new AbortController().signal,
      );
      assert.deepEqual(rejected, { success: false, text: "Unknown maintenance function." });
      return completedResult({ functionCalls: 1 });
    },
  };
  const client = new OpenAiResponsesMaintenanceClientAdapter(turn);
  const result = await client.runFunctionLoop({
    model: OPENAI_RESPONSES_MAINTENANCE_MODEL,
    serviceTier: OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
    instructions: "review",
    input: "candidate",
    signal: new AbortController().signal,
    timeoutMs: 12_000,
    maxOutputTokens: 456,
    tools: [{ type: "function", name: "review_memory", description: "Writes a staged review note.", parameters: { type: "object" } }],
    dispatch: async (name, input) => ({ success: name === "review_memory", text: JSON.stringify(input) }),
  });

  assert.deepEqual(dispatchResult, { success: true, text: JSON.stringify({ title: "kept" }) });
  assert.equal(result.finishReason, "stop");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.providerId, "openai-responses");
});

test("maintenance function dispatcher turns oversized and thrown host outputs into bounded failures", async () => {
  const outcomes: unknown[] = [];
  const turn: OpenAiResponsesTurnPort = {
    async run(request) {
      outcomes.push(await request.dispatcher.dispatch({ callId: "long", name: "tool", arguments: {} }, new AbortController().signal));
      outcomes.push(await request.dispatcher.dispatch({ callId: "throws", name: "throws", arguments: {} }, new AbortController().signal));
      return completedResult({ functionCalls: 2 });
    },
  };
  const client = new OpenAiResponsesMaintenanceClientAdapter(turn);
  await client.runFunctionLoop({
    model: OPENAI_RESPONSES_MAINTENANCE_MODEL,
    serviceTier: OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
    instructions: "review",
    input: "candidate",
    signal: new AbortController().signal,
    timeoutMs: 12_000,
    maxOutputTokens: 456,
    tools: [
      { type: "function", name: "tool", description: "long", parameters: {} },
      { type: "function", name: "throws", description: "throws", parameters: {} },
    ],
    dispatch: async (name) => {
      if (name === "throws") throw new Error("host failed");
      return { success: true, text: "x".repeat(200_001) };
    },
  });

  assert.deepEqual(outcomes, [
    { success: false, text: "Maintenance function result is too large." },
    { success: false, text: "Maintenance function failed." },
  ]);
});

function fakeTurn(received: RunResponsesTurnRequest[]): OpenAiResponsesTurnPort {
  return { async run(request) { received.push(request); return completedResult(); } };
}

function completedResult(overrides: Partial<RunResponsesTurnResult> = {}): RunResponsesTurnResult {
  return {
    responseId: "resp_1",
    model: "gpt-5.6-luna",
    serviceTier: "priority",
    text: "completed text",
    annotations: [],
    functionCalls: 0,
    hostedWebCalls: 0,
    completed: true,
    finishStatus: "completed",
    usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 8 },
    ...overrides,
  };
}
