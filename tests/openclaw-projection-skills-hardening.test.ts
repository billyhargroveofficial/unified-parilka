import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../src/store.js";
import { captureDreamSnapshot } from "../src/openclaw-projection/snapshot.js";
import { applySkills } from "../src/openclaw-projection/skills-managed.js";
import { codepointLength } from "../src/openclaw-projection/render-memory.js";
import {
  CHAT_ID,
  seedSkill,
  seedLesson,
} from "./support/openclaw-projection-helpers.js";

function tmpProfile(): { home: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-shard-"));
  mkdirSync(join(dir, "skills"), { recursive: true });
  return {
    home: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function tmpStore(): { store: MessageStore; cleanup(): void } {
  const store = new MessageStore(":memory:");
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "T",
    kind: "channel",
    isForum: false,
  });
  return { store, cleanup: () => store.close() };
}

function managedRoot(profileHome: string): string {
  return join(profileHome, "skills", "parilka-managed");
}

function skillDirs(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith("parilka-skill-"));
}

function appliedSkillDir(
  profileHome: string,
  store: MessageStore,
): { root: string; dirPath: string } {
  const root = managedRoot(profileHome);
  const dirs = skillDirs(root);
  assert.equal(dirs.length, 1);
  return { root, dirPath: join(root, dirs[0]!) };
}

function readMarker(
  dirPath: string,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dirPath, ".parilka-managed.json"), "utf-8"),
  ) as Record<string, unknown>;
}

