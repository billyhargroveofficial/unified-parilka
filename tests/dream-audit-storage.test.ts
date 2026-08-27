import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import {
  DREAM_CHAT_ID,
  DREAM_YESTERDAY,
  dreamFixtureStore,
} from "./support/dream.js";

const OTHER_CHAT = "-1009999999999";

function tempDbPath(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "parilka-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "messages.sqlite");
}
function openRaw(path: string): DatabaseSync { return new DatabaseSync(path); }

// ── Storage integration ───────────────────────────────────────────────────

test("commitDreamDay stores audit and applies deletions", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-audit-");
  try {
    store.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "pre", note: "before", sourceMessageId: 1 });
    store.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 3, attempts: 1, firstMessageId: 1, lastMessageId: 3, sourceHash: "abc", completedAtMs: 200, updatedAtMs: 200 },
      fast: [{ chatId: DREAM_CHAT_ID, title: "new", note: "created", sourceMessageId: 2, updatedAtMs: 200 }],
      lessons: [], skills: [],
      deletedFastKeys: ["pre"],
    });
    const a = store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
    assert.ok(a);
    assert.equal(a.audit.fastMemory.created[0]?.note, "created");
    assert.equal(a.audit.fastMemory.deleted[0]?.note, "before");
    assert.equal(a.audit.fastMemory.deleted[0]?.chatId, DREAM_CHAT_ID);
  } finally { cleanup(); }
});

test("idempotent retry — deepEqual day, memory, fast, lessons, skills, audit", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-audit-");
  try {
    store.upsertChatMemory({ chatId: DREAM_CHAT_ID, memoryText: "orig", lastConsolidatedMessageId: 1 });
    store.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "f", note: "orig", sourceMessageId: 1 });
    store.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "l", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 1 });
    store.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "sk", description: "d", instructions: "i", sourceMessageId: 1 });

    store.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 100, completedAtMs: 100 },
      fast: [{ chatId: DREAM_CHAT_ID, title: "f", note: "updated", sourceMessageId: 2, updatedAtMs: 100 }],
      lessons: [{ chatId: DREAM_CHAT_ID, title: "l", problem: "p2", solution: "s", whenToApply: "w", sourceMessageId: 1, updatedAtMs: 100 }],
      skills: [{ chatId: DREAM_CHAT_ID, name: "sk", description: "d2", instructions: "i", sourceMessageId: 1, updatedAtMs: 100 }],
    });

    const mem1 = store.getChatMemory(DREAM_CHAT_ID);
    const fast1 = store.listFastChatMemory(DREAM_CHAT_ID);
    const lessons1 = store.listChatLessons(DREAM_CHAT_ID);
    const skills1 = store.listChatSkills(DREAM_CHAT_ID);
    const day1 = store.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
    const audit1 = store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });

    // Retry with different writes in every layer.
    store.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 999, attempts: 99, updatedAtMs: 999, completedAtMs: 999 },
      fast: [{ chatId: DREAM_CHAT_ID, title: "fake", note: "NO", sourceMessageId: 99, updatedAtMs: 999 }],
      lessons: [{ chatId: DREAM_CHAT_ID, title: "fake", problem: "NO", solution: "NO", whenToApply: "NO", sourceMessageId: 99, updatedAtMs: 999 }],
      skills: [{ chatId: DREAM_CHAT_ID, name: "fake", description: "NO", instructions: "NO", sourceMessageId: 99, updatedAtMs: 999 }],
      memory: { chatId: DREAM_CHAT_ID, memoryText: "NO", lastConsolidatedMessageId: 999, updatedAtMs: 999 },
    });

    assert.deepEqual(store.getChatMemory(DREAM_CHAT_ID), mem1);
    assert.deepEqual(store.listFastChatMemory(DREAM_CHAT_ID), fast1);
    assert.deepEqual(store.listChatLessons(DREAM_CHAT_ID), lessons1);
    assert.deepEqual(store.listChatSkills(DREAM_CHAT_ID), skills1);
    assert.deepEqual(store.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), day1);
    assert.deepEqual(store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), audit1);
  } finally { cleanup(); }
});

