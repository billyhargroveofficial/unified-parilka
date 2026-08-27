import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import {
  OpenAiResponsesTurnClient,
  type ResponsesCreateRequest,
  type ResponsesProgressEvent,
  type ResponsesStreamTransport,
} from "../src/openai-responses/index.js";
import { ResponsesTelegramProgress } from "../src/bot/responses-telegram/index.js";
import type { ToolProgressEvent, ToolProgressPort } from "../src/bot/tool-progress.js";

test("terminal-only hosted web records render safe Telegram search/open/find lifecycles", async () => {
  const visible: string[] = [];
  const started: ToolProgressEvent[] = [];
  const progress = new ResponsesTelegramProgress({
    onThinkingStarted: ({ callId }) => { visible.push(`thinking:start:${callId}`); },
    onThinkingCompleted: ({ callId }, ok) => { visible.push(`thinking:done:${String(ok)}:${callId}`); },
    onToolStarted: (event) => {
      started.push(event);
      visible.push(`tool:start:${event.callId}:${event.toolName}`);
    },
    onToolCompleted: ({ callId, toolName }, ok) => { visible.push(`tool:done:${String(ok)}:${callId}:${toolName}`); },
  } satisfies ToolProgressPort);
  const client = new OpenAiResponsesTurnClient(new TerminalOnlyTransport());

  await client.run({
    text: "Проверь", instructions: "x", effort: "low", localFunctions: [],
    dispatcher: { async dispatch() { throw new Error("not called"); } },
    progress: { onProgress: (event) => project(event, progress) },
  });

  assert.match(visible[0] ?? "", /^thinking:start:responses:thinking:thinking:[A-Za-z0-9-]+$/u);
  assert.match(visible[1] ?? "", /^thinking:done:true:responses:thinking:thinking:[A-Za-z0-9-]+$/u);
  assert.deepEqual(visible.slice(2), [
    "tool:start:responses:web:terminal-search:web_search",
    "tool:done:true:responses:web:terminal-search:web_search",
    "tool:start:responses:web:terminal-open:web_fetch",
    "tool:done:true:responses:web:terminal-open:web_fetch",
    "tool:start:responses:web:terminal-find:find_in_page",
    "tool:done:true:responses:web:terminal-find:find_in_page",
  ]);
  assert.deepEqual(started.map(({ toolName, toolId, input }) => ({ toolName, toolId, input })), [
    { toolName: "web_search", toolId: "hosted_web", input: { query: "private query" } },
    { toolName: "web_fetch", toolId: "hosted_web", input: { url: "https://private.example" } },
    {
      toolName: "find_in_page",
      toolId: "hosted_web",
      input: { pattern: "needle", url: "https://private.example" },
    },
  ]);
});

test("late subscription action metadata renders search/open/find instead of three searches", async () => {
  const visible: string[] = [];
  const progress = new ResponsesTelegramProgress({
    onThinkingStarted() {},
    onThinkingCompleted() {},
    onToolStarted: ({ toolName }) => { visible.push(`start:${toolName}`); },
    onToolCompleted: ({ toolName }, ok) => { visible.push(`done:${toolName}:${String(ok)}`); },
  });
  const output = [
    webRecord("search", "search"),
    webRecord("open", "open_page"),
    webRecord("find", "find_in_page"),
  ];
  const stream: ResponseStreamEvent[] = [];
  for (const item of output) {
    stream.push(
      webEvent("response.output_item.added", item, false),
      webLifecycle("response.web_search_call.in_progress", item.id),
      webLifecycle("response.web_search_call.searching", item.id),
      webLifecycle("response.web_search_call.completed", item.id),
      webEvent("response.output_item.done", item, true),
    );
  }
  stream.push({
    type: "response.completed", sequence_number: 99,
    response: {
      id: "resp-late-actions", model: "gpt-5.6-luna", status: "completed",
      service_tier: "priority", output_text: "Готово",
      output: [...output, {
        type: "message", id: "msg-late", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "Готово", annotations: [] }],
      }],
    },
  } as unknown as ResponseStreamEvent);

  await new OpenAiResponsesTurnClient({
    async create() { return events(...stream); },
  }).run({
    text: "Проверь", instructions: "x", effort: "low", localFunctions: [],
    dispatcher: { async dispatch() { throw new Error("not called"); } },
    progress: { onProgress: (event) => project(event, progress) },
  });

  assert.ok(visible.includes("start:web_search"));
  assert.ok(visible.includes("start:web_fetch"));
  assert.ok(visible.includes("start:find_in_page"));
  assert.equal(visible.filter((entry) => entry === "start:web_search").length, 3);
});

class TerminalOnlyTransport implements ResponsesStreamTransport {
  async create(_request: ResponsesCreateRequest): Promise<AsyncIterable<ResponseStreamEvent>> {
    return events({
      type: "response.completed",
      sequence_number: 1,
      response: {
        id: "resp-terminal-web",
        model: "gpt-5.6-luna",
        status: "completed",
        service_tier: "priority",
        output_text: "Готово",
        output: [
          { type: "web_search_call", id: "terminal-search", action: { type: "search", queries: ["private query"] }, status: "completed" },
          { type: "web_search_call", id: "terminal-open", action: { type: "open_page", url: "https://private.example" }, status: "completed" },
          { type: "web_search_call", id: "terminal-find", action: { type: "find_in_page", pattern: "needle", url: "https://private.example" }, status: "completed" },
          { type: "message", id: "msg-1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Готово", annotations: [] }] },
        ],
      },
    } as unknown as ResponseStreamEvent);
  }
}

function webRecord(id: string, action: "search" | "open_page" | "find_in_page") {
  return { type: "web_search_call", id, action: { type: action }, status: "completed" };
}

function webLifecycle(type: string, itemId: string): ResponseStreamEvent {
  return { type, item_id: itemId, output_index: 0, sequence_number: 1 } as unknown as ResponseStreamEvent;
}

function webEvent(type: string, item: ReturnType<typeof webRecord>, done: boolean): ResponseStreamEvent {
  return {
    type, output_index: 0, sequence_number: 1,
    item: done ? item : { ...item, action: undefined, status: "in_progress" },
  } as unknown as ResponseStreamEvent;
}

async function* events(...items: ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> {
  yield* items;
}

function project(event: ResponsesProgressEvent, progress: ResponsesTelegramProgress): void {
  switch (event.type) {
    case "thinking_started": progress.startThinking(event.callId); break;
    case "thinking_completed": progress.completeThinking(event.ok); break;
    case "hosted_web_started": progress.startWeb({
      itemId: event.callId,
      action: event.action ?? "search",
      ...(event.input === undefined ? {} : { input: { ...event.input } }),
    }); break;
    case "hosted_web_action": progress.startWeb({
      itemId: event.callId,
      action: event.action,
      ...(event.input === undefined ? {} : { input: { ...event.input } }),
    }); break;
    case "hosted_web_completed": progress.completeWeb(event.callId, event.ok); break;
    case "local_function_started":
    case "local_function_completed":
      break;
  }
}
