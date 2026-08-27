import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import {
  OpenAiResponsesTurnClient,
  ResponsesTurnCancelledError,
  ResponsesTurnError,
  type ResponsesCreateRequest,
  type ResponsesStreamTransport,
} from "../src/openai-responses/index.js";

class FakeResponses implements ResponsesStreamTransport {
  readonly requests: ResponsesCreateRequest[] = [];
  readonly signals: AbortSignal[] = [];
  #streams: AsyncIterable<ResponseStreamEvent>[];

  constructor(...streams: AsyncIterable<ResponseStreamEvent>[]) {
    this.#streams = streams;
  }

  async create(request: ResponsesCreateRequest, options: { signal: AbortSignal }): Promise<AsyncIterable<ResponseStreamEvent>> {
    this.requests.push(request);
    this.signals.push(options.signal);
    const next = this.#streams.shift();
    if (!next) throw new Error("unexpected create");
    return next;
  }
}

test("Responses core sends the hard-pinned hosted web contract and exposes citations/progress", async () => {
  const transport = new FakeResponses(events(
    web("response.web_search_call.in_progress", "web-1"),
    webItem("response.output_item.added", "web-1", "open_page", "in_progress"),
    web("response.web_search_call.searching", "web-1"),
    web("response.web_search_call.completed", "web-1"),
    completed(response("resp-final", "Проверил источник [1]", [{
      type: "url_citation", start_index: 18, end_index: 21, title: "Node.js", url: "https://nodejs.org",
    }])),
  ));
  const progress: { type: string; action?: string }[] = [];
  const result = await new OpenAiResponsesTurnClient(transport).run({
    text: "Проверь Node.js",
    instructions: "Только безопасные инструменты.",
    effort: "low",
    localFunctions: [],
    dispatcher: { async dispatch() { throw new Error("not called"); } },
    progress: { onProgress(event) { progress.push(event); } },
  });

  assert.deepEqual(transport.requests[0], {
    model: "gpt-5.6-luna", service_tier: "priority", reasoning: { effort: "low" },
    store: false, stream: true, prompt_cache_key: "parilka:responses:v1", instructions: "Только безопасные инструменты.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Проверь Node.js" }] }],
    tools: [{ type: "web_search", search_context_size: "medium" }],
    include: ["reasoning.encrypted_content", "web_search_call.action.sources"], max_tool_calls: 8, parallel_tool_calls: false,
  });
  assert.deepEqual(result, {
    responseId: "resp-final", model: "gpt-5.6-luna", text: "Проверил источник [1]",
    annotations: [{ startIndex: 18, endIndex: 21, title: "Node.js", url: "https://nodejs.org" }],
    functionCalls: 0, completed: true, finishStatus: "completed",
    usage: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 17 },
    serviceTier: "priority",
  });
  assert.deepEqual(progress.map((event) => ({ type: event.type, ...(event.action === undefined ? {} : { action: event.action }) })), [
    { type: "thinking_started" }, { type: "thinking_completed" }, { type: "hosted_web_started" },
    { type: "hosted_web_action", action: "open_page" }, { type: "hosted_web_completed" },
  ]);
});

test("Responses core announces thinking before opening the upstream request", async () => {
  const order: string[] = [];
  const transport: ResponsesStreamTransport = {
    async create() {
      order.push("transport:create");
      return events(completed(response("resp-fast", "Да")));
    },
  };
  await new OpenAiResponsesTurnClient(transport).run({
    text: "алло", instructions: "Кратко.", effort: "low", localFunctions: [],
    dispatcher: { async dispatch() { throw new Error("not called"); } },
    progress: { onProgress(event) { order.push(event.type); } },
  });
  assert.deepEqual(order.slice(0, 2), ["thinking_started", "transport:create"]);
});

