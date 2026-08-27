import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolProgressPublisher,
  type ToolProgressBotApiPort,
  type ToolProgressEvent,
} from "../src/bot/tool-progress.js";
import { ResponsesTelegramProgress } from "../src/bot/responses-telegram/index.js";

async function renderFirstRow(event: ToolProgressEvent): Promise<string> {
  let visible = "";
  const publisher = new ToolProgressPublisher({
    turnId: 2,
    workerId: "worker",
    chatId: "-1001",
    signal: new AbortController().signal,
    botApi: {
      async sendMessage(_chatId, text) {
        visible = text;
        return { ok: true, messageId: 2 };
      },
      async editMessageText() { return { ok: true }; },
      async deleteMessage() { return { ok: true }; },
    },
    store: {
      saveBotTurnProgress() { return true; },
      clearBotTurnProgress() { return true; },
    },
    minVisibleMs: 0,
  });
  publisher.onToolStarted(event);
  await drainProgressQueue();
  await publisher.finish(new AbortController().signal);
  return visible;
}

test("one progress message accumulates one compact English row per tool", async () => {
  const texts: string[] = [];
  let deletes = 0;
  const port: ToolProgressBotApiPort = {
    async sendMessage(_chatId, text) {
      texts.push(text);
      return { ok: true, messageId: 1 };
    },
    async editMessageText(_chatId, _messageId, text) {
      texts.push(text);
      return { ok: true };
    },
    async deleteMessage() {
      deletes += 1;
      return { ok: true };
    },
  };
  const publisher = new ToolProgressPublisher({
    turnId: 1,
    workerId: "worker",
    chatId: "-1001",
    signal: new AbortController().signal,
    botApi: port,
    store: {
      saveBotTurnProgress() { return true; },
      clearBotTurnProgress() { return true; },
    },
    minVisibleMs: 0,
  });

  publisher.onToolStarted({
    toolName: "web_search",
    toolId: "hosted_web",
    callId: "web-1",
    input: { query: "Elden Ring VR mod" },
  });
  await drainProgressQueue();
  publisher.onToolCompleted({
    toolName: "web_search",
    toolId: "hosted_web",
    callId: "web-1",
  }, true);
  publisher.onToolStarted({
    toolName: "web_fetch",
    toolId: "hosted_web",
    callId: "web-2",
    input: { url: "https://user:secret@example.com/docs/page?token=private#fragment" },
  });
  await drainProgressQueue();
  publisher.onToolCompleted({
    toolName: "web_fetch",
    toolId: "hosted_web",
    callId: "web-2",
  }, true);
  publisher.onToolStarted({
    toolName: "load_chat_skill",
    toolId: "load_chat_skill",
    callId: "skill-1",
    input: { name: "reply-style" },
  });
  await Promise.resolve();
  await Promise.resolve();
  await publisher.finish(new AbortController().signal);

  assert.equal(texts[0], "⏳ web_search ×1 · Elden Ring VR mod");
  assert.equal(
    texts[1],
    "✓ web_search ×1 · Elden Ring VR mod\n⏳ web_fetch ×1 · example.com/docs/page",
  );
  assert.equal(texts[1]?.split("\n").length, 2);
  assert.equal(
    texts[2],
    "✓ web_search ×1 · Elden Ring VR mod\n✓ web_fetch ×1 · example.com/docs/page\n⏳ load_chat_skill · reply-style",
  );
  assert.equal(texts[2]?.split("\n").length, 3);
  assert.doesNotMatch(texts[1] ?? "", /secret|token|private|fragment/u);
  assert.equal(deletes, 1);
});

test("every visible tool argument is value-only with no redundant key prefix", async () => {
  const cases: Array<{ event: ToolProgressEvent; expected: string }> = [
    {
      event: { toolName: "keyword_search", callId: "1", input: { query: "точная фраза" } },
      expected: "⏳ keyword_search · точная фраза",
    },
    {
      event: { toolName: "day_digest", callId: "2", input: { day_from: "2026-08-26", day_to: "2026-08-27" } },
      expected: "⏳ day_digest · 2026-08-26..2026-08-27",
    },
    {
      event: { toolName: "read_chat_slice", callId: "3", input: { mode: "recent", count: 50 } },
      expected: "⏳ read_chat_slice · 50",
    },
    {
      event: { toolName: "read_chat_slice", callId: "4", input: { mode: "recent", cursor: "opaque" } },
      expected: "⏳ read_chat_slice · next",
    },
    {
      event: { toolName: "thread_context", callId: "5", input: { message_id: 228 } },
      expected: "⏳ thread_context · #228",
    },
    {
      event: { toolName: "find_in_page", toolId: "hosted_web", callId: "6", input: { pattern: "cooling system" } },
      expected: "⏳ find_in_page ×1 · cooling system",
    },
  ];
  for (const item of cases) {
    const visible = await renderFirstRow(item.event);
    assert.equal(visible, item.expected);
    assert.doesNotMatch(
      visible,
      /\b(?:query|url|pattern|name|message_id|day_from|count|mode|cursor)=/u,
    );
    assert.ok(Array.from(visible).length <= 48);
  }
});

test("hosted web batches aggregate, relabel, and fail without duplicate rows", async () => {
  const texts: string[] = [];
  const publisher = new ToolProgressPublisher({
    turnId: 3,
    workerId: "worker",
    chatId: "-1001",
    signal: new AbortController().signal,
    botApi: {
      async sendMessage(_chatId, text) {
        texts.push(text);
        return { ok: true, messageId: 3 };
      },
      async editMessageText(_chatId, _messageId, text) {
        texts.push(text);
        return { ok: true };
      },
      async deleteMessage() { return { ok: true }; },
    },
    store: {
      saveBotTurnProgress() { return true; },
      clearBotTurnProgress() { return true; },
    },
    minVisibleMs: 0,
  });
  const progress = new ResponsesTelegramProgress(publisher);

  progress.startWeb({ itemId: "a", action: "search", batchSize: 3, input: { query: "first" } });
  progress.startWeb({ itemId: "b", action: "search", input: { query: "second" } });
  await drainProgressQueue();
  assert.equal(texts.at(-1), "⏳ web_search ×4 · first");

  // The first provider item is resolved after its initial generic lifecycle:
  // move its entire batched count to `web_fetch`, not a third duplicate row.
  progress.startWeb({ itemId: "a", action: "open_page", batchSize: 3, input: { url: "https://example.com/page" } });
  await drainProgressQueue();
  assert.equal(
    texts.at(-1),
    "⏳ web_fetch ×3 · example.com/page\n⏳ web_search ×1 · second",
  );

  progress.completeOutstanding(false);
  await drainProgressQueue();
  assert.equal(
    texts.at(-1),
    "✗ web_fetch ×3 · example.com/page\n✗ web_search ×1 · second",
  );
  await publisher.finish(new AbortController().signal);
});

async function drainProgressQueue(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}
