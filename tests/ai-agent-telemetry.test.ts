import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidate,
  makeAgent,
  mockModel,
  request,
  response,
  toolCall,
  toolResponse,
} from "./support/ai-agent.js";

test("telemetry reports only the last step input against the declared window", async () => {
  const model = mockModel([
    toolResponse([
      toolCall("call-1", "rag_bm25_search", {
        query: "раз",
        limit: 1,
      }),
    ]),
    response([{ type: "text", text: "готово" }], "stop"),
  ]);
  const fixture = makeAgent([
    candidate("primary:test", model, undefined, {
      vision: false,
      contextWindowTokens: 1_000_000,
    }),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.telemetry.steps.length, 2);
  // Occupancy is the LAST step's provider input count, not a sum of steps.
  assert.equal(result.telemetry.contextUsedTokens, 10);
  assert.equal(result.telemetry.contextWindowTokens, 1_000_000);
  // Aggregate totals remain available for internal diagnostics.
  assert.equal(result.telemetry.totalInputTokens, 20);
  assert.equal(result.telemetry.totalOutputTokens, 10);
  assert.equal(result.telemetry.finalModelId, "mock-model-id");
  assert.equal(result.telemetry.finalProviderId, "primary");
});

test("fallback telemetry window comes from the successful final candidate", async () => {
  const failing = mockModel([
    Object.assign(new Error("socket reset"), {
      code: "ECONNRESET",
    }) as never,
  ]);
  const backup = mockModel([
    response([{ type: "text", text: "ответ запасной модели" }], "stop"),
  ]);
  const fixture = makeAgent([
    candidate("primary:down", failing, undefined, {
      vision: false,
      contextWindowTokens: 200_000,
    }),
    candidate("backup:up", backup, undefined, {
      vision: false,
      contextWindowTokens: 1_000_000,
    }),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "ответ запасной модели");
  assert.equal(result.telemetry.finalProviderId, "backup");
  assert.equal(result.telemetry.contextWindowTokens, 1_000_000);
  assert.equal(result.telemetry.contextUsedTokens, 10);
});

test("an undeclared candidate window stays unknown instead of guessed", async () => {
  const model = mockModel([
    response([{ type: "text", text: "ответ без манифеста" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:unknown", model)]);

  const result = await fixture.agent.run(request());

  assert.equal(result.telemetry.contextWindowTokens, undefined);
  assert.equal(result.telemetry.contextUsedTokens, 10);
});