test("Responses core keeps exact local schemas and continues one turn sequentially", async () => {
  const schema = { type: "function" as const, name: "lookup", description: "local", parameters: { type: "object" } };
  const firstOutput = [{
    type: "reasoning", id: "rsn-1", status: "completed", summary: [], encrypted_content: "encrypted-turn-state",
  }, {
    type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"query":"баня"}', status: "completed",
  }];
  const transport = new FakeResponses(
    events(completed(response("resp-tool", "", [], firstOutput))),
    events(completed(response("resp-final", "Готово"))),
  );
  const calls: unknown[] = [];
  const progress: string[] = [];
  const result = await new OpenAiResponsesTurnClient(transport).run({
    text: "Найди в истории",
    instructions: "Повтори в continuation.", effort: "medium", localFunctions: [schema],
    dispatcher: { async dispatch(call) { calls.push(call); return { success: true, text: "найдено" }; } },
    progress: { onProgress(event) { progress.push(event.type); } },
  });

  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[0].tools[1], schema);
  assert.equal(transport.requests[1].tools[1], schema);
  assert.equal("previous_response_id" in transport.requests[0], false);
  assert.equal("previous_response_id" in transport.requests[1], false);
  assert.equal(transport.requests[1].instructions, "Повтори в continuation.");
  assert.equal(transport.requests[0].prompt_cache_key, "parilka:responses:v1");
  assert.equal(transport.requests[1].prompt_cache_key, "parilka:responses:v1");
  assert.deepEqual(calls, [{ callId: "call-1", name: "lookup", arguments: { query: "баня" } }]);
  assert.deepEqual(transport.requests[1].input, [
    { role: "user", content: [{ type: "input_text", text: "Найди в истории" }] },
    ...firstOutput,
    { type: "function_call_output", call_id: "call-1", output: "найдено" },
  ]);
  assert.equal(result.responseId, "resp-final");
  assert.equal(result.model, "gpt-5.6-luna");
  assert.equal(result.serviceTier, "priority");
  assert.equal(result.functionCalls, 1);
  assert.deepEqual(progress, [
    "thinking_started", "thinking_completed", "local_function_started", "local_function_completed",
    "thinking_started", "thinking_completed",
  ]);
});

test("Responses core continues after two 64k local pages and emits a bounded overflow error", async () => {
  const schema = { type: "function" as const, name: "read_chat_slice", parameters: { type: "object" } };
  const oversized = "x".repeat(64_000);
  const transport = new FakeResponses(
    events(completed(response("resp-tool-1", "", [], [{
      type: "function_call", call_id: "call-1", name: "read_chat_slice", arguments: "{}", status: "completed",
    }]))),
    events(completed(response("resp-tool-2", "", [], [{
      type: "function_call", call_id: "call-2", name: "read_chat_slice", arguments: "{}", status: "completed",
    }]))),
    events(completed(response("resp-final", "Готово"))),
  );
  const result = await new OpenAiResponsesTurnClient(transport).run({
    text: "x", instructions: "x", effort: "low", localFunctions: [schema],
    dispatcher: { async dispatch() { return { success: true, text: oversized }; } },
  });
  assert.equal(result.text, "Готово");
  assert.equal(transport.requests.length, 3);
  assert.equal(functionOutputs(transport.requests[1]).at(-1)?.output.length, 64_000);
  const overflow = functionOutputs(transport.requests[2]).at(-1)?.output ?? "";
  assert.match(overflow, /output budget exhausted/u);
  assert.ok(overflow.length < 64_000, "over-budget raw host output must never be forwarded");
  assert.ok(64_000 + overflow.length <= 96_000);
});

test("Responses core deterministically requires only hosted web on an explicit first leg", async () => {
  const schema = { type: "function" as const, name: "lookup", parameters: { type: "object" } };
  const transport = new FakeResponses(
    events(completed(response("resp-web", "", [], [{
      type: "web_search_call", id: "web-1", action: { type: "search" }, status: "completed",
    }, {
      type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}", status: "completed",
    }]))),
    events(completed(response("resp-final", "Готово"))),
  );
  await new OpenAiResponsesTurnClient(transport).run({
    text: "Проверь веб-поиск", instructions: "x", effort: "low", localFunctions: [schema],
    hostedWebSearchPolicy: "required_first_leg",
    dispatcher: { async dispatch() { return { success: true, text: "ok" }; } },
  });

  assert.deepEqual(transport.requests[0].tool_choice, {
    type: "allowed_tools", mode: "required", tools: [{ type: "web_search" }],
  });
  assert.equal(transport.requests[1].tool_choice, undefined);
  assert.equal("previous_response_id" in transport.requests[1], false);
});

