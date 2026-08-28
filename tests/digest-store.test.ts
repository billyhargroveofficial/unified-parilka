import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SCHEMA_VERSION } from "../src/storage/constants.js";
import { MessageStore } from "../src/store.js";

test("day digests are chat-scoped, ordered, and fully replace stale metadata", (t) => {
  const store = makeStore(t);
  store.upsertDayDigest({
    chatId: "-1001",
    day: "2026-07-29",
    startMessageId: 10,
    endMessageId: 20,
    messageCount: 11,
    text: "Старая сводка",
    promptVersion: "v1",
    model: "summary-old",
    inputTokens: 100,
    outputTokens: 20,
    sourceHash: "old-hash",
    createdAtMs: 1_000,
  });
  store.upsertDayDigest({
    chatId: "-1001",
    day: "2026-07-30",
    startMessageId: 21,
    endMessageId: 30,
    messageCount: 10,
    text: "Свежая сводка",
    promptVersion: "v2",
    createdAtMs: 2_000,
  });
  store.upsertDayDigest({
    chatId: "-2002",
    day: "2026-07-29",
    startMessageId: 1,
    endMessageId: 2,
    messageCount: 2,
    text: "Чужой чат",
    promptVersion: "v1",
    createdAtMs: 3_000,
  });

  const replacement = store.upsertDayDigest({
    chatId: "-1001",
    day: "2026-07-29",
    startMessageId: 12,
    endMessageId: 24,
    messageCount: 13,
    text: "Пересчитанная сводка",
    promptVersion: "v3",
    model: "summary-new",
    inputTokens: 120,
    outputTokens: 25,
    sourceHash: "new-hash",
    createdAtMs: 4_000,
  });

  assert.deepEqual(replacement, {
    chatId: "-1001",
    day: "2026-07-29",
    startMessageId: 12,
    endMessageId: 24,
    messageCount: 13,
    text: "Пересчитанная сводка",
    promptVersion: "v3",
    model: "summary-new",
    inputTokens: 120,
    outputTokens: 25,
    sourceHash: "new-hash",
    createdAtMs: 4_000,
    updatedAtMs: 4_000,
  });
  assert.deepEqual(
    store
      .getDayDigests({
        chatId: "-1001",
        dayFrom: "2026-07-30",
        dayTo: "2026-07-29",
      })
      .map(({ day, text }) => [day, text]),
    [
      ["2026-07-30", "Свежая сводка"],
      ["2026-07-29", "Пересчитанная сводка"],
    ],
  );
});

test("weekly rollups use overlap queries without leaking another chat", (t) => {
  const store = makeStore(t);
  store.upsertDigestRollup({
    chatId: "-1001",
    kind: "week",
    period: "2026-W30",
    dayFrom: "2026-07-20",
    dayTo: "2026-07-26",
    dayCount: 7,
    text: "Неделя тридцать",
    promptVersion: "roll-v1",
    sourceHash: "week-30",
    createdAtMs: 1_000,
  });
  store.upsertDigestRollup({
    chatId: "-1001",
    kind: "week",
    period: "2026-W31",
    dayFrom: "2026-07-27",
    dayTo: "2026-08-02",
    dayCount: 7,
    text: "Неделя тридцать один",
    promptVersion: "roll-v1",
    createdAtMs: 2_000,
  });
  store.upsertDigestRollup({
    chatId: "-2002",
    kind: "week",
    period: "2026-W31",
    dayFrom: "2026-07-27",
    dayTo: "2026-08-02",
    dayCount: 7,
    text: "Чужая неделя",
    promptVersion: "roll-v1",
    createdAtMs: 3_000,
  });

  assert.deepEqual(
    store
      .getDigestRollups({
        chatId: "-1001",
        kind: "week",
        dayFrom: "2026-07-25",
        dayTo: "2026-07-28",
      })
      .map(({ period }) => period),
    ["2026-W31", "2026-W30"],
  );
});