test("invalid manifest is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    assert.equal(
      applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home).status,
      "ok",
    );
    const root = managedRoot(profile.home);
    writeFileSync(join(root, ".manifest.json"), "{not json", "utf-8");
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("manifest"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("unowned manifest is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    assert.equal(
      applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home).status,
      "ok",
    );
    const root = managedRoot(profile.home);
    writeFileSync(
      join(root, ".manifest.json"),
      JSON.stringify({ owner: "someone-else", version: 1, entries: {} }),
      "utf-8",
    );
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("manifest"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("manifest drift from disk state is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    assert.equal(
      applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home).status,
      "ok",
    );
    const root = managedRoot(profile.home);
    const manifestPath = join(root, ".manifest.json");
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as { entries: Record<string, { sourceKey: string; contentHash: string }> };
    const name = Object.keys(manifest.entries)[0]!;
    manifest.entries[name]!.contentHash = "deadbeef";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("manifest"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("manifest with extra keys is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    assert.equal(
      applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home).status,
      "ok",
    );
    const root = managedRoot(profile.home);
    const manifestPath = join(root, ".manifest.json");
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as Record<string, unknown>;
    manifest.extra = "junk";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("manifest"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("managed dirs without manifest are conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    assert.equal(
      applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home).status,
      "ok",
    );
    const root = managedRoot(profile.home);
    rmSync(join(root, ".manifest.json"));
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("manifest"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("empty managed root without manifest is accepted", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    const root = managedRoot(profile.home);
    mkdirSync(root, { recursive: true });
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "ok");
    assert.equal(report.created, 1);
    assert.equal(skillDirs(root).length, 1);
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("quarantine leftover is an unexpected conflict, never ignored", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    const root = managedRoot(profile.home);
    mkdirSync(join(root, ".quarantine-1234567890-some-dir"), {
      recursive: true,
    });
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("quarantine"));
    assert.equal(skillDirs(root).length, 0);
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("marker with extra keys is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    assert.equal(
      applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home).status,
      "ok",
    );
    const { dirPath } = appliedSkillDir(profile.home, store);
    const marker = readMarker(dirPath);
    marker.extra = "junk";
    writeFileSync(
      join(dirPath, ".parilka-managed.json"),
      JSON.stringify(marker),
      "utf-8",
    );
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("marker"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("marker contentHash must be exactly 64 lowercase hex", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    assert.equal(
      applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home).status,
      "ok",
    );
    const { dirPath } = appliedSkillDir(profile.home, store);
    for (const contentHash of ["deadbeef", "A".repeat(64), "0".repeat(63)]) {
      const marker = readMarker(dirPath);
      marker.contentHash = contentHash;
      writeFileSync(
        join(dirPath, ".parilka-managed.json"),
        JSON.stringify(marker),
        "utf-8",
      );
      const report = applySkills(
        captureDreamSnapshot(store, CHAT_ID),
        profile.home,
      );
      assert.equal(report.status, "failed");
      assert.ok(report.error!.includes("marker"));
    }
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("marker carries deterministic provenance for single skills", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    const snapshot = captureDreamSnapshot(store, CHAT_ID);
    assert.equal(
      applySkills(snapshot, profile.home).status,
      "ok",
    );
    const { dirPath } = appliedSkillDir(profile.home, store);
    const marker = readMarker(dirPath);
    const skill = snapshot.skills[0]!;
    assert.equal(marker.sourceKey, `skill:${skill.key}`);
    assert.equal(marker.sourceMessageId, skill.sourceMessageId);
    assert.equal(marker.updatedAtMs, skill.updatedAtMs);
    assert.match(marker.contentHash as string, /^[0-9a-f]{64}$/);
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("marker provenance serializes missing sourceMessageId as null", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    store.upsertChatSkill({
      chatId: CHAT_ID,
      name: "No source",
      description: "Desc",
      instructions: "Do.",
      updatedAtMs: 5000,
    });
    const snapshot = captureDreamSnapshot(store, CHAT_ID);
    assert.equal(applySkills(snapshot, profile.home).status, "ok");
    const { dirPath } = appliedSkillDir(profile.home, store);
    const marker = readMarker(dirPath);
    assert.equal(marker.sourceMessageId, null);
    assert.equal(marker.updatedAtMs, 5000);
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("lesson aggregate is newest-first with provenance", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedLesson(store, CHAT_ID, "Old lesson", "Problem old", "Solution old", "Always", 1000);
    seedLesson(store, CHAT_ID, "New lesson", "Problem new", "Solution new", "Sometimes", 2000);
    const snapshot = captureDreamSnapshot(store, CHAT_ID);
    const report = applySkills(snapshot, profile.home);
    assert.equal(report.status, "ok");
    assert.equal(report.lessonsCount, 2);

    const dirPath = join(managedRoot(profile.home), "parilka-lessons");
    const skillMd = readFileSync(join(dirPath, "SKILL.md"), "utf-8");
    assert.ok(skillMd.includes('name: "parilka-lessons"'));
    assert.ok(skillMd.indexOf("New lesson") < skillMd.indexOf("Old lesson"));
    // Provenance: source key, source message id, updated time.
    const newest = snapshot.lessons.find((l) => l.title === "New lesson")!;
    assert.ok(skillMd.includes(`source: ${newest.key}`));
    assert.ok(skillMd.includes(`msg: ${newest.sourceMessageId}`));
    assert.ok(skillMd.includes(`updated: ${newest.updatedAtMs}`));
    const marker = readMarker(dirPath);
    assert.equal(marker.sourceKey, "lessons:aggregate");
    assert.equal(marker.sourceMessageId, newest.sourceMessageId);
    assert.equal(marker.updatedAtMs, newest.updatedAtMs);
    assert.equal(
      marker.contentHash,
      createHash("sha256").update(skillMd).digest("hex"),
    );
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("lesson aggregate honors 100000 codepoint limit including footer", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    // The store caps lesson listing at 64; make each entry large enough to
    // exceed the 100000 codepoint limit with the omission footer included.
    for (let i = 0; i < 64; i++) {
      seedLesson(
        store,
        CHAT_ID,
        `Lesson ${i}`,
        "Проблема: " + "x".repeat(800),
        "Решение: " + "y".repeat(800),
        "Всегда",
        1000 + i,
      );
    }
    const snapshot = captureDreamSnapshot(store, CHAT_ID);
    const total = snapshot.lessons.length;
    assert.ok(total > 0);
    const report = applySkills(snapshot, profile.home);
    assert.equal(report.status, "ok");
    assert.equal(report.lessonsCount, total);

    const skillMd = readFileSync(
      join(managedRoot(profile.home), "parilka-lessons", "SKILL.md"),
      "utf-8",
    );
    assert.ok(codepointLength(skillMd) <= 100_000);
    const footer = skillMd.match(/\*(\d+) lesson\(s\) omitted \(skill size limit\)\*/);
    assert.ok(footer, "expected omission footer");
    const included = (skillMd.match(/^## \d+\./gm) ?? []).length;
    assert.equal(included + Number(footer![1]), total);
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("manifest entries are serialized in stable dirName sort", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Alpha", "A", "One.", 1000);
    seedSkill(store, CHAT_ID, "Beta", "B", "Two.", 2000);
    seedSkill(store, CHAT_ID, "Gamma", "C", "Three.", 3000);
    const snapshot = captureDreamSnapshot(store, CHAT_ID);
    assert.equal(applySkills(snapshot, profile.home).status, "ok");

    const root = managedRoot(profile.home);
    const manifest = JSON.parse(
      readFileSync(join(root, ".manifest.json"), "utf-8"),
    ) as { entries: Record<string, unknown> };
    const keys = Object.keys(manifest.entries);
    assert.deepEqual(keys, [...keys].sort());
    assert.equal(keys.length, snapshot.skills.length);
    // Each dir on disk matches a manifest entry.
    assert.deepEqual(skillDirs(root).sort(), keys.slice().sort());
  } finally {
    cleanup();
    profile.cleanup();
  }
});
