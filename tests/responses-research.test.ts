import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import {
  OpenAiResponsesTurnClient,
  ResponsesTurnCancelledError,
  type ResponsesCreateRequest,
  type ResponsesStreamTransport,
} from "../src/openai-responses/index.js";

class FakeResponses implements ResponsesStreamTransport {
  readonly requests: ResponsesCreateRequest[] = [];
  #streams: AsyncIterable<ResponseStreamEvent>[];

  constructor(...streams: AsyncIterable<ResponseStreamEvent>[]) {
    this.#streams = streams;
  }

  async create(request: ResponsesCreateRequest): Promise<AsyncIterable<ResponseStreamEvent>> {
    this.requests.push(request);
    const next = this.#streams.shift();
    if (!next) throw new Error("unexpected create");
    return next;
  }
}

test("Responses core forces bounded research continuations until four successful hosted calls", async () => {
  const firstOutput = [
    hostedWebOutput("web-1", "search", { queries: ["рынок авто РФ август 2026"] }),
    hostedWebOutput("web-2", "open_page", { url: "https://market.example/cars" }),
    assistantOutput("msg-draft", "Черновой вывод", [{
      type: "url_citation", start_index: 0, end_index: 1,
      title: "Рынок", url: "https://market.example/cars",
    }]),
  ];
  const finalOutput = [
    hostedWebOutput("web-3", "search", { queries: ["BMW E60 типичные проблемы"] }),
    hostedWebOutput("web-4", "open_page", { url: "https://service.example/e60" }),
    assistantOutput("msg-final", "Итог после проверки", [{
      type: "url_citation", start_index: 0, end_index: 1,
      title: "Надёжность", url: "https://service.example/e60",
    }]),
  ];
  const transport = new FakeResponses(
    events(completed(response("resp-draft", "Черновой вывод", firstOutput))),
    events(completed(response("resp-final", "Итог после проверки", finalOutput))),
  );

  const result = await new OpenAiResponsesTurnClient(transport).run(researchRequest());

  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests.every((item) => item.tool_choice?.mode === "required"), true);
  assert.deepEqual(transport.requests[1]?.input.slice(0, 1), transport.requests[0]?.input);
  assert.deepEqual(transport.requests[1]?.input.slice(1, 1 + firstOutput.length), firstOutput);
  const continuation = transport.requests[1]?.input.at(-1) as {
    role?: unknown; content?: Array<{ type?: unknown; text?: unknown }>;
  } | undefined;
  assert.equal(continuation?.role, "developer");
  assert.equal(continuation?.content?.[0]?.type, "input_text");
  assert.match(String(continuation?.content?.[0]?.text), /Exactly 2 additional distinct hosted web actions/u);
  assert.match(String(continuation?.content?.[0]?.text), /stop calling web/u);
  assert.equal(result.text, "Итог после проверки");
  assert.equal(result.hostedWebCalls, 4);
  assert.deepEqual(result.aggregateUsage, {
    inputTokens: 20, cachedInputTokens: 6, outputTokens: 14,
    reasoningOutputTokens: 4, totalTokens: 34,
  });
  assert.deepEqual(result.annotations.map(({ title, url }) => ({ title, url })), [
    { title: "Надёжность", url: "https://service.example/e60" },
  ]);
});

test("Responses core bounds one-call research at four required legs", async () => {
  const transport = new FakeResponses(...[1, 2, 3, 4].map((index) => events(completed(response(
    `resp-${String(index)}`,
    `draft-${String(index)}`,
    [
      hostedWebOutput(
        `web-${String(index)}`,
        index === 4 ? "open_page" : "search",
        index === 4 ? { url: "https://market.example/cars" } : { queries: [`query-${String(index)}`] },
      ),
      assistantOutput(`msg-${String(index)}`, `draft-${String(index)}`),
    ],
  )))));

  const result = await new OpenAiResponsesTurnClient(transport).run(researchRequest());

  assert.equal(transport.requests.length, 4);
  assert.equal(transport.requests.every((item) => item.tool_choice?.mode === "required"), true);
  assert.equal(result.text, "draft-4");
  assert.equal(result.hostedWebCalls, 4);
});

test("Responses core rejects a bounded-research continuation that omits required web", async () => {
  const transport = new FakeResponses(
    events(completed(response("resp-one", "Слишком рано", [
      hostedWebOutput("web-1", "search"), assistantOutput("msg-one", "Слишком рано"),
    ]))),
    events(completed(response("resp-no-web", "Опять слишком рано"))),
  );

  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run(researchRequest()),
    /required hosted web_search on this leg/u,
  );
  assert.equal(transport.requests.length, 2);
});