test("corruption: audit exists, day not completed — deepEqual all state unchanged", (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);
  store.upsertChat({ chatId: DREAM_CHAT_ID, requested: DREAM_CHAT_ID, title: "T", kind: "channel", isForum: false });
  store.upsertChatMemory({ chatId: DREAM_CHAT_ID, memoryText: "safe", lastConsolidatedMessageId: 1 });
  store.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "f", note: "orig", sourceMessageId: 1 });
  store.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "l", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 1 });
  store.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "sk", description: "d", instructions: "i", sourceMessageId: 1 });
  store.commitDreamDay({
    day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 100, completedAtMs: 100 },
    fast: [], lessons: [], skills: [],
  });
  store.close();

  // Corrupt: audit row exists while the day is no longer completed.
  const raw = openRaw(dbPath);
  raw.exec(`UPDATE bot_chat_dream_days SET status = 'running' WHERE chat_id = '${DREAM_CHAT_ID}' AND day = '${DREAM_YESTERDAY}'`);
  raw.close();

  const reopened = new MessageStore(dbPath);
  // Snapshot every layer immediately before the failed commit attempt.
  const memBefore = reopened.getChatMemory(DREAM_CHAT_ID);
  const fastBefore = reopened.listFastChatMemory(DREAM_CHAT_ID);
  const lessonsBefore = reopened.listChatLessons(DREAM_CHAT_ID);
  const skillsBefore = reopened.listChatSkills(DREAM_CHAT_ID);
  const dayBefore = reopened.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
  const auditBefore = reopened.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
  try {
    assert.throws(() => reopened.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 200, completedAtMs: 200 },
      fast: [], lessons: [], skills: [],
    }), /corruption/);
    assert.deepEqual(reopened.getChatMemory(DREAM_CHAT_ID), memBefore);
    assert.deepEqual(reopened.listFastChatMemory(DREAM_CHAT_ID), fastBefore);
    assert.deepEqual(reopened.listChatLessons(DREAM_CHAT_ID), lessonsBefore);
    assert.deepEqual(reopened.listChatSkills(DREAM_CHAT_ID), skillsBefore);
    assert.deepEqual(reopened.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), dayBefore);
    assert.deepEqual(reopened.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), auditBefore);
  } finally { reopened.close(); }
});

test("noncompleted status proves no writes in all layers", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-audit-");
  try {
    assert.throws(() => store.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "running", interactionCount: 1, attempts: 1, updatedAtMs: 100 },
      fast: [{ chatId: DREAM_CHAT_ID, title: "f", note: "n", sourceMessageId: 1, updatedAtMs: 100 }],
      lessons: [{ chatId: DREAM_CHAT_ID, title: "l", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 1, updatedAtMs: 100 }],
      skills: [{ chatId: DREAM_CHAT_ID, name: "sk", description: "d", instructions: "i", sourceMessageId: 1, updatedAtMs: 100 }],
      memory: { chatId: DREAM_CHAT_ID, memoryText: "leak", lastConsolidatedMessageId: 99, updatedAtMs: 100 },
    }), /status === 'completed'/);
    assert.equal(store.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), undefined);
    assert.equal(store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), undefined);
    assert.equal(store.getChatMemory(DREAM_CHAT_ID), undefined);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listChatLessons(DREAM_CHAT_ID).length, 0);
    assert.equal(store.listChatSkills(DREAM_CHAT_ID).length, 0);
  } finally { cleanup(); }
});

test("cross-chat audit isolation", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-audit-");
  try {
    store.upsertChat({ chatId: OTHER_CHAT, requested: OTHER_CHAT, title: "O", kind: "channel", isForum: false });
    store.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 100, completedAtMs: 100 },
      fast: [], lessons: [], skills: [],
    });
    assert.ok(store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }));
    assert.equal(store.getDreamAudit({ chatId: OTHER_CHAT, day: DREAM_YESTERDAY }), undefined);
  } finally { cleanup(); }
});

// ── Schema migration ──────────────────────────────────────────────────────

