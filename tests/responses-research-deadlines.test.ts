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

test("Responses core requires an open_page fetch attempt before a search-only research answer can finalize", async () => {
  const searches = [1, 2, 3, 4].map((index) => hostedWebOutput(
    `web-search-${String(index)}`,
    "search",
    { queries: [`distinct-${String(index)}`] },
  ));
  const transport = new FakeResponses(
    events(completed(response("resp-searches", "Черновик после выдачи", [
      ...searches, assistantOutput("msg-searches", "Черновик после выдачи"),
    ]))),
    events(completed(response("resp-fetch", "Итог после открытия", [
      hostedWebOutput("web-open", "open_page", { url: "https://market.example/cars" }),
      assistantOutput("msg-fetch", "Итог после открытия"),
    ]))),
  );

  const result = await new OpenAiResponsesTurnClient(transport).run(researchRequest());

  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[1]?.tool_choice?.mode, "required");
  const continuation = transport.requests[1]?.input.at(-1) as {
    content?: Array<{ text?: unknown }>;
  } | undefined;
  assert.match(String(continuation?.content?.[0]?.text), /open_page fetch attempt is still mandatory/u);
  assert.equal(result.text, "Итог после открытия");
  assert.equal(result.hostedWebCalls, 5);
});

test("Responses core fails a never-settling tool-free synthesis leg before the global timeout", async () => {
  const captured = researchEvidence();
  const transport = new FakeResponses(streamedEvidence(captured), hanging());
  const startedAt = Date.now();

  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run({ ...researchRequest(), timeoutMs: 5_000 }),
    /bounded research synthesis leg stalled/u,
  );

  assert.ok(Date.now() - startedAt < 2_000, "silent synthesis must not consume the global timeout");
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(transport.requests[1]?.tools, []);
});

test("Responses core does not let a stalled research progress callback bypass the synthesis watchdog", async () => {
  const transport = new FakeResponses(streamedEvidence(researchEvidence()), hanging());
  let thinkingStarts = 0;
  const startedAt = Date.now();

  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run({
      ...researchRequest(), timeoutMs: 5_000,
      progress: {
        async onProgress(event) {
          if (event.type === "thinking_started" && ++thinkingStarts === 2) {
            await new Promise<void>(() => {});
          }
        },
      },
    }),
    /bounded research synthesis leg stalled/u,
  );

  assert.ok(Date.now() - startedAt < 2_000, "presentation must not outlive the synthesis watchdog");
  assert.equal(transport.requests.length, 1, "the blocked presentation must prevent opening a second stream");
});

test("Responses core bounds a transport create promise that ignores AbortSignal", async () => {
  let createCalls = 0;
  let observedAbort = false;
  const transport: ResponsesStreamTransport = {
    async create(_request, options) {
      createCalls += 1;
      options.signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
      return await new Promise<AsyncIterable<ResponseStreamEvent>>(() => {});
    },
  };
  const startedAt = Date.now();

  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run({ ...researchRequest(), timeoutMs: 5_000 }),
    /bounded research evidence leg stalled/u,
  );

  assert.ok(Date.now() - startedAt < 2_000, "stalled create must not consume the global timeout");
  assert.equal(createCalls, 1);
  assert.equal(observedAbort, true, "the watchdog still aborts a non-cooperative transport");
});

test("Responses core lets external cancellation win when the research watchdog aborts concurrently", async () => {
  const controller = new AbortController();
  let createCalls = 0;
  const transport: ResponsesStreamTransport = {
    async create(_request, options) {
      createCalls += 1;
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      return await new Promise<AsyncIterable<ResponseStreamEvent>>(() => {});
    },
  };

  await assert.rejects(
    new OpenAiResponsesTurnClient(transport).run({
      ...researchRequest(), timeoutMs: 5_000, signal: controller.signal,
    }),
    ResponsesTurnCancelledError,
  );

  assert.equal(createCalls, 1);
  assert.equal(controller.signal.aborted, true);
});

