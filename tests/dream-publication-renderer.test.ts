import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { renderDreamAuditPublication } from "../src/storage/dream-publication-renderer.js";
import type { DreamAudit } from "../src/storage/dream-audit-types.js";
import { MessageStore } from "../src/store.js";
import {
  DREAM_CHAT_ID,
  DREAM_YESTERDAY,
  dreamFixtureStore,
} from "./support/dream.js";

function completedDay(updatedAtMs: number) {
  return {
    chatId: DREAM_CHAT_ID,
    day: DREAM_YESTERDAY,
    status: "completed" as const,
    interactionCount: 2,
    attempts: 1,
    updatedAtMs,
    completedAtMs: updatedAtMs,
  };
}

test("Dream digest exposes only bounded record names and never knowledge content", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-publication-renderer-");
  try {
    store.upsertChatMemory({
      chatId: DREAM_CHAT_ID,
      memoryText: "MEMORY_BEFORE_MUST_NOT_LEAK",
      lastConsolidatedMessageId: 1,
    });
    store.upsertFastChatMemory({
      chatId: DREAM_CHAT_ID,
      title: "Updated note",
      note: "UPDATED_NOTE_MUST_NOT_LEAK",
      sourceMessageId: 1,
    });
    store.upsertFastChatMemory({
      chatId: DREAM_CHAT_ID,
      title: "Removed note",
      note: "REMOVED_NOTE_MUST_NOT_LEAK",
      sourceMessageId: 1,
    });
    store.upsertChatLesson({
      chatId: DREAM_CHAT_ID,
      title: "Debug deployment",
      problem: "PROBLEM_MUST_NOT_LEAK",
      solution: "SOLUTION_MUST_NOT_LEAK",
      whenToApply: "WHEN_MUST_NOT_LEAK",
      sourceMessageId: 1,
    });
    store.upsertChatSkill({
      chatId: DREAM_CHAT_ID,
      name: "Safe deploy",
      description: "DESCRIPTION_MUST_NOT_LEAK",
      instructions: "INSTRUCTIONS_MUST_NOT_LEAK",
      sourceMessageId: 1,
    });

    store.commitDreamDay({
      day: completedDay(2_000),
      memory: {
        chatId: DREAM_CHAT_ID,
        memoryText: "MEMORY_AFTER_MUST_NOT_LEAK",
        lastConsolidatedMessageId: 2,
        updatedAtMs: 2_000,
      },
      fast: [
        {
          chatId: DREAM_CHAT_ID,
          title: "Updated note",
          note: "UPDATED_NOTE_REPLACEMENT_MUST_NOT_LEAK",
          sourceMessageId: 2,
          updatedAtMs: 2_000,
        },
        {
          chatId: DREAM_CHAT_ID,
          title: "Fresh\n  note",
          note: "FRESH_NOTE_MUST_NOT_LEAK",
          sourceMessageId: 2,
          updatedAtMs: 2_000,
        },
      ],
      lessons: [{
        chatId: DREAM_CHAT_ID,
        title: "Debug deployment",
        problem: "PROBLEM_REPLACEMENT_MUST_NOT_LEAK",
        solution: "SOLUTION_REPLACEMENT_MUST_NOT_LEAK",
        whenToApply: "WHEN_REPLACEMENT_MUST_NOT_LEAK",
        sourceMessageId: 2,
        updatedAtMs: 2_000,
      }],
      skills: [{
        chatId: DREAM_CHAT_ID,
        name: "Safe deploy",
        description: "DESCRIPTION_REPLACEMENT_MUST_NOT_LEAK",
        instructions: "INSTRUCTIONS_REPLACEMENT_MUST_NOT_LEAK",
        sourceMessageId: 2,
        updatedAtMs: 2_000,
      }],
      deletedFastKeys: ["Removed note"],
    });

    const audit = store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
    assert.ok(audit);
    const publication = renderDreamAuditPublication(audit.audit, 2_000);
    assert.ok(publication);
    assert.equal(publication.plainText, publication.markdown);
    assert.match(publication.plainText, /^🌙 Dream digest · 2026-07-31/m);
    assert.match(publication.plainText, /Memory: updated/);
    assert.match(publication.plainText, /Skills: ~Safe deploy/);
    assert.match(publication.plainText, /Lessons: ~Debug deployment/);
    assert.match(publication.plainText, /Notes: \+Fresh note · ~Updated note · −Removed note/);
    assert.ok(Array.from(publication.plainText).length <= 1_800);
    for (const secret of [
      "MEMORY_BEFORE_MUST_NOT_LEAK",
      "MEMORY_AFTER_MUST_NOT_LEAK",
      "UPDATED_NOTE_REPLACEMENT_MUST_NOT_LEAK",
      "PROBLEM_REPLACEMENT_MUST_NOT_LEAK",
      "SOLUTION_REPLACEMENT_MUST_NOT_LEAK",
      "INSTRUCTIONS_REPLACEMENT_MUST_NOT_LEAK",
    ]) {
      assert.equal(publication.plainText.includes(secret), false, secret);
    }
  } finally {
    cleanup();
  }
});