test("v21 fixture migrates to v23, preserves data, idempotent reopen", (t) => {
  const dbPath = tempDbPath(t);
  const v21 = new MessageStore(dbPath);
  v21.upsertChat({ chatId: DREAM_CHAT_ID, requested: DREAM_CHAT_ID, title: "T", kind: "channel", isForum: false });
  v21.upsertChatMemory({ chatId: DREAM_CHAT_ID, memoryText: "pre", lastConsolidatedMessageId: 1 });
  v21.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "note", note: "s", sourceMessageId: 1 });
  v21.close();

  const raw = openRaw(dbPath);
  raw.exec("PRAGMA user_version = 21");
  raw.exec("DROP TABLE IF EXISTS bot_chat_dream_audits");
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_chat_dream_audits'").get(), undefined);
  raw.close();

  const migrated = new MessageStore(dbPath);
  assert.equal(migrated.getSchemaVersion(), 23);
  assert.equal(migrated.getChatMemory(DREAM_CHAT_ID)?.memoryText, "pre");
  assert.equal(migrated.listFastChatMemory(DREAM_CHAT_ID).length, 1);
  migrated.commitDreamDay({
    day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 100, completedAtMs: 100 },
    fast: [], lessons: [], skills: [],
  });
  assert.ok(migrated.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }));
  migrated.close();

  const again = new MessageStore(dbPath);
  assert.equal(again.getSchemaVersion(), 23);
  again.close();
});

test("v23 read-only open", (t) => {
  const dbPath = tempDbPath(t);
  new MessageStore(dbPath).close();
  const ro = new MessageStore(dbPath, { readOnly: true });
  try { assert.equal(ro.getSchemaVersion(), 23); } finally { ro.close(); }
});

test("PRAGMA quick_check ok", (t) => {
  const dbPath = tempDbPath(t);
  new MessageStore(dbPath).close();
  const db = openRaw(dbPath);
  try {
    const r = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    assert.equal(r.length, 1);
    assert.equal(String(Object.values(r[0]!)[0]), "ok");
  } finally { db.close(); }
});

// ── Capacity eviction: deepEqual exact record ─────────────────────────────

test("capacity eviction: deepEqual exact evicted n0 record", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-audit-");
  try {
    for (let i = 0; i < 12; i += 1) {
      store.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: `n${i}`, note: `c${i}`, sourceMessageId: i + 1, updatedAtMs: i * 10 });
    }
    const beforeList = store.listFastChatMemory(DREAM_CHAT_ID);
    assert.equal(beforeList.length, 12);
    const expectedEvicted = beforeList[beforeList.length - 1]!;

    store.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 1000, completedAtMs: 1000 },
      fast: [{ chatId: DREAM_CHAT_ID, title: "n12", note: "newcomer", sourceMessageId: 13, updatedAtMs: 1000 }],
      lessons: [], skills: [],
    });

    const audit = store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
    assert.ok(audit);
    assert.equal(audit.audit.fastMemory.evicted.length, 1);
    assert.deepEqual(audit.audit.fastMemory.evicted[0], expectedEvicted);
  } finally { cleanup(); }
});

// ── No-op audit ────────────────────────────────────────────────────────────

test("zero-interaction day produces no-op audit via commitDreamDay", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-audit-");
  try {
    store.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 0, attempts: 1, sourceHash: "", updatedAtMs: 100, completedAtMs: 100 },
      fast: [], lessons: [], skills: [],
    });
    const audit = store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
    assert.ok(audit);
    assert.equal(audit.audit.fastMemory.changed, false);
  } finally { cleanup(); }
});

// ── RAISE(ABORT) rollback + no audit ──────────────────────────────────────

