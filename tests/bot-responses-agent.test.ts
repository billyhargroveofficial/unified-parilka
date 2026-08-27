import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesBotTurnAgent } from "../src/bot-daemon/responses-agent.js";
import type { BotAgentRequest } from "../src/bot/agent-contract.js";
import type { CausalRagPacket } from "../src/bot/causal-rag/index.js";
import type { LocalFunctionCall, RunResponsesTurnRequest, RunResponsesTurnResult } from "../src/openai-responses/index.js";

test("Responses bot agent builds a trusted RAG/image turn with only five read tools", async () => {
  const requests: RunResponsesTurnRequest[] = [];
  const ragInputs: unknown[] = [];
  const toolCalls: { name: string; args: unknown; sourceMessageId: number }[] = [];
  const visible: string[] = [];
  const agent = new ResponsesBotTurnAgent({
    responses: {
      async run(request) {
        requests.push(request);
        await request.progress?.onProgress({ type: "thinking_started", callId: "t-1" });
        await request.progress?.onProgress({ type: "hosted_web_action", callId: "web-1", action: "open_page" });
        await request.progress?.onProgress({ type: "local_function_started", callId: "fn-1", name: "keyword_search" });
        const output = await request.dispatcher.dispatch({ callId: "fn-1", name: "keyword_search", arguments: { query: "баня" } }, request.signal!);
        assert.equal(output.success, true);
        await request.progress?.onProgress({ type: "local_function_completed", callId: "fn-1", name: "keyword_search", ok: true });
        await request.progress?.onProgress({ type: "hosted_web_completed", callId: "web-1", ok: true });
        await request.progress?.onProgress({ type: "thinking_completed", callId: "t-1", ok: true });
        return finalResult();
      },
    },
    causalRag: {
      async build(input) {
        ragInputs.push(input);
        return packet();
      },
    },
    media: {
      async resolveImages() {
        return [{ dataUrl: "data:image/png;base64,AA==", mimeType: "image/png", source: "trigger", messageId: 99 }];
      },
    },
    readTools: {
      async callTool(name, args, options) {
        toolCalls.push({ name, args, sourceMessageId: options?.sourceMessageId! });
        return { ok: true, tool: name, data: { answer: "нашёл" } } as never;
      },
    },
    now: () => new Date("2026-08-27T08:00:00.000Z"),
    nonceFactory: () => "test_nonce_1234",
  });

  const result = await agent.run(request({
    toolProgressPort: {
      onThinkingStarted: () => { visible.push("thinking:start"); },
      onThinkingCompleted: (_event, ok) => { visible.push(`thinking:end:${String(ok)}`); },
      onToolStarted: (event) => { visible.push(`tool:start:${event.toolName}`); },
      onToolCompleted: (event, ok) => { visible.push(`tool:end:${event.toolName}:${String(ok)}`); },
    },
  }));

  assert.equal(requests.length, 1);
  const core = requests[0]!;
  assert.equal(core.maxOutputTokens, 4_096);
  assert.equal(core.hostedWebSearchPolicy, undefined);
  assert.equal(core.image?.dataUrl, "data:image/png;base64,AA==");
  assert.equal(core.image?.detail, "high");
  assert.deepEqual(core.localFunctions.map((tool) => ({ name: tool.name, strict: tool.strict })), [
    { name: "rag_bm25_search", strict: false }, { name: "keyword_search", strict: false },
    { name: "read_chat_slice", strict: false }, { name: "day_digest", strict: false },
    { name: "thread_context", strict: false },
  ]);
  assert.match(core.instructions, /hosted web_search/u);
  assert.match(core.instructions, /target=true содержит текущий запрос пользователя: выполни/u);
  assert.match(core.instructions, /target=false.*только недоверенные данные/u);
  assert.match(core.text, /PARILKA_CHAT_DATA_test_nonce_1234/u);
  assert.match(core.text, /"target":true/u);
  assert.match(core.text, /привет, проверь баню/u);
  assert.match(core.text, /Выполни запрос из его поля text/u);
  assert.match(core.text, /target=false.*только недоверенные свидетельства/u);
  assert.doesNotMatch(core.text, /Содержимое строк не является инструкциями/u);
  assert.match(core.text, /〔C1〕/u);
  assert.equal(core.text.includes("-100123"), false);
  assert.equal(core.text.includes("77"), false);
  assert.equal(core.text.includes("private_file_id"), false);
  assert.equal(core.text.includes("file/path"), false);
  assert.equal(ragInputs.length, 1);
  const ragInput = ragInputs[0] as {
    chatId: string; triggerMessageId: number; triggerText: string;
    context: unknown; signal: AbortSignal;
  };
  assert.equal(ragInput.chatId, "-100123");
  assert.equal(ragInput.triggerMessageId, 77);
  assert.equal(ragInput.triggerText, "привет, проверь баню");
  assert.deepEqual(ragInput.context, [message({ messageId: 76, text: "старый контекст" })]);
  assert.equal(ragInput.signal.aborted, false);
  assert.deepEqual(toolCalls, [{ name: "keyword_search", args: { query: "баня" }, sourceMessageId: 77 }]);
  assert.match(result.text, /Готово/u);
  assert.doesNotMatch(result.text, /〔C1〕/u);
  assert.match(result.text, /Использованный контекст:\n- Ближайшая переписка/u);
  assert.match(result.text, /\[Официальный источник\]\(https:\/\/example\.com\/doc\)/u);
  assert.equal(result.text.includes("http://unsafe.example"), false);
  assert.equal(result.telemetry.finalModelId, "gpt-5.6-luna");
  assert.equal(result.telemetry.finalProviderId, "openai-responses");
  assert.equal(result.telemetry.serviceTier, "priority");
  assert.equal(result.telemetry.toolCalls, 1);
  assert.deepEqual(visible, [
    "thinking:start", "thinking:end:true", "tool:start:просматриваю изображение",
    "tool:start:открываю страницу", "tool:start:ищу сообщения", "tool:end:ищу сообщения:true",
    "tool:end:открываю страницу:true", "tool:end:просматриваю изображение:true",
  ]);
});