test("Responses core rejects an explicit-web first leg without a hosted web call", async () => {
  const transport = new FakeResponses(events(completed(response("resp-no-web", "Нет"))));
  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run({
      text: "Проверь веб", instructions: "x", effort: "low", localFunctions: [],
      hostedWebSearchPolicy: "required_first_leg",
      dispatcher: { async dispatch() { throw new Error("not called"); } },
    }),
    /required hosted web_search/u,
  );
});

test("Responses core reserves a deterministic overflow output for sibling calls", async () => {
  const schema = { type: "function" as const, name: "read_chat_slice", parameters: { type: "object" } };
  const transport = new FakeResponses(
    events(completed(response("resp-pages", "", [], [
      { type: "function_call", call_id: "call-large", name: "read_chat_slice", arguments: "{}", status: "completed" },
      { type: "function_call", call_id: "call-overflow", name: "read_chat_slice", arguments: "{}", status: "completed" },
    ]))),
    events(completed(response("resp-final", "Готово"))),
  );
  let count = 0;
  const result = await new OpenAiResponsesTurnClient(transport).run({
    text: "x", instructions: "x", effort: "low", localFunctions: [schema], maxFunctionCalls: 2,
    dispatcher: { async dispatch() {
      count += 1;
      return { success: true, text: count === 1 ? "a".repeat(95_000) : "b".repeat(64_000) };
    } },
  });
  assert.equal(result.text, "Готово");
  const outputs = functionOutputs(transport.requests[1]!);
  assert.equal(outputs[0]?.output.length, 95_000);
  assert.match(outputs[1]?.output ?? "", /output budget exhausted/u);
  assert.ok(outputs.reduce((total, item) => total + item.output.length, 0) <= 96_000);
});

test("Responses core rejects a substituted model on its initial completed leg", async () => {
  const transport = new FakeResponses(events(completed(response("resp-terra", "Нет", [], undefined, {
    model: "gpt-5.6-terra",
  }))));
  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run({
      text: "x", instructions: "x", effort: "low", localFunctions: [],
      dispatcher: { async dispatch() { throw new Error("not called"); } },
    }),
    /unexpected model/u,
  );
});

test("Responses core rejects a substituted model on a continuation leg", async () => {
  const schema = { type: "function" as const, name: "lookup", parameters: { type: "object" } };
  const transport = new FakeResponses(
    events(completed(response("resp-tool", "", [], [{
      type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}", status: "completed",
    }]))),
    events(completed(response("resp-sol", "Нет", [], undefined, { model: "gpt-5.6-sol" }))),
  );
  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run({
      text: "x", instructions: "x", effort: "low", localFunctions: [schema],
      dispatcher: { async dispatch() { return { success: true, text: "ok" }; } },
    }),
    /unexpected model/u,
  );
  assert.equal(transport.requests.length, 2);
});

for (const [name, serviceTier] of [
  ["missing tier", undefined],
  ["default tier", "default"],
  ["null tier", null],
] as const) {
  test(`Responses core rejects ${name} on a completed leg`, async () => {
    const transport = new FakeResponses(events(completed(response("resp-tier", "Нет", [], undefined, {
      service_tier: serviceTier,
    }))));
    await assert.rejects(
      new OpenAiResponsesTurnClient(transport).run({
        text: "x", instructions: "x", effort: "low", localFunctions: [],
        dispatcher: { async dispatch() { throw new Error("not called"); } },
      }),
      /required fast service tier/u,
    );
  });
}

test("Responses core admits only transport-normalized priority Fast tier", async () => {
  const transport = new FakeResponses(events(completed(response("resp-tier", "Да"))));
  const result = await new OpenAiResponsesTurnClient(transport).run({
    text: "x", instructions: "x", effort: "low", localFunctions: [],
    dispatcher: { async dispatch() { throw new Error("not called"); } },
  });
  assert.equal(result.model, "gpt-5.6-luna");
  assert.equal(result.serviceTier, "priority");
  const fastTransport = new FakeResponses(events(completed(response("resp-fast", "Нет", [], undefined, {
    service_tier: "fast",
  }))));
  await assert.rejects(
    new OpenAiResponsesTurnClient(fastTransport).run({
      text: "x", instructions: "x", effort: "low", localFunctions: [],
      dispatcher: { async dispatch() { throw new Error("not called"); } },
    }),
    /required fast service tier/u,
  );
});

