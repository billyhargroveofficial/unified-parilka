import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  MessageStore,
  TranscriptCursorError,
  type StoredMessage,
} from "../src/store.js";
import type { ChatInfo } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-2002",
  requested: "-2002",
  kind: "supergroup",
};

function fixtureStore(t: TestContext, total = 1_500): MessageStore {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  const rows: StoredMessage[] = [];
  for (let messageId = 1; messageId <= total; messageId += 1) {
    const day = 10 + Math.floor(messageId / 300);
    rows.push({
      chatId: CHAT.chatId,
      messageId,
      date: `2026-07-${String(day).padStart(2, "0")}T10:00:00.000Z`,
      senderId: `u${messageId % 5}`,
      senderName: `user_${messageId % 5}`,
      text: messageId % 13 === 0 ? "" : `текст ${messageId}`,
    });
  }
  store.upsertMessages(CHAT, rows);
  return store;
}

test("recent slice paginates newest-first in 300-row pages without gaps", (t) => {
  const store = fixtureStore(t);
  store.markMessagesDeleted(CHAT.chatId, [1_450]);

  const result = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "recent",
    count: 800,
  });

  assert.equal(result.form, "recent");
  // The newest 300 of the window: ids 1200..1500 minus the deleted id 1450.
  assert.equal(result.messages.length, 300);
  assert.equal(result.coverage.returnedCount, 300);
  assert.equal(result.coverage.coveredCount, 300);
  assert.equal(result.coverage.totalAvailable, 1_499);
  assert.equal(result.coverage.upperMessageId, 1_500);
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.hasMore, true);
  assert.notEqual(result.coverage.nextCursor, undefined);
  assert.equal(result.coverage.omittedCount, 699);
  assert.equal(result.coverage.firstMessageId, 1_200);
  assert.equal(result.coverage.lastMessageId, 1_500);
  assert.ok(
    result.messages.every(
      (row, index, rows) =>
        index === 0 || rows[index - 1].messageId < row.messageId,
    ),
  );
  assert.ok(!result.messages.some((row) => row.messageId === 1_450));

  // Walk the frozen snapshot to the end: 800 aggregated rows, no dupes,
  // the deleted id never appears, the window bottom is 700.
  const seen: number[] = [...result.messages.map((row) => row.messageId)];
  let emptyTextCount = result.coverage.emptyTextCount;
  let page = result;
  while (page.coverage.nextCursor !== undefined) {
    page = store.getLiveTranscript({
      chatId: CHAT.chatId,
      form: "recent",
      cursor: page.coverage.nextCursor,
    });
    assert.equal(page.coverage.upperMessageId, 1_500);
    seen.push(...page.messages.map((row) => row.messageId));
    emptyTextCount += page.coverage.emptyTextCount;
  }
  assert.equal(page.coverage.hasMore, false);
  assert.equal(page.coverage.nextCursor, undefined);
  assert.equal(page.coverage.coveredCount, 800);
  assert.equal(page.coverage.truncated, false);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 800);
  assert.equal(Math.min(...seen), 700);
  assert.equal(Math.max(...seen), 1_500);
  assert.ok(!seen.includes(1_450));
  // Multiples of 13 carry empty text: 702, 715, ..., 1495.
  assert.equal(emptyTextCount, 62);
});

