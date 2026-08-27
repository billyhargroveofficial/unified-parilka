import assert from "node:assert/strict";
import test from "node:test";
import {
  ResponsesTelegramProgress,
  type ValidatedLocalToolDispatch,
} from "../src/bot/responses-telegram/index.js";
import type { ToolProgressPort } from "../src/bot/tool-progress.js";

function progressLog(): { port: ToolProgressPort; calls: string[] } {
  const calls: string[] = [];
  return {
    port: {
      onThinkingStarted: ({ callId }) => { calls.push(`thinking:start:${callId}`); },
      onThinkingCompleted: ({ callId }, ok) => { calls.push(`thinking:done:${ok}:${callId}`); },
      onToolStarted: ({ callId, toolName }) => { calls.push(`tool:start:${callId}:${toolName}`); },
      onToolCompleted: ({ callId, toolName }, ok) => { calls.push(`tool:done:${ok}:${callId}:${toolName}`); },
    },
    calls,
  };
}

test("maps a hosted web search and its bounded selector to one lifecycle", () => {
  const { port, calls } = progressLog();
  const started: Array<Parameters<ToolProgressPort["onToolStarted"]>[0]> = [];
  const progress = new ResponsesTelegramProgress({
    ...port,
    onToolStarted(event) {
      started.push(event);
      return port.onToolStarted(event);
    },
  });

  progress.startThinking("response-1");
  progress.startWeb({
    itemId: "ws-1",
    action: "search",
    input: { query: "Elden Ring VR mod" },
  });
  progress.startWeb({
    itemId: "ws-1",
    action: "search",
    input: { query: "Elden Ring VR mod" },
  });
  progress.completeWeb("ws-1");

  assert.deepEqual(calls, [
    "thinking:start:responses:thinking:response-1",
    "thinking:done:true:responses:thinking:response-1",
    "tool:start:responses:web:ws-1:web_search",
    "tool:done:true:responses:web:ws-1:web_search",
  ]);
  assert.deepEqual(started, [{
    callId: "responses:web:ws-1",
    toolName: "web_search",
    toolId: "hosted_web",
    input: { query: "Elden Ring VR mod" },
  }]);
});

test("does not render repeated thinking lifecycles after tool execution begins", () => {
  const { port, calls } = progressLog();
  const progress = new ResponsesTelegramProgress(port);

  progress.startThinking("initial");
  progress.startWeb({ itemId: "ws-1", action: "search" });
  progress.completeWeb("ws-1");
  progress.startThinking("continuation-1");
  progress.completeThinking(true);
  progress.startThinking("continuation-2");
  progress.completeOutstanding(true);

  assert.deepEqual(calls, [
    "thinking:start:responses:thinking:initial",
    "thinking:done:true:responses:thinking:initial",
    "tool:start:responses:web:ws-1:web_search",
    "tool:done:true:responses:web:ws-1:web_search",
  ]);
});

test("maps hosted open and find calls to canonical English labels", () => {
  const { port, calls } = progressLog();
  const progress = new ResponsesTelegramProgress(port);

  progress.startWeb({ itemId: "open-1", action: "open_page" });
  progress.startWeb({ itemId: "find-1", action: "find_in_page" });
  progress.completeWeb("open-1");
  progress.completeWeb("find-1", false);

  assert.deepEqual(calls, [
    "tool:start:responses:web:open-1:web_fetch",
    "tool:start:responses:web:find-1:find_in_page",
    "tool:done:true:responses:web:open-1:web_fetch",
    "tool:done:false:responses:web:find-1:find_in_page",
  ]);
});

test("updates one hosted call when the stream resolves search into page open", () => {
  const { port, calls } = progressLog();
  const progress = new ResponsesTelegramProgress(port);

  progress.startWeb({ itemId: "web-1", action: "search" });
  progress.startWeb({ itemId: "web-1", action: "open_page" });
  progress.completeWeb("web-1");

  assert.deepEqual(calls, [
    "tool:start:responses:web:web-1:web_search",
    "tool:start:responses:web:web-1:web_fetch",
    "tool:done:true:responses:web:web-1:web_fetch",
  ]);
});

