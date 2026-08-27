import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPENAI_RESPONSES_MAINTENANCE_MODEL,
  OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
  ResponsesDigestTextRunner,
  ResponsesDreamRunner,
  type OpenAiResponsesMaintenanceClient,
  type ResponsesFunctionLoopRequest,
  type ResponsesTextRequest,
} from "../src/openai-responses/maintenance.js";
import { REVIEW_DYNAMIC_TOOLS } from "../src/dream/review-tools.js";
import { runDreamReview } from "../src/dream/review.js";
import { StagedKnowledgeOverlay } from "../src/dream/staged-knowledge.js";
import { DREAM_CHAT_ID, dreamFixtureStore } from "./support/dream.js";

test("maintenance adapters reject every client policy except Luna plus fast", () => {
  const wrongModel = fakeClient({ model: "gpt-5.6-sol" });
  assert.throws(() => new ResponsesDigestTextRunner(wrongModel), /gpt-5\.6-luna/u);
  const wrongTier = fakeClient({ serviceTier: "default" });
  assert.throws(() => new ResponsesDreamRunner(wrongTier), /fast/u);
});

test("digest direct Responses adapter forwards bounded text request and validates resolved Luna", async () => {
  let received: ResponsesTextRequest | undefined;
  const client = fakeClient({
    runText: async (request) => {
      received = request;
      return { text: "готовая сводка", model: OPENAI_RESPONSES_MAINTENANCE_MODEL, usage: { inputTokens: 3, outputTokens: 5 } };
    },
  });
  const runner = new ResponsesDigestTextRunner(client);
  const signal = new AbortController().signal;
  const result = await runner.runText({
    instructions: "digest instructions",
    prompt: "untrusted source",
    signal,
    timeoutMs: 12_345,
    maxOutputTokens: 321,
    outputSchema: { type: "object" },
  });

  assert.equal(received?.model, OPENAI_RESPONSES_MAINTENANCE_MODEL);
  assert.equal(received?.serviceTier, OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER);
  assert.equal(received?.timeoutMs, 12_345);
  assert.equal(received?.maxOutputTokens, 321);
  assert.deepEqual(received?.outputSchema, { type: "object" });
  assert.equal(result.providerId, "openai-responses");
  assert.equal(result.usage?.outputTokens, 5);
});

test("Dream adapter exposes exactly eight review functions and keeps failed attempt writes staged", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-responses-dream-");
  try {
    let calls = 0;
    const client = fakeClient({
      runFunctionLoop: async (request) => {
        calls += 1;
        assert.equal(request.model, OPENAI_RESPONSES_MAINTENANCE_MODEL);
        assert.equal(request.serviceTier, OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER);
        assert.equal(request.tools.length, 8);
        assert.deepEqual(request.tools.map((tool) => tool.type), Array(8).fill("function"));
        const output = await request.dispatch("review_remember_fast", {
          title: calls === 1 ? "discarded" : "kept",
          note: "attributed fact",
        });
        assert.deepEqual(output, {
          success: true,
          text: JSON.stringify({ ok: true, title: calls === 1 ? "discarded" : "kept" }),
        });
        return {
          text: calls === 1 ? "partial" : "valid replacement memory",
          model: OPENAI_RESPONSES_MAINTENANCE_MODEL,
          finishReason: calls === 1 ? "length" : "stop",
          toolCalls: 1,
        };
      },
    });
    const stage = new StagedKnowledgeOverlay(store, { now: () => 1_700_000_000_000 });
    const result = await runDreamReview({
      textRunner: new ResponsesDreamRunner(client),
      store: stage,
      chatId: DREAM_CHAT_ID,
      sourceMessageId: 2,
      sourceText: "interaction",
      candidateTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
    });

    assert.equal(result.final, "valid replacement memory");
    assert.equal(calls, 2);
    assert.deepEqual(stage.listFastChatMemory(DREAM_CHAT_ID).map((item) => item.title), ["kept"]);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
  } finally {
    cleanup();
  }
});

test("Dream direct Responses adapter rejects altered or non-review function surfaces", async () => {
  const runner = new ResponsesDreamRunner(fakeClient());
  await assert.rejects(
    runner.runText({
      instructions: "ignored",
      prompt: "ignored",
      dynamicTools: [{ ...REVIEW_DYNAMIC_TOOLS[0]!, description: "altered" }],
      dispatch: async () => "ignored",
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxOutputTokens: 512,
    }),
    /only REVIEW_DYNAMIC_TOOLS/u,
  );
});

function fakeClient(overrides: Partial<OpenAiResponsesMaintenanceClient> = {}): OpenAiResponsesMaintenanceClient {
  return {
    model: OPENAI_RESPONSES_MAINTENANCE_MODEL,
    serviceTier: OPENAI_RESPONSES_MAINTENANCE_SERVICE_TIER,
    runText: async () => ({ text: "text", model: OPENAI_RESPONSES_MAINTENANCE_MODEL }),
    runFunctionLoop: async (_request: ResponsesFunctionLoopRequest) => ({
      text: "text",
      model: OPENAI_RESPONSES_MAINTENANCE_MODEL,
      finishReason: "stop",
      toolCalls: 0,
    }),
    ...overrides,
  };
}