test("deleting a day digest atomically removes only its chat-scoped dependent weeks", (t) => {
  const store = makeStore(t);
  for (const chatId of ["-1001", "-2002"]) {
    store.upsertDayDigest({
      chatId,
      day: "2026-07-29",
      startMessageId: 1,
      endMessageId: 1,
      messageCount: 1,
      text: `day:${chatId}`,
      promptVersion: "v1",
      createdAtMs: 1,
    });
    store.upsertDigestRollup({
      chatId,
      kind: "week",
      period: "2026-W31",
      dayFrom: "2026-07-27",
      dayTo: "2026-08-02",
      dayCount: 1,
      text: `week:${chatId}`,
      promptVersion: "v1",
      createdAtMs: 2,
    });
  }

  assert.deepEqual(
    store.deleteDayDigest({
      chatId: "-1001",
      day: "2026-07-29",
    }),
    {
      dayDeleted: true,
      weekRollupsDeleted: 1,
    },
  );
  assert.deepEqual(store.listDayDigests("-1001"), []);
  assert.deepEqual(
    store.getDigestRollups({
      chatId: "-1001",
      kind: "week",
      dayFrom: "2026-07-27",
      dayTo: "2026-08-02",
    }),
    [],
  );
  assert.equal(store.listDayDigests("-2002").length, 1);
  assert.equal(
    store.getDigestRollups({
      chatId: "-2002",
      kind: "week",
      dayFrom: "2026-07-27",
      dayTo: "2026-08-02",
    }).length,
    1,
  );
});

test("version 11 databases receive digest tables in one atomic migration", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-migration-"));
  const path = join(directory, "cache.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  new MessageStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec(`
    DROP INDEX idx_chat_day_digests_range;
    DROP INDEX idx_chat_digest_rollups_range;
    DROP TABLE chat_day_digests;
    DROP TABLE chat_digest_rollups;
    PRAGMA user_version = 11;
  `);
  raw.close();

  const migrated = new MessageStore(path);
  assert.equal(migrated.getSchemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(
    migrated.getDayDigests({
      chatId: "-1001",
      dayFrom: "2026-07-30",
      dayTo: "2026-07-30",
    }),
    [],
  );
  migrated.close();
});

test("writable v14 opens harden the database and reconcile the digest date index", (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "parilka-digest-index-"),
  );
  const path = join(directory, "cache.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const store = new MessageStore(path);
  store.upsertMessages(
    {
      chatId: "-1001",
      requested: "-1001",
      kind: "supergroup",
    },
    [
      {
        chatId: "-1001",
        messageId: 1,
        date: "2026-07-29T21:00:00.000Z",
        text: "indexed digest source",
      },
    ],
  );
  store.close();

  assert.equal(statSync(path).mode & 0o777, 0o600);
  const raw = new DatabaseSync(path, { readOnly: true });
  const indexes = raw
    .prepare("PRAGMA index_list('messages')")
    .all() as Array<Record<string, unknown>>;
  assert.ok(
    indexes.some(
      ({ name }) => name === "idx_messages_digest_date",
    ),
  );
  const plan = raw
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT *
       FROM messages
       WHERE chat_id = ?
         AND deleted_at IS NULL
         AND length(trim(text)) > 0
         AND date IS NOT NULL
         AND date >= ?
         AND date < ?
         AND julianday(date) IS NOT NULL
       ORDER BY date ASC, message_id ASC`,
    )
    .all(
      "-1001",
      "2026-07-29T21:00:00.000Z",
      "2026-07-30T21:00:00.000Z",
    ) as Array<Record<string, unknown>>;
  raw.close();
  assert.ok(
    plan.some(({ detail }) =>
      String(detail).includes("idx_messages_digest_date"),
    ),
  );
});

test("schema validation detects a missing bot turn due index", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-schema-index-"));
  const path = join(directory, "cache.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  new MessageStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec("DROP INDEX idx_bot_turns_due");
  raw.close();

  assert.throws(
    () => new MessageStore(path),
    /idx_bot_turns_due/u,
  );
});

test("digest writes reject malformed ranges and metadata before SQLite", (t) => {
  const store = makeStore(t);
  assert.throws(
    () =>
      store.upsertDayDigest({
        chatId: "-1001",
        day: "2026-02-30",
        startMessageId: 2,
        endMessageId: 1,
        messageCount: 0,
        text: "",
        promptVersion: "v1",
      }),
    /real Gregorian/,
  );
  assert.throws(
    () =>
      store.upsertDigestRollup({
        chatId: "-1001",
        kind: "week",
        period: "2026-W31",
        dayFrom: "2026-08-02",
        dayTo: "2026-07-27",
        dayCount: 7,
        text: "bad range",
        promptVersion: "v1",
      }),
    /dayTo/,
  );
  assert.throws(
    () =>
      store.getDayDigests({
        chatId: "-1001",
        dayFrom: "2026-07-01",
        dayTo: "2026-07-02",
        limit: 401,
      }),
    /between 1 and 400/,
  );
});

function makeStore(t: TestContext): MessageStore {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-store-"));
  const store = new MessageStore(join(directory, "cache.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}