test("Responses core projects terminal hosted web calls when granular stream events are absent", async () => {
  const transport = new FakeResponses(events(completed(response("resp-web-final", "Готово", [], [{
    type: "web_search_call", id: "web-terminal", action: { type: "find_in_page" }, status: "completed",
  }]))));
  const progress: Array<{ type: string; callId: string; action?: string; ok?: boolean }> = [];
  await new OpenAiResponsesTurnClient(transport).run({
    text: "Проверь", instructions: "x", effort: "low", localFunctions: [],
    dispatcher: { async dispatch() { throw new Error("not called"); } },
    progress: { onProgress(event) { progress.push(event); } },
  });
  assert.equal(progress[0]?.type, "thinking_started");
  assert.deepEqual(progress.slice(1), [
    { type: "thinking_completed", callId: progress[1]!.callId, ok: true },
    { type: "hosted_web_started", callId: "web-terminal", action: "find_in_page" },
    { type: "hosted_web_completed", callId: "web-terminal", ok: true },
  ]);
});

test("late action metadata re-labels a granularly completed progress item", async () => {
  const final = response("resp-web-final", "Готово", [], [
    { type: "web_search_call", id: "web-terminal", action: { type: "open_page" }, status: "completed" },
    {
      type: "message", id: "msg-1", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: "Готово", annotations: [] }],
    },
  ]);
  const transport = new FakeResponses(events(
    web("response.web_search_call.in_progress", "web-terminal"),
    web("response.web_search_call.completed", "web-terminal"),
    completed(final),
  ));
  const progress: Array<{ type: string; callId: string; action?: string; ok?: boolean }> = [];
  await new OpenAiResponsesTurnClient(transport).run({
    text: "Проверь", instructions: "x", effort: "low", localFunctions: [],
    dispatcher: { async dispatch() { throw new Error("not called"); } },
    progress: { onProgress(event) { progress.push(event); } },
  });
  assert.deepEqual(progress.map(({ type, callId, action, ok }) => ({
    type,
    callId: callId.startsWith("thinking:") ? "thinking" : callId,
    ...(action === undefined ? {} : { action }),
    ...(ok === undefined ? {} : { ok }),
  })), [
    { type: "thinking_started", callId: "thinking" },
    { type: "thinking_completed", callId: "thinking", ok: true },
    { type: "hosted_web_started", callId: "web-terminal" },
    { type: "hosted_web_completed", callId: "web-terminal", ok: true },
    { type: "hosted_web_action", callId: "web-terminal", action: "open_page" },
    { type: "hosted_web_completed", callId: "web-terminal", ok: true },
  ]);
});

test("Responses core never presents an unknown function and marks rejected host results failed", async () => {
  const schema = { type: "function" as const, name: "lookup", parameters: { type: "object" } };
  const transport = new FakeResponses(
    events(completed(response("resp-tools", "", [], [
      { type: "function_call", call_id: "unknown-1", name: "forged", arguments: "{}", status: "completed" },
      { type: "function_call", call_id: "known-1", name: "lookup", arguments: "{}", status: "completed" },
    ]))),
    events(completed(response("resp-final", "Готово"))),
  );
  const progress: Array<{ type: string; name?: string; ok?: boolean }> = [];
  await new OpenAiResponsesTurnClient(transport).run({
    text: "x", instructions: "x", effort: "low", localFunctions: [schema],
    dispatcher: { async dispatch() { return { success: false, text: "invalid arguments" }; } },
    progress: { onProgress(event) { progress.push(event); } },
  });
  assert.deepEqual(
    progress.filter((event) => event.type.startsWith("local_function")),
    [
      { type: "local_function_started", callId: "known-1", name: "lookup" },
      { type: "local_function_completed", callId: "known-1", name: "lookup", ok: false },
    ],
  );
});