test("Responses core does not count failed hosted actions toward research coverage", async () => {
  const transport = new FakeResponses(
    events(completed(response("resp-failed", "draft-1", [
      hostedWebOutput("web-failed", "search", {}, "failed"), assistantOutput("msg-1", "draft-1"),
    ]))),
    events(completed(response("resp-three", "draft-2", [
      hostedWebOutput("web-1", "search", { queries: ["рынок"] }),
      hostedWebOutput("web-2", "open_page", { url: "https://market.example/cars" }),
      hostedWebOutput("web-3", "find_in_page", { url: "https://market.example/cars", pattern: "цена" }),
      assistantOutput("msg-2", "draft-2"),
    ]))),
    events(completed(response("resp-final", "verified final"))),
  );

  const result = await new OpenAiResponsesTurnClient(transport).run(researchRequest());

  assert.equal(transport.requests.length, 3);
  assert.deepEqual(transport.requests[2]?.tools, []);
  assert.equal(result.text, "verified final");
  assert.equal(result.hostedWebCalls, 4, "footer tool count includes the failed attempt");
});

test("Responses core refuses a research answer below the three-action synthesis floor", async () => {
  const statuses = ["completed", "completed", "in_progress", "failed"];
  const transport = new FakeResponses(...statuses.map((status, index) => events(completed(response(
    `resp-${String(index)}`,
    `draft-${String(index)}`,
    [
      hostedWebOutput(`web-${String(index)}`, "search", {}, status),
      assistantOutput(`msg-${String(index)}`, `draft-${String(index)}`),
    ],
  )))));

  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run(researchRequest()),
    /exhausted before sufficient hosted-web coverage/u,
  );
  assert.equal(transport.requests.length, 4);
});

test("Responses core accounts for terminal-only actions already completed above the target", async () => {
  const output = [1, 2, 3, 4, 5].map((index) => hostedWebOutput(
    `web-${String(index)}`,
    index === 5 ? "open_page" : "search",
    index === 5 ? { url: "https://market.example/cars" } : { queries: [`distinct-${String(index)}`] },
  ));
  output.push(assistantOutput("msg-final", "verified final"));
  const transport = new FakeResponses(events(completed(response("resp-final", "verified final", output))));

  const result = await new OpenAiResponsesTurnClient(transport).run(researchRequest());

  assert.equal(transport.requests.length, 1);
  assert.equal(result.text, "verified final");
  assert.equal(result.hostedWebCalls, 5);
});

test("Responses core does not treat repeated selectors as distinct research evidence", async () => {
  const transport = new FakeResponses(...[1, 2, 3, 4].map((index) => events(completed(response(
    `resp-${String(index)}`,
    `draft-${String(index)}`,
    [
      hostedWebOutput(`web-${String(index)}`, "search", { queries: ["same query"] }),
      assistantOutput(`msg-${String(index)}`, `draft-${String(index)}`),
    ],
  )))));

  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run(researchRequest()),
    /exhausted before sufficient hosted-web coverage/u,
  );
  assert.equal(transport.requests.length, 4);
});

