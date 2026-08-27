import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesBotTurnAgent } from "../src/bot-daemon/responses-agent.js";
import type { BotAgentRequest } from "../src/bot/agent-contract.js";
import type { CausalRagPacket } from "../src/bot/causal-rag/index.js";
import { ResponsesTurnTimeoutError } from "../src/openai-responses/index.js";
import { makeFixture, message } from "./support/bot-worker.js";

test("typed Responses timeout becomes one host-owned final with observed tool count", async () => {
  let calls = 0;
  const agent = makeAgent({
    async run(request) {
      calls += 1;
      await request.progress?.onProgress({
        type: "hosted_web_started", callId: "web-1", action: "search", batchSize: 4,
      });
      await request.progress?.onProgress({
        type: "hosted_web_completed", callId: "web-1", ok: true,
      });
      await request.progress?.onProgress({
        type: "local_function_started", callId: "local-1", name: "keyword_search", arguments: {},
      });
      throw new ResponsesTurnTimeoutError(180_000);
    },
  });

  const result = await agent.run(agentRequest());

  assert.equal(calls, 1);
  assert.match(result.text, /Не успел закончить ответ за отведённое время/u);
  assert.match(result.text, /GPT-5\.6 Luna Fast xhigh · ctx \?\/272k · tools 2 ·/u);
  assert.equal(result.telemetry.toolCalls, 2);
  assert.equal(result.telemetry.incomplete, true);
  assert.deepEqual(result.telemetry.steps, []);
});

test("timeout fallback publishes once and leaves no model retry for the durable turn", async (t) => {
  const fixture = makeFixture(t);
  let modelCalls = 0;
  let published = "";
  const agent = makeAgent({
    async run() {
      modelCalls += 1;
      throw new ResponsesTurnTimeoutError(180_000);
    },
  });
  const worker = fixture.worker({
    agent: (request) => agent.run(request),
    publisher: async ({ publication }) => {
      published = publication.plainText;
      return { ok: true, chunksSent: 1, telegramMessageId: 88 };
    },
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "sent", turnId: fixture.turnId, telegramMessageId: 88,
  });
  assert.match(published, /Не успел закончить ответ/u);
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "sent");
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.attempts, 1);
  assert.equal((await worker.runOnce()).status, "idle");
  assert.equal(modelCalls, 1);
});

test("concurrent owner abort and non-timeout Responses failures still propagate", async () => {
  const cancelled = new AbortController();
  const timeout = new ResponsesTurnTimeoutError(180_000);
  const timeoutAgent = makeAgent({ async run() {
    cancelled.abort();
    throw timeout;
  } });
  await assert.rejects(timeoutAgent.run(agentRequest({ signal: cancelled.signal })),
    (error: unknown) => error === timeout);

  const other = new Error("provider rejected request");
  const otherAgent = makeAgent({ async run() { throw other; } });
  await assert.rejects(otherAgent.run(agentRequest()),
    (error: unknown) => error === other);
});

function makeAgent(responses: ConstructorParameters<typeof ResponsesBotTurnAgent>[0]["responses"]): ResponsesBotTurnAgent {
  return new ResponsesBotTurnAgent({
    responses,
    causalRag: { async build() { return packet(); } },
    media: { async resolveImages() { return []; } },
    readTools: { async callTool() { throw new Error("not called"); } },
    now: () => new Date("2026-08-27T20:38:02.000Z"),
    nonceFactory: () => "timeout_test_nonce",
  });
}

function agentRequest(overrides: Partial<BotAgentRequest> = {}): BotAgentRequest {
  return {
    turn: { id: 1, chatId: "-100123", triggerMessageId: 77 } as BotAgentRequest["turn"],
    trigger: message(77, "проверь поиск", "Билли"),
    context: [],
    signal: new AbortController().signal,
    drainFold: () => ({} as never),
    ...overrides,
  };
}

function packet(): CausalRagPacket {
  return {
    packet: "", sources: [], historyAttempted: false, historyDegraded: false,
    digestAttempted: false, digestDegraded: false,
  };
}