test("starts local progress only after an accepted validated dispatch", () => {
  const { port, calls } = progressLog();
  const progress = new ResponsesTelegramProgress(port);

  progress.startValidatedLocalTool({
    callId: "untrusted-call",
    toolName: "keyword_search",
    validation: "rejected",
  } as unknown as ValidatedLocalToolDispatch);
  progress.startValidatedLocalTool({
    callId: "bad-name",
    toolName: "not-a-tool",
    validation: "accepted",
  } as unknown as ValidatedLocalToolDispatch);
  progress.startValidatedLocalTool({
    callId: "local-1",
    toolName: "keyword_search",
    validation: "accepted",
    input: { query: "баня", match: "all", limit: 10 },
  });
  progress.completeValidatedLocalTool("local-1", true);

  assert.deepEqual(calls, [
    "tool:start:responses:function:local-1:keyword_search",
    "tool:done:true:responses:function:local-1:keyword_search",
  ]);
});

test("renders a validated skill read as its own canonical tool lifecycle", () => {
  const { port, calls } = progressLog();
  const started: Array<Parameters<ToolProgressPort["onToolStarted"]>[0]> = [];
  const progress = new ResponsesTelegramProgress({
    ...port,
    onToolStarted(event) {
      started.push(event);
      return port.onToolStarted(event);
    },
  });

  progress.startValidatedLocalTool({
    callId: "skill-1",
    toolName: "load_chat_skill",
    validation: "accepted",
    input: { name: "reply-style" },
  });
  progress.completeValidatedLocalTool("skill-1", true);

  assert.deepEqual(calls, [
    "tool:start:responses:function:skill-1:load_chat_skill",
    "tool:done:true:responses:function:skill-1:load_chat_skill",
  ]);
  assert.deepEqual(started[0]?.input, { name: "reply-style" });
});

test("maps image input, inspection, and generation without image data", () => {
  const { port, calls } = progressLog();
  const progress = new ResponsesTelegramProgress(port);

  progress.startImage({ itemId: "input-1", kind: "input" });
  progress.completeImage("input-1");
  progress.startImage({ itemId: "view-1", kind: "view" });
  progress.completeImage("view-1");
  progress.startImage({ itemId: "gen-1", kind: "generation" });
  progress.completeImage("gen-1", false);

  assert.deepEqual(calls, [
    "tool:start:responses:image:input-1:input_image",
    "tool:done:true:responses:image:input-1:input_image",
    "tool:start:responses:image:view-1:view_image",
    "tool:done:true:responses:image:view-1:view_image",
    "tool:start:responses:image:gen-1:image_generation",
    "tool:done:false:responses:image:gen-1:image_generation",
  ]);
  assert.doesNotMatch(calls.join("\n"), /base64|file_id|image_url/u);
});

test("finishes outstanding work exactly once on terminal failure", () => {
  const { port, calls } = progressLog();
  const progress = new ResponsesTelegramProgress(port);

  progress.startThinking("response-2");
  progress.startWeb({ itemId: "ws-2", action: "search" });
  progress.startValidatedLocalTool({
    callId: "local-2",
    toolName: "thread_context",
    validation: "accepted",
  });
  progress.completeOutstanding(false);
  progress.completeOutstanding(false);

  assert.deepEqual(calls, [
    "thinking:start:responses:thinking:response-2",
    "thinking:done:true:responses:thinking:response-2",
    "tool:start:responses:web:ws-2:web_search",
    "tool:start:responses:function:local-2:thread_context",
    "tool:done:false:responses:web:ws-2:web_search",
    "tool:done:false:responses:function:local-2:thread_context",
  ]);
});
