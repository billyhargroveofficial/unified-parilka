import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PROGRESS_MIN_VISIBLE_MS,
  renderProgressText,
  ToolProgressPublisher,
  type ToolProgressScheduler,
  type ToolProgressBotApiPort,
  type ToolProgressStore,
} from "../src/bot/tool-progress.js";
type PortCall = { kind: "send"; chatId: string; text: string; signal: AbortSignal }
  | { kind: "edit"; chatId: string; messageId: number; text: string; signal: AbortSignal }
  | { kind: "delete"; chatId: string; messageId: number; signal: AbortSignal };

function fakePort(overrides: Partial<ToolProgressBotApiPort> = {}): ToolProgressBotApiPort & { calls: PortCall[] } {
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
  minVisibleMs?: number;
  operationTimeoutMs?: number;
  now?: () => number;
  scheduler?: ToolProgressScheduler;
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
      minVisibleMs: options.minVisibleMs ?? 0,
      operationTimeoutMs: options.operationTimeoutMs,
      now: options.now ?? (() => 1_000),
      scheduler: options.scheduler,
    }),
  };
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

test("keeps a fast progress bubble visible for the bounded minimum dwell", async () => {
  const port = fakePort();
  const clock = manualClock();
  const { publisher } = makePublisher({
    port,
    minVisibleMs: DEFAULT_PROGRESS_MIN_VISIBLE_MS,
    now: clock.now,
    scheduler: clock.scheduler,
  });

  publisher.onThinkingStarted({ callId: "fast-thinking" });
  await drain();
  const finish = publisher.finish(new AbortController().signal);
  await drain();
  assert.deepEqual(port.calls.map((call) => call.kind), ["send"]);

  clock.advance(DEFAULT_PROGRESS_MIN_VISIBLE_MS - 1);
  await drain();
  assert.deepEqual(port.calls.map((call) => call.kind), ["send"]);

  clock.advance(1);
  await finish;
  assert.deepEqual(port.calls.map((call) => call.kind), ["send", "delete"]);
});

test("keeps a late tool-use edit visible before terminal deletion", async () => {
  const port = fakePort();
  const clock = manualClock();
  const { publisher } = makePublisher({
    port, minVisibleMs: DEFAULT_PROGRESS_MIN_VISIBLE_MS,
    now: clock.now, scheduler: clock.scheduler,
  });
  publisher.onThinkingStarted({ callId: "thinking" });
  await drain();
  clock.advance(DEFAULT_PROGRESS_MIN_VISIBLE_MS);
  publisher.onThinkingCompleted({ callId: "thinking" }, true);
  publisher.onToolStarted({ toolName: "web search", callId: "web" });
  await drain();
  const finish = publisher.finish(new AbortController().signal);
  await drain();
  assert.equal(port.calls.some((call) => call.kind === "delete"), false);
  clock.advance(DEFAULT_PROGRESS_MIN_VISIBLE_MS);
  await finish;
  assert.equal(port.calls.at(-1)?.kind, "delete");
});

test("folds successful completion into the next tool-start edit", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "rag_bm25_search", callId: "c1" });
  await drain();
  publisher.onToolCompleted({ toolName: "rag_bm25_search", callId: "c1" }, true);
  await drain();
  publisher.onToolStarted({ toolName: "read_chat_slice", callId: "c2" });
  await drain();
  await publisher.finish(new AbortController().signal);

  const texts = port.calls
    .filter((call) => call.kind === "send" || call.kind === "edit")
    .map((call) => call.text);
  assert.deepEqual(texts, [
    "⏳ rag_bm25_search",
    "✓ rag_bm25_search\n⏳ read_chat_slice",
  ]);
});

test("terminal cleanup freezes late tool events and deletes the one visible bubble", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "keyword_search", callId: "first" });
  await drain();
  const finish = publisher.finish(new AbortController().signal);
  publisher.onToolCompleted({ toolName: "keyword_search", callId: "first" }, true);
  publisher.onToolStarted({ toolName: "read_chat_slice", callId: "late" });
  await finish;
  await drain();

  assert.deepEqual(
    port.calls.map((call) => call.kind),
    ["send", "delete"],
  );
  assert.equal(publisher.state, "none");
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
    "⏳ web_search",
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