test("worst-case valid-sized audit is deterministically bounded and never throws", () => {
  const records = (field: "name" | "title", count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      [field]: `${"🧠".repeat(120)}-${String(index)}`,
    }));
  const layer = (field: "name" | "title", count: number) => {
    const created = records(field, count);
    const after = records(field, count);
    const deleted = records(field, count);
    const evicted = records(field, count);
    return {
      created,
      updated: after.map((item) => ({ before: item, after: item })),
      deleted,
      evicted,
      beforeCount: count,
      afterCount: count,
      changed: true,
    };
  };
  const audit = {
    version: 1,
    chatId: DREAM_CHAT_ID,
    day: DREAM_YESTERDAY,
    semanticMemory: { before: null, after: null, changed: false },
    fastMemory: layer("title", 12),
    lessons: layer("title", 64),
    skills: layer("name", 32),
  } as unknown as DreamAudit;

  const publication = renderDreamAuditPublication(audit, 6_000);
  assert.ok(publication);
  assert.ok(Array.from(publication.plainText).length <= 1_800);
  assert.ok(publication.plainText.length <= 4_096);
  assert.match(publication.plainText, /\(\+\d+\)/u);
});

test("Dream commit enqueues one digest atomically and duplicate audit does not enqueue again", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-publication-atomic-");
  try {
    store.commitDreamDay({
      day: completedDay(3_000),
      fast: [{
        chatId: DREAM_CHAT_ID,
        title: "One visible note",
        note: "PRIVATE_NOTE",
        sourceMessageId: 1,
        updatedAtMs: 3_000,
      }],
      lessons: [],
      skills: [],
    });
    const audit = store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
    assert.ok(audit);
    const rendered = renderDreamAuditPublication(audit.audit, 3_000);
    assert.ok(rendered);
    const queued = store.getDreamPublication(rendered.id);
    assert.equal(queued?.status, "queued");
    assert.equal(queued?.plainText, rendered.plainText);

    store.commitDreamDay({
      day: completedDay(4_000),
      fast: [{
        chatId: DREAM_CHAT_ID,
        title: "Must not be written on retry",
        note: "PRIVATE_RETRY_NOTE",
        sourceMessageId: 2,
        updatedAtMs: 4_000,
      }],
      lessons: [],
      skills: [],
    });
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    const claimed = store.claimNextDreamPublication({
      chatId: DREAM_CHAT_ID,
      workerId: "renderer-test:1",
      nowMs: 4_001,
    });
    assert.equal(claimed?.id, rendered.id);
    assert.equal(
      store.claimNextDreamPublication({
        chatId: DREAM_CHAT_ID,
        workerId: "renderer-test:2",
        nowMs: 4_001,
      }),
      undefined,
    );
  } finally {
    cleanup();
  }
});

test("Dream digest is suppressed when only non-semantic bookkeeping changes", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-publication-noop-");
  try {
    store.upsertChatMemory({
      chatId: DREAM_CHAT_ID,
      memoryText: "unchanged semantic memory",
      lastConsolidatedMessageId: 1,
      updatedAtMs: 1_000,
    });
    store.commitDreamDay({
      day: completedDay(2_000),
      memory: {
        chatId: DREAM_CHAT_ID,
        memoryText: "unchanged semantic memory",
        lastConsolidatedMessageId: 2,
        updatedAtMs: 2_000,
      },
      fast: [],
      lessons: [],
      skills: [],
    });
    const audit = store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY });
    assert.ok(audit);
    assert.equal(audit.audit.semanticMemory.changed, true);
    assert.equal(renderDreamAuditPublication(audit.audit, 2_000), undefined);
    assert.equal(
      store.claimNextDreamPublication({
        chatId: DREAM_CHAT_ID,
        workerId: "renderer-test:1",
        nowMs: 2_001,
      }),
      undefined,
    );
  } finally {
    cleanup();
  }
});

test("failed publication enqueue rolls back the complete Dream commit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-dream-publication-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "messages.sqlite");
  const initial = new MessageStore(path);
  initial.upsertChat({
    chatId: DREAM_CHAT_ID,
    requested: DREAM_CHAT_ID,
    title: "Dream test",
    kind: "channel",
    isForum: false,
  });
  initial.close();

  const raw = new DatabaseSync(path);
  raw.exec(
    "CREATE TRIGGER abort_dream_publication BEFORE INSERT ON bot_dream_publications "
      + "BEGIN SELECT RAISE(ABORT, 'publication-abort'); END;",
  );
  raw.close();

  const store = new MessageStore(path);
  try {
    assert.throws(() => store.commitDreamDay({
      day: completedDay(5_000),
      fast: [{
        chatId: DREAM_CHAT_ID,
        title: "Would leak without transaction",
        note: "PRIVATE_ROLLBACK_NOTE",
        sourceMessageId: 1,
        updatedAtMs: 5_000,
      }],
      lessons: [],
      skills: [],
    }), /publication-abort/);
    assert.equal(store.getDreamDay({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), undefined);
    assert.equal(store.getDreamAudit({ chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY }), undefined);
    assert.equal(store.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    assert.equal(
      store.claimNextDreamPublication({
        chatId: DREAM_CHAT_ID,
        workerId: "renderer-test:1",
        nowMs: 5_001,
      }),
      undefined,
    );
  } finally {
    store.close();
  }
});
