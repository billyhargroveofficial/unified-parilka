import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  MAX_FAST_CHAT_MEMORY_ITEMS,
} from "../src/storage/chat-knowledge.js";
import { MessageStore } from "../src/store.js";

const CHAT_A = "-1003179772905";
const CHAT_B = "-1003179772906";

function withStore(run: (store: MessageStore) => void): void {
  const store = new MessageStore(":memory:");
  try {
    run(store);
  } finally {
    store.close();
  }
}

test("fast chat memory is immediate, title-upserted and bounded", () => {
  withStore((store) => {
    for (let index = 1; index <= MAX_FAST_CHAT_MEMORY_ITEMS + 1; index += 1) {
      store.upsertFastChatMemory({
        chatId: CHAT_A,
        title: `note ${index}`,
        note: `value ${index}`,
        sourceMessageId: index,
        updatedAtMs: index * 1_000,
      });
    }

    const listed = store.listFastChatMemory(CHAT_A);
    assert.equal(listed.length, MAX_FAST_CHAT_MEMORY_ITEMS);
    assert.equal(listed[0]?.title, "note 13");
    assert.equal(listed.some((item) => item.title === "note 1"), false);

    const updated = store.upsertFastChatMemory({
      chatId: CHAT_A,
      title: "NOTE 13",
      note: "replaced immediately",
      sourceMessageId: 99,
      updatedAtMs: 20_000,
    });
    assert.equal(updated.key, "note 13");
    assert.equal(updated.note, "replaced immediately");
    assert.equal(updated.sourceMessageId, 99);
    assert.equal(store.listFastChatMemory(CHAT_A)[0]?.note, "replaced immediately");
  });
});

test("durable lessons remain chat-scoped, searchable and source-attributed", () => {
  withStore((store) => {
    const first = store.upsertChatLesson({
      chatId: CHAT_A,
      title: "Откат деплоя",
      problem: "A rich-message parser regression escaped review.",
      solution: "Rehearse the native rich path offline before restart.",
      whenToApply: "Before every production rich-output deploy.",
      sourceMessageId: 40,
      updatedAtMs: 100,
    });
    const updated = store.upsertChatLesson({
      chatId: CHAT_A,
      title: "откат деплоя",
      problem: "A parser regression escaped review.",
      solution: "Run the focused rich fixture and the full test suite first.",
      whenToApply: "Before every production rich-output deploy.",
      sourceMessageId: 41,
      updatedAtMs: 200,
    });
    store.upsertChatLesson({
      chatId: CHAT_B,
      title: "Откат деплоя",
      problem: "Other chat problem.",
      solution: "Other chat solution.",
      whenToApply: "Never leak across chats.",
      sourceMessageId: 1,
      updatedAtMs: 300,
    });

    assert.equal(updated.createdAtMs, first.createdAtMs);
    assert.equal(updated.updatedAtMs, 200);
    assert.equal(updated.sourceMessageId, 41);
    assert.match(updated.solution, /full test suite/u);

    const matches = store.searchChatLessons({
      chatId: CHAT_A,
      query: "RICH-OUTPUT",
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.chatId, CHAT_A);
    assert.equal(matches[0]?.title, "откат деплоя");

    const cyrillicMatches = store.searchChatLessons({
      chatId: CHAT_A,
      query: "ОТКАТ",
    });
    assert.equal(cyrillicMatches.length, 1);
  });
});

test("skills are indexed by name and credentials cannot enter chat knowledge", () => {
  withStore((store) => {
    store.upsertChatSkill({
      chatId: CHAT_A,
      name: "Release checklist",
      description: "Safe release workflow for this bot.",
      instructions: "Run focused tests, then full gates, then inspect service logs.",
      sourceMessageId: 70,
      updatedAtMs: 500,
    });

    const skill = store.getChatSkill({
      chatId: CHAT_A,
      name: "release CHECKLIST",
    });
    assert.ok(skill);
    assert.equal(skill?.name, "Release checklist");
    assert.equal(store.listChatSkills(CHAT_A)[0]?.description, "Safe release workflow for this bot.");

    assert.throws(
      () =>
        store.upsertFastChatMemory({
          chatId: CHAT_A,
          title: "credential",
          note: "sk-abcdefghijklmnopqrstuv",
        }),
      /must not contain credentials/u,
    );
    assert.equal(store.listFastChatMemory(CHAT_A).length, 0);
  });
});

test("version 15 database upgrades chat knowledge once and stays idempotent", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-chat-knowledge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "messages.sqlite");
  const initial = new MessageStore(dbPath);
  initial.close();

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      DROP INDEX IF EXISTS idx_bot_chat_fast_memory_recent;
      DROP INDEX IF EXISTS idx_bot_chat_lessons_recent;
      DROP INDEX IF EXISTS idx_bot_chat_skills_recent;
      DROP TABLE IF EXISTS bot_chat_fast_memory;
      DROP TABLE IF EXISTS bot_chat_lessons;
      DROP TABLE IF EXISTS bot_chat_skills;
      PRAGMA user_version = 15;
    `);
  } finally {
    db.close();
  }

  const migrated = new MessageStore(dbPath);
  try {
    assert.equal(migrated.getSchemaVersion(), 23);
    migrated.upsertChatLesson({
      chatId: CHAT_A,
      title: "Migration lesson",
      problem: "A v15 database lacks the new tables.",
      solution: "Apply the atomic v16 migration.",
      whenToApply: "On first startup after upgrade.",
      sourceMessageId: 1,
    });
    assert.equal(migrated.listChatLessons(CHAT_A).length, 1);
  } finally {
    migrated.close();
  }

  const reopened = new MessageStore(dbPath);
  try {
    assert.equal(reopened.getSchemaVersion(), 23);
    assert.equal(reopened.listChatLessons(CHAT_A).length, 1);
  } finally {
    reopened.close();
  }
});