test("recent 800 aggregates without duplicates through 300/300/200 pages", (t) => {
  const store = fixtureStore(t, 800);
  const first = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "recent",
    count: 800,
  });
  assert.equal(first.messages.length, 300);
  assert.equal(first.coverage.firstMessageId, 501);
  assert.equal(first.coverage.lastMessageId, 800);
  assert.equal(first.coverage.hasMore, true);

  const second = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "recent",
    cursor: first.coverage.nextCursor ?? "",
  });
  assert.equal(second.messages.length, 300);
  assert.equal(second.coverage.firstMessageId, 201);
  assert.equal(second.coverage.lastMessageId, 500);
  assert.equal(second.coverage.hasMore, true);

  const third = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "recent",
    cursor: second.coverage.nextCursor ?? "",
  });
  assert.equal(third.messages.length, 200);
  assert.equal(third.coverage.firstMessageId, 1);
  assert.equal(third.coverage.lastMessageId, 200);
  assert.equal(third.coverage.hasMore, false);
  assert.equal(third.coverage.nextCursor, undefined);
  assert.equal(third.coverage.coveredCount, 800);
  assert.equal(third.coverage.truncated, false);

  const aggregated = [
    ...first.messages.map((row) => row.messageId),
    ...second.messages.map((row) => row.messageId),
    ...third.messages.map((row) => row.messageId),
  ];
  assert.equal(aggregated.length, 800);
  assert.equal(new Set(aggregated).size, 800);
  // Recent pages walk newest-first, so the union must be sorted to compare.
  assert.deepEqual(
    [...aggregated].sort((left, right) => left - right),
    Array.from({ length: 800 }, (_, i) => i + 1),
  );
});

test("recent slice upper bound clamps to the caller authoritative id", (t) => {
  const store = fixtureStore(t);
  const result = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "recent",
    count: 10,
    upperMessageId: 500,
  });
  assert.equal(result.coverage.upperMessageId, 500);
  assert.equal(result.messages.at(-1)?.messageId, 500);
  assert.ok(result.messages.every((row) => row.messageId <= 500));
});

test("period slice paginates by keyset and freezes its upper bound", (t) => {
  const store = fixtureStore(t);
  const first = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "period",
    startInclusive: "2026-07-10T00:00:00.000Z",
    endExclusive: "2026-07-20T00:00:00.000Z",
  });
  assert.equal(first.coverage.returnedCount, 300);
  assert.equal(first.coverage.coveredCount, 300);
  assert.equal(first.coverage.truncated, true);
  assert.equal(first.coverage.hasMore, true);
  assert.notEqual(first.coverage.nextCursor, undefined);

  // A late insert inside the period dates but above the frozen upper bound
  // must never enter any continuation page.
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1_501,
      date: "2026-07-12T09:00:00.000Z",
      senderId: "late",
      senderName: "late",
      text: "позднее сообщение",
    },
  ]);

  const aggregated = [...first.messages.map((row) => row.messageId)];
  let page = first;
  while (page.coverage.nextCursor !== undefined) {
    page = store.getLiveTranscript({
      chatId: CHAT.chatId,
      form: "period",
      cursor: page.coverage.nextCursor,
    });
    assert.equal(page.coverage.upperMessageId, 1_500);
    assert.ok(
      page.messages.every(
        (row, index, rows) =>
          index === 0 || rows[index - 1].messageId < row.messageId,
      ),
    );
    aggregated.push(...page.messages.map((row) => row.messageId));
  }

  assert.equal(aggregated.length, 1_500);
  assert.equal(new Set(aggregated).size, 1_500);
  assert.deepEqual(
    aggregated,
    Array.from({ length: 1_500 }, (_, i) => i + 1),
  );
  assert.ok(!aggregated.includes(1_501));
  assert.equal(page.coverage.hasMore, false);
  assert.equal(page.coverage.nextCursor, undefined);
  assert.equal(page.coverage.coveredCount, 1_500);
  assert.equal(page.coverage.truncated, false);
});

test("period slice does not attribute undated rows outside dated span to the period", (t) => {
  const store = fixtureStore(t, 40);
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 41,
      senderId: "u0",
      senderName: "undated",
      text: "без даты после последнего датированного",
    },
  ]);
  const result = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "period",
    startInclusive: "2026-07-10T00:00:00.000Z",
    endExclusive: "2026-07-11T00:00:00.000Z",
  });
  assert.equal(result.coverage.returnedCount, 40);
  assert.equal(result.coverage.omittedCount, 0);
  assert.ok(!result.messages.some((row) => row.messageId === 41));
});