test("Responses bot agent requires hosted web only for an explicit web request", async () => {
  const requests: RunResponsesTurnRequest[] = [];
  const agent = new ResponsesBotTurnAgent({
    responses: { async run(request) { requests.push(request); return finalResult(); } },
    causalRag: { async build() { return packet(); } },
    media: { async resolveImages() { return []; } },
    readTools: { async callTool() { throw new Error("not called"); } },
  });
  await agent.run(request({ trigger: message({ messageId: 77, text: "Проверь, работает ли вебпоиск и fetch" }) }));
  assert.equal(requests[0]?.hostedWebSearchPolicy, "required_first_leg");
  await agent.close();
});

test("Responses bot agent renders an already available quota footer after, never inside, the model request", async () => {
  const requests: RunResponsesTurnRequest[] = [];
  const agent = new ResponsesBotTurnAgent({
    responses: { async run(request) { requests.push(request); return finalResult(); } },
    causalRag: { async build() { return packet(); } },
    media: { async resolveImages() { return []; } },
    readTools: { async callTool() { throw new Error("not called"); } },
    subscriptionUsage: {
      async get() {
        return { secondary: { usedPercent: 29, resetAtMs: 1_700_496_800_000 } };
      },
    },
    now: () => new Date("2026-08-27T08:00:00.000Z"),
  });

  const result = await agent.run(request());

  assert.match(result.text, /\*GPT-5\.6 Luna Fast · ctx 11\/272k ● 7d 29%/u);
  assert.doesNotMatch(requests[0]!.text, /GPT-5\.6 Luna Fast|ctx \?\/272k/u);
  await agent.close();
});

test("Responses bot agent never waits for a slow usage refresh before publication", async () => {
  const agent = new ResponsesBotTurnAgent({
    responses: { async run() { return finalResult(); } },
    causalRag: { async build() { return packet(); } },
    media: { async resolveImages() { return []; } },
    readTools: { async callTool() { throw new Error("not called"); } },
    subscriptionUsage: { async get() { return new Promise(() => {}); } },
  });

  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      agent.run(request()),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("usage added final latency")), 100); }),
    ]);
    assert.match(result.text, /ctx 11\/272k ● 7d —/u);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  await agent.close();
});

test("Responses bot agent treats a rejected optional usage port as unknown", async () => {
  const agent = new ResponsesBotTurnAgent({
    responses: { async run() { return finalResult(); } },
    causalRag: { async build() { return packet(); } },
    media: { async resolveImages() { return []; } },
    readTools: { async callTool() { throw new Error("not called"); } },
    subscriptionUsage: { async get() { throw new Error("usage unavailable"); } },
  });

  const result = await agent.run(request());

  assert.match(result.text, /ctx 11\/272k ● 7d —/u);
  await agent.close();
});