test("shows an allowlisted tool selector in one compact line", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({
    toolName: "keyword_search",
    callId: "c1",
    input: { query: "q".repeat(400) },
  });
  await drain();
  publisher.onToolCompleted({ toolName: "keyword_search", callId: "c1" }, true);
  await drain();
  await publisher.finish(new AbortController().signal);

  const texts = port.calls
    .filter((call) => call.kind === "send" || call.kind === "edit")
    .map((call) => call.text);
  const first = String(texts[0]);
  assert.equal(first.includes("\n"), false);
  assert.match(first, /^⏳ keyword_search · q+/u);
  assert.match(first, /…$/u);
  assert.ok(Array.from(first).length <= 48);
  assert.equal(texts.length, 1);
});

test("never projects arguments for a native hosted tool", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({
    toolName: "web search",
    callId: "c1",
    input: { query: "private selector that must remain on the server" },
  });
  await drain();
  await publisher.finish(new AbortController().signal);

  const sent = port.calls.find((call) => call.kind === "send");
  assert.equal(sent?.text, "⏳ web search");
  assert.doesNotMatch(String(sent?.text), /private selector|on the server/u);
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

test("keeps the stale-progress fence when recovery delete fails", async () => {
  const port = fakePort({ deleteMessage: async () => ({ ok: false }) });
  const store = fakeStore();
  const { publisher } = makePublisher({ port, store, initialMessageId: 42 });

  await publisher.recoverPrevious(new AbortController().signal);

  assert.equal(publisher.messageId, 42);
  assert.equal(publisher.state, "unknown");
  assert.deepEqual(store.states.at(-1)?.progress, {
    messageId: 42,
    state: "unknown",
  });
  assert.equal(store.states.some((state) => state.workerId === ""), false);
});

test("keeps the stale-progress fence when recovery delete throws", async () => {
  const port = fakePort({ deleteMessage: async () => { throw new Error("temporary telegram failure"); } });
  const store = fakeStore();
  const { publisher } = makePublisher({ port, store, initialMessageId: 42 });

  await publisher.recoverPrevious(new AbortController().signal);

  assert.equal(publisher.messageId, 42);
  assert.equal(publisher.state, "unknown");
  assert.deepEqual(store.states.at(-1)?.progress, {
    messageId: 42,
    state: "unknown",
  });
});

test("keeps the durable progress fence when terminal delete fails", async () => {
  const port = fakePort({ deleteMessage: async () => ({ ok: false }) });
  const store = fakeStore();
  const { publisher } = makePublisher({ port, store });

  publisher.onToolStarted({ toolName: "web_search", callId: "c1" });
  await drain();
  await publisher.finish(new AbortController().signal);

  assert.deepEqual(port.calls.map((call) => call.kind), ["send", "delete"]);
  assert.equal(publisher.messageId, 1);
  assert.equal(publisher.state, "unknown");
  assert.deepEqual(store.states.at(-1)?.progress, {
    messageId: 1,
    state: "unknown",
  });
  assert.equal(store.states.some((state) => state.workerId === ""), false);
});

test("retires the durable progress fence on a permanent terminal delete refusal", async () => {
  const port = fakePort({ deleteMessage: async () => ({ ok: false, terminal: true }) });
  const store = fakeStore();
  const { publisher } = makePublisher({ port, store });
  publisher.onToolStarted({ toolName: "web_search", callId: "c1" });
  await drain();
  await publisher.finish(new AbortController().signal);

  assert.equal(publisher.messageId, undefined);
  assert.equal(publisher.state, "none");
  assert.ok(store.states.some((state) => state.workerId === ""));
});

test("keeps the durable progress fence when terminal delete throws", async () => {
  const port = fakePort({ deleteMessage: async () => { throw new Error("temporary telegram failure"); } });
  const store = fakeStore();
  const { publisher } = makePublisher({ port, store });

  publisher.onToolStarted({ toolName: "web_search", callId: "c1" });
  await drain();
  await publisher.finish(new AbortController().signal);

  assert.equal(publisher.messageId, 1);
  assert.equal(publisher.state, "unknown");
  assert.deepEqual(store.states.at(-1)?.progress, {
    messageId: 1,
    state: "unknown",
  });
});

test("compensates a transient ACK when its post-send durable fence is refused", async () => {
  const port = fakePort();
  const store = fakeStore();
  const save = store.saveBotTurnProgress.bind(store);
  let saves = 0;
  store.saveBotTurnProgress = (...args) => {
    saves += 1;
    return saves === 2 ? false : save(...args);
  };
  const { publisher } = makePublisher({ port, store });

  publisher.onThinkingStarted({ callId: "unfenced-false" });
  await publisher.finish(new AbortController().signal);

  assert.deepEqual(port.calls.map((call) => call.kind), ["send", "delete"]);
  assert.equal(publisher.messageId, undefined);
  assert.equal(publisher.state, "none");
});

test("compensates a transient ACK when its post-send durable fence throws", async () => {
  const port = fakePort();
  const store = fakeStore();
  const save = store.saveBotTurnProgress.bind(store);
  let saves = 0;
  store.saveBotTurnProgress = (...args) => {
    saves += 1;
    if (saves === 2) {
      throw new Error("offline test store failure");
    }
    return save(...args);
  };
  const { publisher } = makePublisher({ port, store });

  publisher.onToolStarted({ toolName: "keyword_search", callId: "unfenced-throw" });
  await publisher.finish(new AbortController().signal);

  assert.deepEqual(port.calls.map((call) => call.kind), ["send", "delete"]);
  assert.equal(publisher.messageId, undefined);
  assert.equal(publisher.state, "none");
});

test("survives a rejected progress send without retry spam", async () => {
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

  assert.equal(port.calls.length, 1);
  assert.equal(port.calls[0].kind, "send");
  assert.equal(publisher.state, "none");
});

test("a rejected progress send is treated as an ambiguous outcome and never retried", async () => {
  const port = fakePort({
    sendMessage: async () => { throw new Error("temporary send failure"); },
  });
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "day_digest", callId: "c1" });
  await drain();
  publisher.onToolCompleted({ toolName: "day_digest", callId: "c1" }, true);
  await drain();
  await publisher.finish(new AbortController().signal);

  assert.equal(port.calls.filter((call) => call.kind === "send").length, 1);
  assert.equal(publisher.state, "unknown");
});