test("period slice reports undated rows between dated rows as omitted", (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      date: "2026-07-10T10:00:00.000Z",
      senderId: "u0",
      senderName: "user",
      text: "начало",
    },
    {
      chatId: CHAT.chatId,
      messageId: 3,
      date: "2026-07-10T11:00:00.000Z",
      senderId: "u0",
      senderName: "user",
      text: "конец",
    },
    {
      chatId: CHAT.chatId,
      messageId: 2,
      senderId: "u0",
      senderName: "undated",
      text: "без даты между датированными",
    },
  ]);
  const result = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "period",
    startInclusive: "2026-07-10T00:00:00.000Z",
    endExclusive: "2026-07-11T00:00:00.000Z",
  });
  assert.equal(result.coverage.returnedCount, 2);
  assert.equal(result.coverage.omittedCount, 1);
  assert.ok(!result.messages.some((row) => row.messageId === 2));
});

test("empty chat returns an honest empty transcript", (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  const result = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "recent",
    count: 100,
  });
  assert.deepEqual(result.messages, []);
  assert.equal(result.coverage.totalAvailable, 0);
  assert.equal(result.coverage.upperMessageId, 0);
  assert.equal(result.coverage.hasMore, false);
});

test("corrupted or mismatched cursors fail typed validation", (t) => {
  const store = fixtureStore(t);
  const first = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "period",
    startInclusive: "2026-07-10T00:00:00.000Z",
    endExclusive: "2026-07-20T00:00:00.000Z",
  });
  const validCursor = first.coverage.nextCursor ?? "";
  assert.notEqual(validCursor, "");

  const corrupted = [
    "",
    "!!!not-base64!!!",
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 99, form: "period", chatId: CHAT.chatId }))
      .toString("base64url"),
    Buffer.from(
      JSON.stringify({
        v: 1,
        form: "period",
        chatId: CHAT.chatId,
        upper: 10,
        anchor: 20,
        budget: 5,
        covered: 0,
        total: 10,
        omitted: 0,
        start: "2026-07-10T00:00:00.000Z",
        end: "2026-07-20T00:00:00.000Z",
      }),
    ).toString("base64url"),
  ];
  for (const cursor of corrupted) {
    assert.throws(
      () =>
        store.getLiveTranscript({ chatId: CHAT.chatId, form: "period", cursor }),
      TranscriptCursorError,
    );
  }

  assert.throws(
    () =>
      store.getLiveTranscript({
        chatId: "-9999",
        form: "period",
        cursor: validCursor,
      }),
    TranscriptCursorError,
  );
  assert.throws(
    () =>
      store.getLiveTranscript({
        chatId: CHAT.chatId,
        form: "recent",
        cursor: validCursor,
      }),
    TranscriptCursorError,
  );
});

test("transcript rejects offsets and normalizes Z without milliseconds", (t) => {
  const store = fixtureStore(t, 10);
  assert.throws(
    () =>
      store.getLiveTranscript({
        chatId: CHAT.chatId,
        form: "period",
        startInclusive: "2026-07-10T00:00:00+03:00",
        endExclusive: "2026-07-11T00:00:00.000Z",
      }),
    /canonical UTC ISO/,
  );
  const normalized = store.getLiveTranscript({
    chatId: CHAT.chatId,
    form: "period",
    startInclusive: "2026-07-10T00:00:00Z",
    endExclusive: "2026-07-11T00:00:00Z",
  });
  assert.equal(normalized.coverage.returnedCount, 10);
  assert.equal(normalized.coverage.firstDate, "2026-07-10T10:00:00.000Z");
});

test("transcript input validation is bounded", (t) => {
  const store = fixtureStore(t, 10);
  assert.throws(
    () =>
      store.getLiveTranscript({ chatId: CHAT.chatId, form: "recent", count: 0 }),
    /count/,
  );
  assert.throws(
    () =>
      store.getLiveTranscript({
        chatId: CHAT.chatId,
        form: "recent",
        count: 1_001,
      }),
    /count/,
  );
  assert.throws(
    () =>
      store.getLiveTranscript({
        chatId: CHAT.chatId,
        form: "period",
        startInclusive: "2026-07-12T00:00:00.000Z",
        endExclusive: "2026-07-10T00:00:00.000Z",
      }),
    /startInclusive/,
  );
});