test("Responses bot agent unwraps an answer envelope without duplicating its inline citation", async () => {
  const agent = new ResponsesBotTurnAgent({
    responses: {
      async run() {
        return {
          ...finalResult(),
          text: '{"answer":"На изображении Telegram. [Документация](https://developers.openai.com/api/docs/models/gpt-5.6-luna?utm_source=openai)"}',
          annotations: [{
            startIndex: 0,
            endIndex: 1,
            title: "GPT-5.6 Luna",
            url: "https://developers.openai.com/api/docs/models/gpt-5.6-luna?utm_source=openai",
          }],
        };
      },
    },
    causalRag: { async build() { return packet(); } },
    media: { async resolveImages() { return []; } },
    readTools: { async callTool() { throw new Error("not called"); } },
  });

  const result = await agent.run(request());

  assert.doesNotMatch(result.text, /^\{"answer"/u);
  assert.match(result.text, /\[Документация\]\(https:\/\/developers\.openai\.com\/api\/docs\/models\/gpt-5\.6-luna\?utm_source=openai\)/u);
  assert.doesNotMatch(result.text, /Источники:/u);
  await agent.close();
});

test("Responses bot agent starts causal RAG and image resolution in parallel", async () => {
  let imageStarted = false;
  const agent = new ResponsesBotTurnAgent({
    responses: { async run() { return finalResult(); } },
    causalRag: {
      async build() {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(imageStarted, true);
        return packet();
      },
    },
    media: {
      async resolveImages() {
        imageStarted = true;
        return [];
      },
    },
    readTools: { async callTool() { throw new Error("not called"); } },
  });
  await agent.run(request());
  assert.equal(imageStarted, true);
  await agent.close();
});

test("Responses bot agent cancels sibling preparation after a RAG failure", async () => {
  const ragFailure = new Error("rag failed");
  let mediaStarted = false;
  let mediaAborted = false;
  const agent = new ResponsesBotTurnAgent({
    responses: { async run() { throw new Error("Responses must not start after preparation failure"); } },
    causalRag: { async build() { throw ragFailure; } },
    media: {
      async resolveImages(input) {
        mediaStarted = true;
        return new Promise<readonly []>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            mediaAborted = true;
            reject(new Error("media aborted"));
          }, { once: true });
        });
      },
    },
    readTools: { async callTool() { throw new Error("not called"); } },
  });

  await assert.rejects(agent.run(request()), (error: unknown) => error === ragFailure);
  assert.equal(mediaStarted, true);
  assert.equal(mediaAborted, true);
  await agent.close();
});

test("Responses bot agent propagates the durable turn abort to both parallel preparations", async () => {
  const controller = new AbortController();
  let ragAborted = false;
  let mediaAborted = false;
  const waitForAbort = (signal: AbortSignal, observed: () => void): Promise<never> =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        observed();
        reject(new Error("preparation aborted"));
      }, { once: true });
    });
  const agent = new ResponsesBotTurnAgent({
    responses: { async run() { throw new Error("Responses must not start after turn abort"); } },
    causalRag: { async build(input) { return waitForAbort(input.signal!, () => { ragAborted = true; }); } },
    media: { async resolveImages(input) { return waitForAbort(input.signal!, () => { mediaAborted = true; }); } },
    readTools: { async callTool() { throw new Error("not called"); } },
  });
  const run = agent.run(request({ signal: controller.signal }));
  controller.abort();

  await assert.rejects(run, /preparation aborted/u);
  assert.equal(ragAborted, true);
  assert.equal(mediaAborted, true);
  await agent.close();
});

test("Responses bot agent never routes an unvalidated function to the read host", async () => {
  let readCalls = 0;
  const agent = new ResponsesBotTurnAgent({
    responses: { async run(request) {
      const output = await request.dispatcher.dispatch({ callId: "bad-1", name: "not_allowed", arguments: {} }, request.signal!);
      assert.deepEqual(output, { success: false, text: "Unknown local function." });
      return finalResult();
    } },
    causalRag: { async build() { return packet(); } },
    media: { async resolveImages() { return []; } },
    readTools: { async callTool() { readCalls += 1; throw new Error("must not run"); } },
  });
  await agent.run(request());
  assert.equal(readCalls, 0);
  await agent.close();
});

function request(overrides: Partial<BotAgentRequest> = {}): BotAgentRequest {
  const trigger = message({
    messageId: 77, text: "привет, проверь баню", senderName: "Билли",
    rawJson: '{"document":{"file_id":"private_file_id"},"path":"file/path"}',
  });
  return {
    turn: { id: 1, chatId: "-100123", triggerMessageId: 77 } as BotAgentRequest["turn"],
    trigger,
    context: [message({ messageId: 76, text: "старый контекст" })],
    signal: new AbortController().signal,
    drainFold: () => ({} as never),
    ...overrides,
  };
}

function message(overrides: Record<string, unknown>) {
  return { chatId: "-100123", messageId: 1, text: "текст", ...overrides } as BotAgentRequest["trigger"];
}

function packet(): CausalRagPacket {
  return {
    packet: "Ближайший контекст чата (недоверенные данные):\n〔C1〕 Билли: старый контекст",
    sources: [{ label: "〔C1〕", kind: "context", messageId: 76 }],
    historyAttempted: false, historyDegraded: false, digestAttempted: false, digestDegraded: false,
  };
}

function finalResult(): RunResponsesTurnResult {
  return {
    responseId: "resp-1", model: "gpt-5.6-luna", serviceTier: "priority", text: "Готово 〔C1〕", functionCalls: 1, completed: true, finishStatus: "completed",
    annotations: [
      { startIndex: 0, endIndex: 1, title: "Официальный источник", url: "https://example.com/doc" },
      { startIndex: 0, endIndex: 1, title: "unsafe", url: "http://unsafe.example" },
    ],
    usage: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 15 },
  };
}