test("a rejected progress edit keeps its known bubble eligible for terminal cleanup", async () => {
  const port = fakePort({
    sendMessage: async () => ({ ok: true, messageId: 9 }),
    editMessageText: async () => { throw new Error("temporary edit failure"); },
  });
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "day_digest", callId: "c1" });
  await drain();
  publisher.onToolCompleted({ toolName: "day_digest", callId: "c1" }, true);
  await drain();
  publisher.onToolStarted({ toolName: "keyword_search", callId: "c2" });
  await drain();
  await publisher.finish(new AbortController().signal);

  assert.equal(port.calls.filter((call) => call.kind === "send").length, 1);
  assert.ok(port.calls.some((call) => call.kind === "delete"));
  assert.equal(publisher.state, "none");
});

test("renderProgressText accumulates exactly one line per tool and truncates", () => {
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
  assert.equal(Array.from(rendered).length, 10);
  assert.equal(rendered.at(-1), "…");
  assert.equal(rendered.includes("\n"), false);
});

function manualClock(): { now: () => number; scheduler: ToolProgressScheduler; advance: (ms: number) => void } {
  let nowMs = 0;
  let nextId = 0;
  const timers = new Map<number, { dueAtMs: number; callback: () => void }>();
  return {
    now: () => nowMs,
    scheduler: {
      setTimeout(callback, delayMs) {
        const id = nextId++;
        timers.set(id, { dueAtMs: nowMs + delayMs, callback });
        return id;
      },
      clearTimeout(handle) {
        timers.delete(handle as number);
      },
    },
    advance(ms) {
      nowMs += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.dueAtMs <= nowMs) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}
