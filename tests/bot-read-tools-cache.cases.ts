import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_READ_TOOL_DEFINITIONS,
  BotReadTools,
  calendarDayRange,
} from "../src/bot/read-tools.js";
import { MessageStore } from "../src/store.js";
import {
  CHAT,
  durationHours,
  emptyCache,
  message,
  storeCache,
} from "./support/bot-read-tools.js";

test("the direct registry preserves the five cache read-tool contracts", () => {
  const names: readonly string[] = BOT_READ_TOOL_DEFINITIONS.map(
    ({ name }) => name,
  );
  assert.deepEqual(
    names,
    [
      "rag_bm25_search",
      "keyword_search",
      "read_chat_slice",
      "day_digest",
      "thread_context",
    ],
  );
  for (const definition of BOT_READ_TOOL_DEFINITIONS) {
    assert.equal(definition.inputSchema.additionalProperties, false);
  }
});

test("rag_bm25_search reads MessageStore locally and emits attributable evidence", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 10,
      date: "2026-07-30T08:15:00.000Z",
      senderId: "42",
      senderName: "alice",
      text: "needle про архитектуру",
    },
    {
      chatId: CHAT.chatId,
      messageId: 11,
      date: "2026-07-30T08:16:00.000Z",
      senderId: "43",
      senderName: "bob",
      text: "другое сообщение",
    },
  ]);
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store),
  });

  const result = await tools.callTool("rag_bm25_search", {
    query: "needle",
    limit: 3,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "done");
  assert.deepEqual(result.result, {
    query: "needle",
    limit: 3,
    returnedCount: 1,
    mode: "keyword",
    degradedChannels: [],
  });
  assert.deepEqual(result.evidence, [
    {
      source: "chat_message",
      sourceId: "chat:10",
      chat: { id: CHAT.chatId },
      message: { id: 10 },
      speaker: { id: "42", name: "alice" },
      authorRole: "user",
      isOwnTurn: false,
      date: "2026-07-30T08:15:00.000Z",
      text: "needle про архитектуру",
    },
  ]);
});

test("rag_bm25_search accepts an async hybrid adapter and reports degraded channels", async () => {
  let signal: AbortSignal | undefined;
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache({
      async search(params) {
        signal = params.signal;
        return {
          messages: [message(12, "hybrid hit", "alice")],
          mode: "hybrid",
          degradedChannels: ["vector"],
        };
      },
    }),
  });

  const result = await tools.callTool("rag_bm25_search", { query: "hybrid" });
  assert.equal(signal?.aborted, false);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.mode, "hybrid");
    assert.deepEqual(result.result.degradedChannels, ["vector"]);
    assert.equal(result.evidence[0]?.message?.id, 12);
  }
});

test("rag_bm25_search forwards the trigger id as an exclusive beforeId", async () => {
  let captured: { beforeId?: number } | undefined;
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache({
      async search(params) {
        captured = params;
        return { messages: [], mode: "hybrid" };
      },
    }),
  });

  const result = await tools.callTool(
    "rag_bm25_search",
    { query: "хвост" },
    { sourceMessageId: 1_000 },
  );
  assert.equal(result.ok, true);
  assert.equal(captured?.beforeId, 1_000);

  const plain = await tools.callTool("rag_bm25_search", { query: "хвост" });
  assert.equal(plain.ok, true);
  assert.equal(captured?.beforeId, undefined);
});

test("rag_bm25_search never returns the trigger or messages above it", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 10,
      date: "2026-07-30T08:15:00.000Z",
      senderId: "42",
      senderName: "alice",
      text: "needle про архитектуру",
    },
    {
      chatId: CHAT.chatId,
      messageId: 11,
      date: "2026-07-30T08:16:00.000Z",
      senderId: "43",
      senderName: "bob",
      text: "needle из будущего",
    },
  ]);
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store),
  });

  const result = await tools.callTool(
    "rag_bm25_search",
    { query: "needle", limit: 3 },
    { sourceMessageId: 11 },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(
    result.evidence.map((item) => item.message?.id),
    [10],
  );
});

