import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderProgressText,
  ToolProgressPublisher,
  type ToolProgressBotApiPort,
  type ToolProgressStore,
} from "../src/bot/tool-progress.js";

type PortCall =
  | { kind: "send"; chatId: string; text: string; signal: AbortSignal }
  | { kind: "edit"; chatId: string; messageId: number; text: string; signal: AbortSignal }
  | { kind: "delete"; chatId: string; messageId: number; signal: AbortSignal };

function fakePort(
  overrides: Partial<ToolProgressBotApiPort> = {},
): ToolProgressBotApiPort & { calls: PortCall[] } {
  const calls: PortCall[] = [];
  return {
    async sendMessage(chatId, text, signal) {
      calls.push({ kind: "send", chatId, text, signal });
      return overrides.sendMessage?.(chatId, text, signal) ?? { ok: true, messageId: 1 };
    },
    async editMessageText(chatId, messageId, text, signal) {
      calls.push({ kind: "edit", chatId, messageId, text, signal });
      return overrides.editMessageText?.(chatId, messageId, text, signal) ?? { ok: true };
    },
    async deleteMessage(chatId, messageId, signal) {
      calls.push({ kind: "delete", chatId, messageId, signal });
      return overrides.deleteMessage?.(chatId, messageId, signal) ?? { ok: true };
    },
    calls,
  };
}

function fakeStore(): ToolProgressStore & { states: Array<{ turnId: number; workerId: string; progress: { messageId?: number; state?: string }; nowMs?: number }> } {
  const states: Array<{ turnId: number; workerId: string; progress: { messageId?: number; state?: string }; nowMs?: number }> = [];
  return {
    saveBotTurnProgress(turnId, workerId, progress, nowMs) {
      states.push({ turnId, workerId, progress, nowMs });
      return true;
    },
    clearBotTurnProgress(turnId, nowMs) {
      states.push({ turnId, workerId: "", progress: {}, nowMs });
      return true;
    },
    states,
  };
}

function makePublisher(options: {
  port?: ToolProgressBotApiPort;
  store?: ToolProgressStore;
  initialMessageId?: number;
  signal?: AbortSignal;
}) {
  const controller = new AbortController();
  return {
    controller,
    publisher: new ToolProgressPublisher({
      turnId: 7,
      workerId: "w1",
      chatId: "-1004242",
      signal: options.signal ?? controller.signal,
      botApi: options.port ?? fakePort(),
      store: options.store ?? fakeStore(),
      initialMessageId: options.initialMessageId,
      now: () => 1_000,
    }),
  };
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("sends a progress message on the first tool start", async () => {
  const port = fakePort();
  const store = fakeStore();
  const { publisher } = makePublisher({ port, store });

  publisher.onToolStarted({ toolName: "rag_bm25_search", callId: "c1" });
  await drain();
  await publisher.finish(new AbortController().signal);

  assert.equal(port.calls.length, 2);
  assert.equal(port.calls[0].kind, "send");
  assert.equal(port.calls[0].chatId, "-1004242");
  assert.equal(port.calls[0].text, "⏳ rag_bm25_search");
  assert.ok(port.calls[0].signal instanceof AbortSignal);
  assert.equal(port.calls[1].kind, "delete");
  assert.equal(store.states.length, 3);
  assert.equal(store.states[0]?.progress.state, "dispatching");
  assert.equal(store.states[1]?.progress.state, "active");
});

test("edits the existing message as tools complete", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "rag_bm25_search", callId: "c1" });
  await drain();
  publisher.onToolCompleted({ toolName: "rag_bm25_search", callId: "c1" }, true);
  await drain();
  await publisher.finish(new AbortController().signal);

  const texts = port.calls
    .filter((call) => call.kind === "send" || call.kind === "edit")
    .map((call) => call.text);
  assert.deepEqual(texts, ["⏳ rag_bm25_search", "✓ rag_bm25_search"]);
});

test("shows thinking as a separate safe status before a tool call", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onThinkingStarted({ callId: "thinking-1" });
  await drain();
  publisher.onThinkingCompleted({ callId: "thinking-1" }, true);
  publisher.onToolStarted({ toolName: "web_search", callId: "search-1" });
  await drain();
  await publisher.finish(new AbortController().signal);

  const texts = port.calls
    .filter((call) => call.kind === "send" || call.kind === "edit")
    .map((call) => call.text);
  assert.deepEqual(texts, [
    "🧠 thinking",
    "✓ thinking\n⏳ web_search",
  ]);
});