test("Responses core unions distinct evidence across streamed research legs", async () => {
  const prior = [
    hostedWebOutput("web-a", "search", { queries: ["A"] }),
    hostedWebOutput("web-b", "search", { queries: ["B"] }),
    assistantOutput("msg-prior", "draft"),
  ];
  const transport = new FakeResponses(
    events(completed(response("resp-prior", "draft", prior))),
    streamedEvidence([
      hostedWebOutput("web-a-repeat", "search", { queries: ["A"] }),
      hostedWebOutput("web-b-repeat", "search", { queries: ["B"] }),
    ]),
  );
  const controller = new AbortController();
  const run = new OpenAiResponsesTurnClient(transport).run({
    ...researchRequest(),
    signal: controller.signal,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(run, ResponsesTurnCancelledError);
  assert.equal(transport.requests.length, 2, "two repeated selectors must not start a synthesis leg");
});

test("Responses core cuts off native research after four streamed actions and runs a tool-free finalizer", async () => {
  const captured = [
    hostedWebOutput("web-1", "search", { queries: ["рынок авто РФ"] }),
    hostedWebOutput("web-2", "search", { queries: ["цены август 2026"] }),
    hostedWebOutput("web-3", "open_page", { url: "https://market.example/cars" }),
    hostedWebOutput("web-4", "find_in_page", { url: "https://service.example/risks", pattern: "риски" }),
  ];
  const finalOutput = [assistantOutput("msg-final", "Проверенный итог", [{
    type: "url_citation", start_index: 0, end_index: 1,
    title: "Рынок", url: "https://market.example/cars",
  }])];
  const transport = new FakeResponses(
    streamedEvidence(captured),
    events(completed(response("resp-final", "Проверенный итог", finalOutput))),
  );

  const result = await new OpenAiResponsesTurnClient(transport).run(researchRequest());

  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[0]?.tool_choice?.mode, "required");
  assert.equal(transport.requests[0]?.reasoning.effort, "max");
  assert.deepEqual(transport.requests[1]?.tools, []);
  assert.equal(transport.requests[1]?.tool_choice, undefined);
  assert.equal(transport.requests[1]?.reasoning.effort, "max");
  assert.deepEqual(transport.requests[1]?.input.slice(1, 5), captured);
  const synthesis = transport.requests[1]?.input.at(-1) as {
    role?: unknown; content?: Array<{ text?: unknown }>;
  } | undefined;
  assert.equal(synthesis?.role, "developer");
  assert.match(String(synthesis?.content?.[0]?.text), /Tools are intentionally disabled/u);
  assert.equal(result.text, "Проверенный итог");
  assert.equal(result.hostedWebCalls, 4);
  assert.equal(result.functionCalls, 0);
  assert.deepEqual(result.annotations.map(({ title, url }) => ({ title, url })), [{
    title: "Рынок", url: "https://market.example/cars",
  }]);
  assert.equal(result.aggregateUsage, undefined, "an intentionally aborted evidence stream has no terminal usage");
});

test("Responses core finalizes terminal three-of-four coverage without another web attempt", async () => {
  const evidenceOutput = [
    hostedWebOutput("web-1", "search"),
    hostedWebOutput("web-2", "open_page", { url: "https://market.example/cars" }),
    hostedWebOutput("web-3", "find_in_page", { url: "https://market.example/cars", pattern: "цена" }),
    hostedWebOutput("web-4", "search", {}, "failed"),
    assistantOutput("msg-draft", "Черновик"),
  ];
  const transport = new FakeResponses(
    events(completed(response("resp-evidence", "Черновик", evidenceOutput))),
    events(completed(response("resp-final", "Финал с оговоркой"))),
  );

  const result = await new OpenAiResponsesTurnClient(transport).run(researchRequest());

  assert.equal(transport.requests.length, 2);
  assert.deepEqual(transport.requests[1]?.tools, []);
  const synthesis = transport.requests[1]?.input.at(-1) as {
    content?: Array<{ text?: unknown }>;
  } | undefined;
  assert.match(String(synthesis?.content?.[0]?.text), /3 successful actions across 4 attempts/u);
  assert.equal(result.text, "Финал с оговоркой");
  assert.equal(result.hostedWebCalls, 4);
  assert.deepEqual(result.annotations.map(({ title, url }) => ({ title, url })), [{
    title: "market.example", url: "https://market.example/cars",
  }]);
});

test("Responses core carries caller cancellation into a bounded-research continuation", async () => {
  const transport = new FakeResponses(
    events(completed(response("resp-one", "draft", [
      hostedWebOutput("web-1", "search"), assistantOutput("msg-one", "draft"),
    ]))),
    hanging(),
  );
  const controller = new AbortController();
  const run = new OpenAiResponsesTurnClient(transport).run({ ...researchRequest(), signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(run, ResponsesTurnCancelledError);
  assert.equal(transport.requests.length, 2);
});

function researchRequest() {
  return {
    text: "deep research", instructions: "research", effort: "max" as const, localFunctions: [],
    hostedWebSearchPolicy: "bounded_research" as const,
    dispatcher: { async dispatch() { throw new Error("not called"); } },
  };
}

async function* events(...items: ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> { yield* items; }

async function* streamedEvidence(items: readonly Record<string, unknown>[]): AsyncGenerator<ResponseStreamEvent> {
  for (const [index, item] of items.entries()) {
    yield {
      type: "response.output_item.done",
      output_index: index,
      item,
      sequence_number: index + 1,
    } as unknown as ResponseStreamEvent;
  }
  await new Promise<void>(() => {});
}

function completed(value: Record<string, unknown>): ResponseStreamEvent {
  return { type: "response.completed", response: value, sequence_number: 1 } as unknown as ResponseStreamEvent;
}

function hostedWebOutput(
  id: string,
  type: "search" | "open_page" | "find_in_page",
  input: Readonly<Record<string, unknown>> = {},
  status = "completed",
): Record<string, unknown> {
  return { type: "web_search_call", id, action: { type, ...input }, status };
}

function assistantOutput(
  id: string,
  text: string,
  annotations: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    type: "message", id, status: "completed", role: "assistant",
    content: [{ type: "output_text", text, annotations }],
  };
}

function response(
  id: string,
  text: string,
  output: readonly Record<string, unknown>[] = [assistantOutput("msg-1", text)],
): Record<string, unknown> {
  return {
    id, model: "gpt-5.6-luna", status: "completed", output_text: text, output, service_tier: "priority",
    usage: {
      input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 17,
    },
  };
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