test("Responses core allows isolated maintenance structured output without hosted web", async () => {
  const transport = new FakeResponses(events(completed(response("resp-maintain", "{\"ok\":true}"))));
  await new OpenAiResponsesTurnClient(transport).run({
    text: "Сверни", instructions: "Верни JSON.", effort: "none", localFunctions: [], hostedWebSearch: false,
    maxOutputTokens: 300,
    textJsonSchema: { name: "maintenance", schema: { type: "object", additionalProperties: false } },
    dispatcher: { async dispatch() { throw new Error("not called"); } },
  });
  assert.deepEqual(transport.requests[0].tools, []);
  assert.deepEqual(transport.requests[0].include, ["reasoning.encrypted_content"]);
  assert.equal(transport.requests[0].max_output_tokens, 300);
  assert.deepEqual(transport.requests[0].text, {
    format: { type: "json_schema", name: "maintenance", schema: { type: "object", additionalProperties: false } },
  });
});

test("Responses core accepts a data URL image and rejects malformed image input before transport", async () => {
  const transport = new FakeResponses(events(completed(response("resp-image", "Вижу фото"))));
  await new OpenAiResponsesTurnClient(transport).run({
    text: "Что на картинке?", instructions: "Кратко.", effort: "none", localFunctions: [],
    dispatcher: { async dispatch() { throw new Error("not called"); } },
    image: { dataUrl: "data:image/jpeg;base64,AA==", detail: "high" },
  });
  assert.deepEqual(transport.requests[0].input[0], {
    role: "user",
    content: [
      { type: "input_text", text: "Что на картинке?" },
      { type: "input_image", image_url: "data:image/jpeg;base64,AA==", detail: "high" },
    ],
  });
  await assert.rejects(
    new OpenAiResponsesTurnClient(new FakeResponses()).run({
      text: "x", instructions: "x", effort: "none", localFunctions: [],
      dispatcher: { async dispatch() { throw new Error("not called"); } },
      image: { dataUrl: "https://not-a-data-url.example/image.jpg" },
    }),
    ResponsesTurnError,
  );
});

test("Responses core stops an unresponsive stream when its caller aborts", async () => {
  const transport = new FakeResponses(hanging());
  const controller = new AbortController();
  const run = new OpenAiResponsesTurnClient(transport).run({
    text: "Останови", instructions: "Кратко.", effort: "none", localFunctions: [], signal: controller.signal,
    dispatcher: { async dispatch() { throw new Error("not called"); } },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(run, ResponsesTurnCancelledError);
});

async function* events(...items: ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> {
  yield* items;
}

function completed(value: Record<string, unknown>): ResponseStreamEvent {
  return { type: "response.completed", response: value, sequence_number: 1 } as unknown as ResponseStreamEvent;
}

function web(type: string, itemId: string): ResponseStreamEvent {
  return { type, item_id: itemId, output_index: 0, sequence_number: 1 } as unknown as ResponseStreamEvent;
}

function webItem(type: string, id: string, action: string, status: string): ResponseStreamEvent {
  return {
    type, output_index: 0, sequence_number: 1,
    item: { type: "web_search_call", id, action: { type: action }, status },
  } as unknown as ResponseStreamEvent;
}

function response(
  id: string,
  text: string,
  annotations: readonly Record<string, unknown>[] = [],
  output: readonly Record<string, unknown>[] = [{
    type: "message", id: "msg-1", status: "completed", role: "assistant",
    content: [{ type: "output_text", text, annotations }],
  }],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id, model: "gpt-5.6-luna", status: "completed", output_text: text, output, service_tier: "priority",
    usage: {
      input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 17,
    },
    ...overrides,
  };
}

function functionOutputs(request: ResponsesCreateRequest): Array<{ output: string }> {
  return request.input.filter((item): item is { type: "function_call_output"; output: string } =>
    item.type === "function_call_output" && typeof item.output === "string",
  );
}

function hanging(): AsyncIterable<ResponseStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<ResponseStreamEvent>>(() => {}),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}