test("trigger RAISE(ABORT) rolls back all layers and creates no audit", (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);
  store.upsertChat({ chatId: DREAM_CHAT_ID, requested: DREAM_CHAT_ID, title: "T", kind: "channel", isForum: false });
  store.upsertChatMemory({ chatId: DREAM_CHAT_ID, memoryText: "pre", lastConsolidatedMessageId: 1 });
  store.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "f0", note: "n", sourceMessageId: 1 });
  store.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "l0", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 1 });
  store.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "sk0", description: "d", instructions: "i", sourceMessageId: 1 });
  store.close();

  const raw = openRaw(dbPath);
  raw.exec(`CREATE TRIGGER IF NOT EXISTS tr_abort BEFORE INSERT ON bot_chat_dream_audits BEGIN SELECT RAISE(ABORT, 'test-abort'); END;`);
  raw.close();

  const reopened = new MessageStore(dbPath);
  // Exact snapshots of every layer before the aborted commit.
  const memBefore = reopened.getChatMemory(DREAM_CHAT_ID);
  const fastBefore = reopened.listFastChatMemory(DREAM_CHAT_ID);
  const lessonsBefore = reopened.listChatLessons(DREAM_CHAT_ID);
  const skillsBefore = reopened.listChatSkills(DREAM_CHAT_ID);
  const dayBefore = reopened.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
  const auditBefore = reopened.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
  assert.equal(dayBefore, undefined);
  assert.equal(auditBefore, undefined);
  try {
    assert.throws(() => reopened.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 100, completedAtMs: 100 },
      fast: [{ chatId: DREAM_CHAT_ID, title: "would-leak", note: "rb", sourceMessageId: 2, updatedAtMs: 100 }],
      lessons: [{ chatId: DREAM_CHAT_ID, title: "would-leak", problem: "rb", solution: "rb", whenToApply: "rb", sourceMessageId: 2, updatedAtMs: 100 }],
      skills: [{ chatId: DREAM_CHAT_ID, name: "would-leak", description: "rb", instructions: "rb", sourceMessageId: 2, updatedAtMs: 100 }],
      memory: { chatId: DREAM_CHAT_ID, memoryText: "should not persist", lastConsolidatedMessageId: 99, updatedAtMs: 100 },
    }), /test-abort/);

    assert.deepEqual(reopened.getChatMemory(DREAM_CHAT_ID), memBefore);
    assert.deepEqual(reopened.listFastChatMemory(DREAM_CHAT_ID), fastBefore);
    assert.deepEqual(reopened.listChatLessons(DREAM_CHAT_ID), lessonsBefore);
    assert.deepEqual(reopened.listChatSkills(DREAM_CHAT_ID), skillsBefore);
    assert.deepEqual(reopened.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), dayBefore);
    assert.deepEqual(reopened.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), auditBefore);
  } finally { reopened.close(); }
});

// ── Delete key normalization ──────────────────────────────────────────────

test("commitDreamDay rejects duplicate delete keys after normalization", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-audit-");
  try {
    assert.throws(() => store.commitDreamDay({
      day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 100, completedAtMs: 100 },
      fast: [], lessons: [], skills: [],
      deletedFastKeys: ["  Dup  ", "dup"],
    }), /duplicate deleted/);
  } finally { cleanup(); }
});

// ── listDreamAudits corruption: invalid row day ─────────────────────────────

test("listDreamAudits rejects invalid SQL row day", (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);
  store.upsertChat({ chatId: DREAM_CHAT_ID, requested: DREAM_CHAT_ID, title: "T", kind: "channel", isForum: false });
  store.commitDreamDay({
    day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 100, completedAtMs: 100 },
    fast: [], lessons: [], skills: [],
  });
  store.close();

  const raw = openRaw(dbPath);
  raw.exec(`UPDATE bot_chat_dream_audits SET day = 'BAD' WHERE chat_id = '${DREAM_CHAT_ID}' AND day = '${DREAM_YESTERDAY}'`);
  raw.close();

  const reopened = new MessageStore(dbPath);
  try {
    assert.throws(() => reopened.listDreamAudits({ chatId: DREAM_CHAT_ID }), /day must use YYYY-MM-DD|calendar day/);
  } finally { reopened.close(); }
});

// ── listDreamAudits corruption: audit root day mismatch with row ──────────

test("listDreamAudits rejects audit root day mismatch with SQL row", (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);
  store.upsertChat({ chatId: DREAM_CHAT_ID, requested: DREAM_CHAT_ID, title: "T", kind: "channel", isForum: false });
  store.commitDreamDay({
    day: { chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY, status: "completed", interactionCount: 1, attempts: 1, updatedAtMs: 100, completedAtMs: 100 },
    fast: [], lessons: [], skills: [],
  });
  store.close();

  // Mangle the audit_json to have a different day than the row.
  const raw = openRaw(dbPath);
  const row = raw.prepare(`SELECT audit_json FROM bot_chat_dream_audits WHERE chat_id = '${DREAM_CHAT_ID}' AND day = '${DREAM_YESTERDAY}'`).get() as { audit_json: string };
  const audit = JSON.parse(row.audit_json) as Record<string, unknown>;
  audit.day = "2026-01-01";
  const mangled = JSON.stringify(audit);
  raw.exec(`UPDATE bot_chat_dream_audits SET audit_json = '${mangled.replace(/'/g, "''")}' WHERE chat_id = '${DREAM_CHAT_ID}' AND day = '${DREAM_YESTERDAY}'`);
  raw.close();

  const reopened = new MessageStore(dbPath);
  try {
    assert.throws(() => reopened.listDreamAudits({ chatId: DREAM_CHAT_ID }), /Audit root day mismatch with row/);
  } finally { reopened.close(); }
});
