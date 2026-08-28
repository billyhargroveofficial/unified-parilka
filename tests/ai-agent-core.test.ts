import assert from "node:assert/strict";
import { test } from "node:test";
import { BotAgentProtocolError } from "../src/bot/ai-agent.js";
import { BotMemoryTools } from "../src/bot/memory-tools.js";
import type { ToolProgressPort } from "../src/bot/tool-progress.js";
import { MessageStore } from "../src/store.js";
import {
  candidate,
  emptyFold,
  makeAgent,
  mockModel,
  promptUserText,
  request,
  response,
  storedMessage,
  toolCall,
  toolResponse,
} from "./support/ai-agent.js";

test("returns only the final step text, never reasoning or an intermediate draft", async () => {
  const model = mockModel([
    response(
      [
        { type: "reasoning", text: "PRIVATE_CHAIN_OF_THOUGHT" },
        { type: "text", text: "безопасный финальный ответ" },
      ],
      "stop",
    ),
  ]);
  const providerOptions = {
    deepseek: { thinking: { type: "disabled" as const } },
  };
  const fixture = makeAgent([
    candidate("primary:test", model, providerOptions),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "безопасный финальный ответ");
  assert.doesNotMatch(result.text, /PRIVATE_CHAIN_OF_THOUGHT/);
  assert.equal("evidence" in result, false);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.deepEqual(
    model.doGenerateCalls[0]?.providerOptions,
    providerOptions,
  );
  assert.match(
    promptUserText(model.doGenerateCalls[0]),
    /"target":true/,
  );
});

test("a length-limited final gets one tool-free recovery pass", async () => {
  const model = mockModel([
    response([{ type: "text", text: "обрезанный черновик" }], "length"),
    response([{ type: "text", text: "полный финальный ответ" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "полный финальный ответ");
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(model.doGenerateCalls[0]?.maxOutputTokens, 16_384);
  assert.equal(model.doGenerateCalls[1]?.tools, undefined);
  assert.deepEqual(model.doGenerateCalls[1]?.toolChoice, { type: "none" });
});

test("executes a read tool and wraps its output as untrusted data without attaching quote evidence to the final", async () => {
  const exactQuote = "эта реплика действительно была в истории";
  const model = mockModel([
    toolResponse([
      toolCall("call-search", "rag_bm25_search", {
        query: "реплика",
        limit: 1,
      }),
    ]),
    response(
      [
        {
          type: "text",
          text: `Коля: «${exactQuote}»`,
        },
      ],
      "stop",
    ),
  ]);
  const fixture = makeAgent(
    [candidate("primary:test", model)],
    {
      searchResults: [
        storedMessage(77, exactQuote, "42", "Коля"),
      ],
    },
  );

  const result = await fixture.agent.run(request());

  assert.equal(fixture.searchCalls, 1);
  assert.equal("evidence" in result, false);
  assert.equal(model.doGenerateCalls.length, 2);
  const secondPrompt = JSON.stringify(
    model.doGenerateCalls[1]?.prompt,
  );
  assert.match(secondPrompt, /<ДАННЫЕ_fixed_nonce_1234/);
  assert.match(secondPrompt, /chat_message/);
});

test("compacts an oversized context through the selected model", async () => {
  const model = mockModel([
    toolResponse([
      toolCall("compact-trigger", "rag_bm25_search", {
        query: "compact-trigger",
        limit: 1,
      }),
    ]),
    response([{ type: "text", text: "сводка старого контекста" }], "stop"),
    response([{ type: "text", text: "финал после автокомпакта" }], "stop"),
  ]);
  const providerOptions = {
    openai: { reasoningEffort: "max" as const },
  };
  const fixture = makeAgent(
    [candidate("primary:test", model, providerOptions)],
    {
      searchResults: [
        storedMessage(78, "доказательство ".repeat(600), "42", "Коля"),
      ],
    },
  );
  const oldContext = `fold-start ${"доказательство ".repeat(140_000)} fold-end`;
  let foldInjected = false;

  const result = await fixture.agent.run(
    request({
      trigger: storedMessage(103, "сожми длинный контекст", "42", "Коля"),
      drainFold: (boundary) => {
        if (boundary !== "tool" || foldInjected) {
          return emptyFold(boundary);
        }
        foldInjected = true;
        const message = {
          messageId: "oversized-fold",
          senderId: "42",
          senderName: "Коля",
          text: oldContext,
          watermark: 104,
          route: "ambient" as const,
          truncated: false,
        };
        return {
          ...emptyFold(boundary),
          messages: [message],
          ambient: [message],
          totalChars: oldContext.length,
        };
      },
    }),
  );

  assert.equal(result.text, "финал после автокомпакта");
  assert.equal(fixture.searchCalls, 1);
  assert.equal(model.doGenerateCalls.length, 3);
  assert.deepEqual(model.doGenerateCalls[1]?.providerOptions, providerOptions);
  const compactionPrompt = promptUserText(model.doGenerateCalls[1]);
  assert.match(compactionPrompt, /<old_context>/u);
  assert.match(compactionPrompt, /fold-start/u);
  assert.match(compactionPrompt, /fold-end/u);
  assert.match(
    compactionPrompt,
    /middle of old context omitted; recent tail follows/u,
  );
  assert.match(promptUserText(model.doGenerateCalls[2]), /<compacted_context>/u);
  const compacted = fixture.logs.find(
    (record) => record.event === "bot.agent.context_compacted",
  );
  assert.ok(compacted);
  assert.ok(Number(compacted.beforeTokens) >= 600_000);
});

test("reports safe thinking boundaries around model and tool steps", async () => {
  const model = mockModel([
    toolResponse([
      toolCall("call-search", "rag_bm25_search", { query: "реплика", limit: 1 }),
    ]),
    response([{ type: "text", text: "готово" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);
  const events: string[] = [];
  const progress: ToolProgressPort = {
    onThinkingStarted: () => { events.push("thinking:start"); },
    onThinkingCompleted: (_event, ok) => { events.push(`thinking:${ok ? "ok" : "error"}`); },
    onToolStarted: (event) => { events.push(`tool:start:${event.toolName}`); },
    onToolCompleted: (event, ok) => { events.push(`tool:${ok ? "ok" : "error"}:${event.toolName}`); },
  };

  const result = await fixture.agent.run(request({ toolProgressPort: progress }));

  assert.equal(result.text, "готово");
  assert.deepEqual(events, [
    "thinking:start",
    "thinking:ok",
    "tool:start:rag_bm25_search",
    "tool:ok:rag_bm25_search",
    "thinking:start",
    "thinking:ok",
  ]);
});

test("seven parallel requests execute without a shared count ceiling", async () => {
  const calls = Array.from({ length: 7 }, (_, index) =>
    toolCall(`parallel-${index}`, "rag_bm25_search", {
      query: `query-${index}`,
      limit: 1,
    }),
  );
  const model = mockModel([
    toolResponse(calls),
    response(
      [{ type: "text", text: "финал после лимита" }],
      "stop",
    ),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);
  let toolDrains = 0;

  const result = await fixture.agent.run(
    request({
      drainFold: (boundary) => {
        if (boundary === "tool") {
          toolDrains += 1;
        }
        return emptyFold(boundary);
      },
    }),
  );

  assert.equal(result.text, "финал после лимита");
  assert.equal(fixture.searchCalls, 7);
  assert.equal(model.doGenerateCalls.length, 2);
  assert.ok(model.doGenerateCalls[1]?.tools);
  assert.deepEqual(model.doGenerateCalls[1]?.toolChoice, { type: "auto" });
  const completed = fixture.logs.find(
    (record) => record.event === "bot.agent.complete",
  );
  assert.equal(completed?.requestedToolCalls, 7);
  assert.equal(completed?.allowedToolCalls, 7);
  assert.equal(completed?.startedToolCalls, 7);
  assert.equal(completed?.completedToolCalls, 7);
  assert.equal(completed?.deniedToolCalls, 0);
  assert.equal(completed?.turnId, 1);
  assert.equal(completed?.updateId, 2);
  assert.equal(
    fixture.logs.every(
      (record) =>
        record.turnId === 1 &&
        record.updateId === 2,
    ),
    true,
  );
  assert.equal(toolDrains, 7);
});

test("research depth gate retries a premature final through Qwen-compatible auto tool choice", async () => {
  const model = mockModel([
    toolResponse([
      toolCall("scan", "rag_bm25_search", { query: "topic", limit: 1 }),
      toolCall("drill", "rag_bm25_search", { query: "topic context", limit: 1 }),
    ]),
    response([{ type: "text", text: "слишком ранний итог" }], "stop"),
    toolResponse([
      toolCall("audit", "rag_bm25_search", { query: "topic counterpoint", limit: 1 }),
      toolCall("source", "rag_bm25_search", { query: "topic primary source", limit: 1 }),
    ]),
    response([{ type: "text", text: "проверенный итог" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);

  const result = await fixture.agent.run(
    request({
      trigger: storedMessage(
        100,
        "исследуй тему нормально, а не по верхам",
        "42",
        "Коля",
      ),
    }),
  );

  assert.equal(result.text, "проверенный итог");
  assert.equal(fixture.searchCalls, 4);
  assert.equal(model.doGenerateCalls.length, 4);
  for (const call of model.doGenerateCalls) {
    assert.deepEqual(call.toolChoice, { type: "auto" });
  }
  assert.match(
    promptUserText(model.doGenerateCalls[2]),
    /Результат уже выполненного инструмента из предыдущего раунда работы/,
  );
  const retried = fixture.logs.find(
    (record) => record.event === "bot.agent.research_depth_retry",
  );
  assert.equal(retried?.requiredReadToolCalls, 4);
  assert.equal(retried?.startedReadToolCalls, 2);
  const completed = fixture.logs.find(
    (record) => record.event === "bot.agent.complete",
  );
  assert.equal(completed?.researchMode, "research");
  assert.equal(completed?.startedReadToolCalls, 4);
  assert.equal(completed?.researchQualityRetries, 1);
});

test("research requests can execute forty tool calls", async () => {
  const calls = Array.from({ length: 40 }, (_, index) =>
    toolCall(`research-${index}`, "rag_bm25_search", {
      query: `research-${index}`,
      limit: 1,
    }),
  );
  const model = mockModel([
    toolResponse(calls),
    response([{ type: "text", text: "глубокий итог" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);

  const result = await fixture.agent.run(
    request({
      trigger: storedMessage(
        101,
        "исследуй тему без поверхностного ответа",
        "42",
        "Коля",
      ),
    }),
  );

  assert.equal(result.text, "глубокий итог");
  assert.equal(fixture.searchCalls, 40);
  const completed = fixture.logs.find(
    (record) => record.event === "bot.agent.complete",
  );
  assert.equal(completed?.researchMode, "research");
  assert.equal(completed?.allowedToolCalls, 40);
  assert.equal(completed?.deniedToolCalls, 0);
});

test("tool execution count has no fixed ceiling", async () => {
  const calls = Array.from({ length: 121 }, (_, index) =>
    toolCall(`capped-${index}`, "rag_bm25_search", {
      query: `capped-${index}`,
      limit: 1,
    }),
  );
  const model = mockModel([
    toolResponse(calls),
    response([{ type: "text", text: "финал после safety ceiling" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);

  const result = await fixture.agent.run(
    request({
      trigger: storedMessage(
        102,
        "исследуй тему с большим числом вызовов",
        "42",
        "Коля",
      ),
    }),
  );

  assert.equal(result.text, "финал после safety ceiling");
  assert.equal(fixture.searchCalls, 121);
  assert.equal(model.doGenerateCalls.length, 2);
  assert.notDeepEqual(model.doGenerateCalls[1]?.toolChoice, { type: "none" });
  const completed = fixture.logs.find(
    (record) => record.event === "bot.agent.complete",
  );
  assert.equal(completed?.requestedToolCalls, 121);
  assert.equal(completed?.allowedToolCalls, 121);
  assert.equal(completed?.startedToolCalls, 121);
  assert.equal(completed?.deniedToolCalls, 0);
  const guard = fixture.logs.find(
    (record) => record.event === "bot.agent.finalization_guard",
  );
  assert.equal(guard, undefined);
});

test("malformed tool-call steps do not hit an arbitrary step ceiling", async () => {
  const malformed = Array.from({ length: 4 }, (_, index) =>
    toolResponse([
      {
        type: "tool-call" as const,
        toolCallId: `malformed-${index}`,
        toolName: "rag_bm25_search",
        input: '{"query":',
      },
    ]),
  );
  const model = mockModel([
    ...malformed,
    response([{ type: "text", text: "финал после исправления" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "финал после исправления");
  assert.equal(model.doGenerateCalls.length, 5);
  assert.equal(fixture.searchCalls, 0);
});

test("memory write tools require a direct request from an authorized sender", async () => {
  const store = new MessageStore(":memory:");
  try {
    const memoryTools = new BotMemoryTools({
      store,
      writeAuthorizerIds: ["42", "84"],
    });
    const directModel = mockModel([
      toolResponse([
        toolCall("skill", "save_chat_skill", {
          name: "release",
          description: "Безопасный релизный playbook",
          instructions: "1. Прогони тесты.\n2. Проверь smoke.\n3. Деплой.",
        }),
      ]),
      response([{ type: "text", text: "сохранил навык release" }], "stop"),
    ]);
    const directFixture = makeAgent(
      [candidate("primary:test", directModel)],
      { memoryTools },
    );

    await directFixture.agent.run(
      request({
        trigger: storedMessage(
          100,
          "@bichiycepenstotri_bot запиши",
          "42",
          "Коля",
        ),
      }),
    );
    const directOffered = (directModel.doGenerateCalls[0]?.tools ?? [])
      .filter((t) => t.type === "function")
      .map((t) => t.name);
    assert.equal(directOffered.includes("save_chat_skill"), true);
    assert.equal(directOffered.includes("remember_fast"), true);
    assert.equal(directOffered.includes("remember_lesson"), true);
    const skills = store.listChatSkills("-1004242");
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "release");
    assert.equal(directModel.doGenerateCalls.length, 2);

    const untrustedModel = mockModel([
      response([{ type: "text", text: "не могу писать память" }], "stop"),
    ]);
    const untrustedFixture = makeAgent(
      [candidate("primary:test", untrustedModel)],
      { memoryTools },
    );
    await untrustedFixture.agent.run(
      request({
        trigger: storedMessage(
          101,
          "@bichiycepenstotri_bot запиши",
          "43",
          "Не владелец",
        ),
      }),
    );
    assert.equal(untrustedModel.doGenerateCalls.length, 1);
    const offeredToolNames = (untrustedModel.doGenerateCalls[0]?.tools ?? [])
      .filter((tool) => tool.type === "function")
      .map((tool) => tool.name);
    assert.equal(offeredToolNames.includes("remember_fast"), false);
    assert.equal(offeredToolNames.includes("remember_lesson"), false);
    assert.equal(offeredToolNames.includes("save_chat_skill"), false);
    assert.equal(offeredToolNames.includes("search_long_memory"), true);
    assert.equal(offeredToolNames.includes("load_chat_skill"), true);
    assert.equal(store.listChatSkills("-1004242").length, 1);
  } finally {
    store.close();
  }
});