test("uses error icon for failed tools", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "web_search", callId: "c1" });
  await drain();
  publisher.onToolCompleted({ toolName: "web_search", callId: "c1" }, false);
  await drain();
  await publisher.finish(new AbortController().signal);

  const edit = port.calls.find((call) => call.kind === "edit");
  assert.equal(edit?.text, "✗ web_search");
});

test("shows an allowlisted query and clamps it to three lines", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({
    toolName: "web_search",
    callId: "c1",
    input: { query: "q".repeat(400) },
  });
  await drain();
  publisher.onToolCompleted({ toolName: "web_search", callId: "c1" }, true);
  await drain();
  await publisher.finish(new AbortController().signal);

  const texts = port.calls
    .filter((call) => call.kind === "send" || call.kind === "edit")
    .map((call) => call.text);
  const first = String(texts[0]);
  const lines = first.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "⏳ web_search");
  assert.match(lines[1] ?? "", /^  запрос: q+/);
  assert.match(lines[3] ?? "", /…$/);
  assert.match(String(texts[1]), /^✓ web_search\n  запрос:/);
});

test("shows a static_page_fetch page selector without leaking its query string", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({
    toolName: "static_page_fetch",
    callId: "c1",
    input: { url: "https://example.com/article?access_token=do-not-show" },
  });
  await drain();
  await publisher.finish(new AbortController().signal);

  const sent = port.calls.find((call) => call.kind === "send");
  assert.equal(
    sent?.text,
    "⏳ static_page_fetch\n  страница: https://example.com/article",
  );
  assert.doesNotMatch(String(sent?.text), /access_token|do-not-show/u);
});

test("research lookup hides its raw selector from the visible timeline", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({
    toolName: "research_lookup",
    callId: "c1",
    input: { query: "Иван Иванов phone +7 999 123-45-67" },
  });
  await drain();
  await publisher.finish(new AbortController().signal);

  const sent = port.calls.find((call) => call.kind === "send");
  assert.equal(
    sent?.text,
    "⏳ research_lookup\n  корпус: обезличенные HH-исследования",
  );
  assert.doesNotMatch(String(sent?.text), /Иван|999|123/u);
});

test("audio transcription shows only the safe addressed-media selector", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({
    toolName: "audio_transcribe",
    callId: "audio-1",
    input: {
      source: "reply",
      file_id: "never-display-this",
      transcript: "и это тоже никогда не должно попасть в progress",
    },
  });
  await drain();
  await publisher.finish(new AbortController().signal);

  const sent = port.calls.find((call) => call.kind === "send");
  assert.equal(
    sent?.text,
    "⏳ audio_transcribe\n  аудио: прямой реплай",
  );
  assert.doesNotMatch(String(sent?.text), /file_id|never-display|тоже никогда/u);
});

test("recovers a stale message from a previous attempt", async () => {
  const port = fakePort();
  const store = fakeStore();
  const { publisher } = makePublisher({ port, store, initialMessageId: 42 });

  await publisher.recoverPrevious(new AbortController().signal);

  const deleteCall = port.calls.find((call) => call.kind === "delete");
  assert.equal(deleteCall?.messageId, 42);
  assert.ok(store.states.some((s) => s.turnId === 7 && s.progress.state === undefined));
});

test("survives send/edit/delete failures without throwing", async () => {
  const port = fakePort({
    sendMessage: async () => ({ ok: false }),
    editMessageText: async () => ({ ok: false }),
    deleteMessage: async () => ({ ok: false }),
  });
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "day_digest", callId: "c1" });
  await drain();
  publisher.onToolCompleted({ toolName: "day_digest", callId: "c1" }, true);
  await drain();
  await publisher.finish(new AbortController().signal);

  assert.equal(port.calls.length, 2);
  assert.equal(port.calls[0].kind, "send");
  assert.equal(port.calls[1].kind, "send");
  assert.equal(publisher.state, "none");
});

test("renderProgressText joins statuses and truncates", () => {
  const pending = new Map([
    ["a", { kind: "tool" as const, toolName: "rag_bm25_search", state: "running" as const }],
    ["b", { kind: "tool" as const, toolName: "web_search", state: "ok" as const }],
    ["c", { kind: "tool" as const, toolName: "day_digest", state: "error" as const }],
  ]);
  assert.equal(
    renderProgressText(pending, 100),
    "⏳ rag_bm25_search\n✓ web_search\n✗ day_digest",
  );

  const long = new Map([["x", { kind: "tool" as const, toolName: "very_long_tool_name", state: "running" as const }]]);
  const rendered = renderProgressText(long, 10);
  assert.equal(rendered.length, 10);
  assert.equal(rendered.at(-1), "…");
});