test("thread_context keeps explicit zero windows and evidence order", async () => {
  const calls: Array<{
    chatId: string;
    messageId: number;
    before: number;
    after: number;
  }> = [];
  const cache = emptyCache({
    getThreadContext(params) {
      calls.push(params);
      return [
        message(20, "до", "alice"),
        message(21, "центр", "bob"),
        message(22, "после", "carol"),
      ];
    },
  });
  const tools = new BotReadTools({ chatId: CHAT.chatId, cache });

  const exact = await tools.callTool("thread_context", {
    message_id: 21,
    before: 0,
    after: 0,
  });

  assert.deepEqual(calls, [
    {
      chatId: CHAT.chatId,
      messageId: 21,
      before: 0,
      after: 0,
    },
  ]);
  assert.equal(exact.ok, true);
  if (!exact.ok) {
    return;
  }
  assert.deepEqual(
    exact.evidence.map((item) => [item.message?.id, item.speaker.name, item.text]),
    [
      [20, "alice", "до"],
      [21, "bob", "центр"],
      [22, "carol", "после"],
    ],
  );
  assert.equal(exact.result.centerFound, true);
});

test("thread_context cuts off rows at or above the trigger id", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 30,
      date: "2026-07-30T08:15:00.000Z",
      senderId: "u30",
      senderName: "alice",
      text: "до",
    },
    {
      chatId: CHAT.chatId,
      messageId: 38,
      date: "2026-07-30T08:16:00.000Z",
      senderId: "u38",
      senderName: "bob",
      text: "центр",
    },
    {
      chatId: CHAT.chatId,
      messageId: 45,
      date: "2026-07-30T08:17:00.000Z",
      senderId: "u45",
      senderName: "carol",
      text: "после центра",
    },
  ]);
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store),
  });

  const pastCenter = await tools.callTool(
    "thread_context",
    { message_id: 38, before: 10, after: 10 },
    { sourceMessageId: 40 },
  );
  assert.equal(pastCenter.ok, true);
  if (pastCenter.ok) {
    assert.deepEqual(
      pastCenter.evidence.map((item) => item.message?.id),
      [30, 38],
    );
    assert.equal(pastCenter.result.centerFound, true);
  }

  const futureCenter = await tools.callTool(
    "thread_context",
    { message_id: 45, before: 20, after: 5 },
    { sourceMessageId: 40 },
  );
  assert.equal(futureCenter.ok, true);
  if (futureCenter.ok) {
    assert.equal(futureCenter.result.centerFound, false);
    assert.deepEqual(
      futureCenter.evidence.map((item) => item.message?.id),
      [30, 38],
      "the window may still expose older surroundings, never the future center",
    );
  }

  const zeroWindow = await tools.callTool(
    "thread_context",
    { message_id: 45, before: 0, after: 0 },
    { sourceMessageId: 40 },
  );
  assert.equal(zeroWindow.ok, true);
  if (zeroWindow.ok) {
    assert.equal(zeroWindow.status, "empty");
    assert.equal(zeroWindow.result.centerFound, false);
    assert.deepEqual(zeroWindow.evidence, []);
  }
});

test("empty cache is a successful empty result for all SQLite tools", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
  });

  const results = await Promise.all([
    tools.callTool("rag_bm25_search", { query: "ничего" }),
    tools.callTool("thread_context", { message_id: 100 }),
    tools.callTool("day_digest", { day_from: "2026-07-30" }),
  ]);

  for (const result of results) {
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, "empty");
      assert.deepEqual(result.evidence, []);
    }
  }
});

test("calendar day conversion is reversed-range tolerant and DST-safe", () => {
  const reversed = calendarDayRange(
    "2026-07-30",
    "2026-07-25",
    "Europe/Moscow",
  );
  assert.deepEqual(reversed, {
    dayFrom: "2026-07-25",
    dayTo: "2026-07-30",
    dayCount: 6,
    timeZone: "Europe/Moscow",
    startInclusive: "2026-07-24T21:00:00.000Z",
    endExclusive: "2026-07-30T21:00:00.000Z",
    reversedInput: true,
  });

  // Moscow observed DST in 2010. Converting each local midnight independently
  // produces a 23-hour spring day and a 25-hour autumn day.
  const spring = calendarDayRange("2010-03-28");
  const autumn = calendarDayRange("2010-10-31");
  assert.equal(durationHours(spring), 23);
  assert.equal(durationHours(autumn), 25);
  assert.equal(spring.startInclusive, "2010-03-27T21:00:00.000Z");
  assert.equal(spring.endExclusive, "2010-03-28T20:00:00.000Z");
});