test("Responses core cuts off a stalled fourth hosted action and does not await stream return", async () => {
  const captured = researchEvidence().slice(0, 3);
  const finalOutput = [assistantOutput("msg-final", "Итог по трём готовым источникам")];
  const transport = new FakeResponses(
    stalledFourthEvidence(captured),
    events(completed(response("resp-final", "Итог по трём готовым источникам", finalOutput))),
  );
  const progressEvents: Array<Record<string, unknown>> = [];
  const startedAt = Date.now();

  const result = await new OpenAiResponsesTurnClient(transport).run({
    ...researchRequest(),
    timeoutMs: 5_000,
    progress: { async onProgress(event) { progressEvents.push(event); } },
  });

  assert.ok(Date.now() - startedAt < 2_000, "stalled stream return must not consume the global timeout");
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(transport.requests[1]?.tools, []);
  assert.deepEqual(transport.requests[1]?.input.slice(1, 4), captured);
  const synthesis = transport.requests[1]?.input.at(-1) as {
    role?: unknown; content?: Array<{ text?: unknown }>;
  } | undefined;
  assert.match(String(synthesis?.content?.[0]?.text), /3 successful actions across 4 attempts/u);
  assert.match(String(synthesis?.content?.[0]?.text), /slow, failed, or redundant hosted action/u);
  assert.equal(result.text, "Итог по трём готовым источникам");
  assert.equal(result.hostedWebCalls, 4);
  assert.equal(progressEvents.some((event) => event.type === "hosted_web_completed" &&
    event.callId === "web-4" && event.ok === false), true);
});

test("Responses core applies the stalled-action grace across research legs", async () => {
  const priorOutput = [
    hostedWebOutput("web-1", "search"),
    hostedWebOutput("web-2", "open_page"),
    hostedWebOutput("web-3", "find_in_page"),
    assistantOutput("msg-draft", "Черновик по трём источникам"),
  ];
  const transport = new FakeResponses(
    events(completed(response("resp-prior", "Черновик по трём источникам", priorOutput))),
    stalledWebAction("web-4"),
    events(completed(response("resp-final", "Финал после bounded cutoff"))),
  );
  const startedAt = Date.now();

  const result = await new OpenAiResponsesTurnClient(transport).run({
    ...researchRequest(),
    timeoutMs: 5_000,
  });

  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(transport.requests.length, 3);
  assert.deepEqual(transport.requests[2]?.tools, []);
  assert.deepEqual(transport.requests[2]?.input.slice(1, 1 + priorOutput.length), priorOutput);
  const synthesis = transport.requests[2]?.input.at(-1) as {
    content?: Array<{ text?: unknown }>;
  } | undefined;
  assert.match(String(synthesis?.content?.[0]?.text), /3 successful actions across 4 attempts/u);
  assert.equal(result.text, "Финал после bounded cutoff");
  assert.equal(result.hostedWebCalls, 4);
});

function researchRequest() {
  return {
    text: "deep research", instructions: "research", effort: "max" as const, localFunctions: [],
    hostedWebSearchPolicy: "bounded_research" as const,
    dispatcher: { async dispatch() { throw new Error("not called"); } },
  };
}

function researchEvidence(): Record<string, unknown>[] {
  return [
    hostedWebOutput("web-1", "search", { queries: ["рынок авто РФ"] }),
    hostedWebOutput("web-2", "search", { queries: ["цены август 2026"] }),
    hostedWebOutput("web-3", "open_page", { url: "https://market.example/cars" }),
    hostedWebOutput("web-4", "find_in_page", { url: "https://market.example/cars", pattern: "цена" }),
  ];
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

function stalledFourthEvidence(items: readonly Record<string, unknown>[]): AsyncIterable<ResponseStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next(): Promise<IteratorResult<ResponseStreamEvent>> {
          if (index < items.length) {
            const outputIndex = index;
            const item = items[index];
            index += 1;
            return Promise.resolve({
              done: false,
              value: {
                type: "response.output_item.done",
                output_index: outputIndex,
                item,
                sequence_number: outputIndex + 1,
              } as unknown as ResponseStreamEvent,
            });
          }
          if (index === items.length) {
            index += 1;
            return Promise.resolve({
              done: false,
              value: {
                type: "response.web_search_call.in_progress",
                item_id: "web-4",
                output_index: index,
                sequence_number: index + 1,
              } as unknown as ResponseStreamEvent,
            });
          }
          return new Promise<IteratorResult<ResponseStreamEvent>>(() => {});
        },
        return: () => new Promise<IteratorResult<ResponseStreamEvent>>(() => {}),
      };
    },
  };
}

function stalledWebAction(callId: string): AsyncIterable<ResponseStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      let emitted = false;
      return {
        next(): Promise<IteratorResult<ResponseStreamEvent>> {
          if (!emitted) {
            emitted = true;
            return Promise.resolve({
              done: false,
              value: {
                type: "response.web_search_call.in_progress",
                item_id: callId,
                output_index: 0,
                sequence_number: 1,
              } as unknown as ResponseStreamEvent,
            });
          }
          return new Promise<IteratorResult<ResponseStreamEvent>>(() => {});
        },
        return: () => new Promise<IteratorResult<ResponseStreamEvent>>(() => {}),
      };
    },
  };
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

function assistantOutput(id: string, text: string): Record<string, unknown> {
  return {
    type: "message", id, status: "completed", role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
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
