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

test("maps a hosted web search to one safe lifecycle without query or URL", () => {
  const { port, calls } = progressLog();
  const progress = new ResponsesTelegramProgress(port);

  progress.startThinking("response-1");
  progress.startWeb({ itemId: "ws-1", action: "search" });
  progress.startWeb({ itemId: "ws-1", action: "search" });
  progress.completeWeb("ws-1");

  assert.deepEqual(calls, [
    "thinking:start:responses:thinking:response-1",
    "thinking:done:true:responses:thinking:response-1",
    "tool:start:responses:web:ws-1:веб-поиск",
    "tool:done:true:responses:web:ws-1:веб-поиск",
  ]);
  assert.doesNotMatch(calls.join("\n"), /query|https?:\/\//u);
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
    "tool:start:responses:web:ws-1:веб-поиск",
    "tool:done:true:responses:web:ws-1:веб-поиск",
  ]);
});

test("maps hosted open and find calls to bounded Russian labels", () => {
  const { port, calls } = progressLog();
  const progress = new ResponsesTelegramProgress(port);

  progress.startWeb({ itemId: "open-1", action: "open_page" });
  progress.startWeb({ itemId: "find-1", action: "find_in_page" });
  progress.completeWeb("open-1");
  progress.completeWeb("find-1", false);

  assert.deepEqual(calls, [
    "tool:start:responses:web:open-1:открываю страницу",
    "tool:start:responses:web:find-1:ищу на странице",
    "tool:done:true:responses:web:open-1:открываю страницу",
    "tool:done:false:responses:web:find-1:ищу на странице",
  ]);
});

test("updates one hosted call when the stream resolves search into page open", () => {
  const { port, calls } = progressLog();
  const progress = new ResponsesTelegramProgress(port);

  progress.startWeb({ itemId: "web-1", action: "search" });
  progress.startWeb({ itemId: "web-1", action: "open_page" });
  progress.completeWeb("web-1");

  assert.deepEqual(calls, [
    "tool:start:responses:web:web-1:веб-поиск",
    "tool:start:responses:web:web-1:открываю страницу",
    "tool:done:true:responses:web:web-1:открываю страницу",
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
  });
  progress.completeValidatedLocalTool("local-1", true);

  assert.deepEqual(calls, [
    "tool:start:responses:function:local-1:ищу сообщения",
    "tool:done:true:responses:function:local-1:ищу сообщения",
  ]);
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
    "tool:start:responses:image:input-1:подготавливаю изображение",
    "tool:done:true:responses:image:input-1:подготавливаю изображение",
    "tool:start:responses:image:view-1:просматриваю изображение",
    "tool:done:true:responses:image:view-1:просматриваю изображение",
    "tool:start:responses:image:gen-1:генерирую изображение",
    "tool:done:false:responses:image:gen-1:генерирую изображение",
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
    "tool:start:responses:web:ws-2:веб-поиск",
    "tool:start:responses:function:local-2:читаю ветку",
    "tool:done:false:responses:web:ws-2:веб-поиск",
    "tool:done:false:responses:function:local-2:читаю ветку",
  ]);
});
