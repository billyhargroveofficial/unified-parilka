import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../src/store.js";
import { captureDreamSnapshot } from "../src/hermes-projection/snapshot.js";
import {
  skillDirName,
  renderSkillMd,
  skillContentHash,
} from "../src/hermes-projection/render-skills.js";
import { applySkills } from "../src/hermes-projection/skills-managed.js";
import {
  CHAT_ID,
  seedSkill,
} from "./support/hermes-projection-helpers.js";

function tmpProfile(): { home: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-skills-"));
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

function seededSkillSnapshot(
  store: MessageStore,
  name = "Test Skill",
  description = "A test skill",
  instructions = "Do the thing.",
): ReturnType<typeof captureDreamSnapshot> {
  seedSkill(store, CHAT_ID, name, description, instructions, 1000);
  return captureDreamSnapshot(store, CHAT_ID);
}

test("managed skill is created with SKILL.md, marker, manifest", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store);
    const report = applySkills(snapshot, profile.home);
    assert.equal(report.status, "ok");
    assert.equal(report.created, 1);

    const root = managedRoot(profile.home);
    const dirs = skillDirs(root);
    assert.equal(dirs.length, 1);
    const dirPath = join(root, dirs[0]!);
    assert.equal(dirs[0], skillDirName(snapshot.skills[0]!.key));

    const skillMd = readFileSync(join(dirPath, "SKILL.md"), "utf-8");
    const marker = JSON.parse(
      readFileSync(join(dirPath, ".parilka-managed.json"), "utf-8"),
    ) as {
      owner: string;
      version: number;
      sourceKey: string;
      contentHash: string;
    };
    assert.equal(marker.owner, "parilka-unified");
    assert.equal(marker.version, 1);
    assert.equal(marker.sourceKey, `skill:${snapshot.skills[0]!.key}`);
    // Marker contentHash is the sha256 of the actual SKILL.md bytes.
    assert.equal(
      marker.contentHash,
      createHash("sha256").update(skillMd).digest("hex"),
    );
    // Frontmatter name is exactly the directory name, JSON-quoted.
    assert.ok(skillMd.includes(`name: ${JSON.stringify(dirs[0])}`));
    const manifest = JSON.parse(
      readFileSync(join(root, ".manifest.json"), "utf-8"),
    ) as { owner: string; version: number; entries: Record<string, unknown> };
    assert.equal(manifest.owner, "parilka-unified");
    assert.equal(manifest.version, 1);
    assert.deepEqual(Object.keys(manifest.entries), [dirs[0]]);
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("idempotent second apply produces byte-identical files", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store);
    assert.equal(applySkills(snapshot, profile.home).status, "ok");

    const root = managedRoot(profile.home);
    const dirPath = join(root, skillDirs(root)[0]!);
    const before = {
      md: readFileSync(join(dirPath, "SKILL.md"), "utf-8"),
      marker: readFileSync(join(dirPath, ".parilka-managed.json"), "utf-8"),
      manifest: readFileSync(join(root, ".manifest.json"), "utf-8"),
    };

    const second = applySkills(snapshot, profile.home);
    assert.equal(second.status, "ok");
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.removed, 0);
    assert.equal(
      readFileSync(join(dirPath, "SKILL.md"), "utf-8"),
      before.md,
    );
    assert.equal(
      readFileSync(join(dirPath, ".parilka-managed.json"), "utf-8"),
      before.marker,
    );
    assert.equal(
      readFileSync(join(root, ".manifest.json"), "utf-8"),
      before.manifest,
    );
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("owner skill outside managed root is never touched", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store, "Managed", "Managed skill", "Managed instructions.");
    const ownerSkillDir = join(profile.home, "skills", "owner-skill");
    mkdirSync(ownerSkillDir, { recursive: true });
    writeFileSync(join(ownerSkillDir, "SKILL.md"), "owner content", "utf-8");

    assert.equal(applySkills(snapshot, profile.home).status, "ok");
    assert.equal(
      readFileSync(join(ownerSkillDir, "SKILL.md"), "utf-8"),
      "owner content",
    );
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("non-managed dir inside managed root is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store, "Skill", "Desc", "Instructions.");
    const root = managedRoot(profile.home);
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "foreign-dir"));
    const report = applySkills(snapshot, profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("foreign-dir"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("desired dir without valid owned marker is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store, "Skill", "Desc", "Instructions.");
    const dirName = skillDirName(snapshot.skills[0]!.key);
    const root = managedRoot(profile.home);
    mkdirSync(join(root, dirName), { recursive: true });
    writeFileSync(join(root, dirName, "SKILL.md"), "content", "utf-8");
    // No .parilka-managed.json marker.
    const report = applySkills(snapshot, profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes(dirName));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("manual drift in managed skill is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snap1 = seededSkillSnapshot(store, "Skill", "Desc", "Instructions.");
    assert.equal(applySkills(snap1, profile.home).status, "ok");

    const root = managedRoot(profile.home);
    const dirPath = join(root, skillDirs(root)[0]!);
    writeFileSync(join(dirPath, "SKILL.md"), "manually modified content", "utf-8");

    seedSkill(store, CHAT_ID, "Skill", "Updated Desc", "Updated Instructions.", 2000);
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("drift"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("unexpected file in managed dir is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store, "Skill", "Desc", "Instructions.");
    assert.equal(applySkills(snapshot, profile.home).status, "ok");
    const root = managedRoot(profile.home);
    const dirPath = join(root, skillDirs(root)[0]!);
    writeFileSync(join(dirPath, "extra.txt"), "extra", "utf-8");
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("extra.txt"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("symlinked SKILL.md fails closed", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store, "Skill", "Desc", "Instructions.");
    assert.equal(applySkills(snapshot, profile.home).status, "ok");
    const root = managedRoot(profile.home);
    const dirPath = join(root, skillDirs(root)[0]!);
    rmSync(join(dirPath, "SKILL.md"), { force: true });
    symlinkSync("/etc/hostname", join(dirPath, "SKILL.md"));
    const report = applySkills(captureDreamSnapshot(store, CHAT_ID), profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("symlink"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("symlinked dir inside managed root is conflict", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store, "Skill", "Desc", "Instructions.");
    const root = managedRoot(profile.home);
    mkdirSync(root, { recursive: true });
    symlinkSync(tmpdir(), join(root, "evil-link"));
    const report = applySkills(snapshot, profile.home);
    assert.equal(report.status, "failed");
    assert.ok(report.error!.includes("evil-link"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("stale managed skill is quarantined then removed, no leftovers", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store, "Skill", "Desc", "Instructions.");
    assert.equal(applySkills(snapshot, profile.home).status, "ok");
    const root = managedRoot(profile.home);
    assert.equal(skillDirs(root).length, 1);

    const emptyStore = new MessageStore(":memory:");
    try {
      emptyStore.upsertChat({
        chatId: CHAT_ID,
        requested: CHAT_ID,
        title: "T",
        kind: "channel",
        isForum: false,
      });
      const report = applySkills(
        captureDreamSnapshot(emptyStore, CHAT_ID),
        profile.home,
      );
      assert.equal(report.status, "ok");
      assert.equal(report.removed, 1);
    } finally {
      emptyStore.close();
    }
    assert.equal(skillDirs(root).length, 0);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith(".quarantine-")),
      false,
    );
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("stale dir with unexpected file is conflict, not removed", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    const snapshot = seededSkillSnapshot(store, "Skill", "Desc", "Instructions.");
    assert.equal(applySkills(snapshot, profile.home).status, "ok");
    const root = managedRoot(profile.home);
    writeFileSync(join(root, skillDirs(root)[0]!, "extra.txt"), "x", "utf-8");

    const emptyStore = new MessageStore(":memory:");
    try {
      emptyStore.upsertChat({
        chatId: CHAT_ID,
        requested: CHAT_ID,
        title: "T",
        kind: "channel",
        isForum: false,
      });
      const report = applySkills(
        captureDreamSnapshot(emptyStore, CHAT_ID),
        profile.home,
      );
      assert.equal(report.status, "failed");
      assert.ok(report.error!.includes("extra.txt"));
      assert.equal(skillDirs(root).length, 1);
    } finally {
      emptyStore.close();
    }
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("dry-run counts intended ops and conflicts without writes", () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill A", "Desc A", "Instructions A.", 1000);
    seedSkill(store, CHAT_ID, "Skill B", "Desc B", "Instructions B.", 2000);
    const snapshot = captureDreamSnapshot(store, CHAT_ID);

    const dry = applySkills(snapshot, profile.home, { dryRun: true });
    assert.equal(dry.status, "ok");
    assert.equal(dry.created, 2);
    assert.equal(dry.updated, 0);
    assert.equal(dry.removed, 0);
    assert.ok(!existsSync(managedRoot(profile.home)));

    // Conflict in dry-run: failed, still no writes.
    const root = managedRoot(profile.home);
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "foreign-dir"));
    const dryConflict = applySkills(snapshot, profile.home, { dryRun: true });
    assert.equal(dryConflict.status, "failed");
    assert.ok(dryConflict.error!.includes("foreign-dir"));
    assert.equal(skillDirs(root).length, 0);

    // Real apply then writes everything (conflict source removed).
    rmSync(join(root, "foreign-dir"), { recursive: true, force: true });
    const applied = applySkills(snapshot, profile.home);
    assert.equal(applied.status, "ok");
    assert.equal(applied.created, 2);
    assert.equal(skillDirs(root).length, 2);
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("skill markdown: frontmatter name is exactly the dir name, JSON-quoted", () => {
  const skill: Parameters<typeof renderSkillMd>[0] = {
    chatId: CHAT_ID,
    key: "deploy-check",
    name: "Deploy Check",
    description: "Pre-deployment checklist for production releases.",
    instructions: "1. Run tests\n2. Check config\n3. Deploy",
    sourceMessageId: 42,
    createdAtMs: 1000,
    updatedAtMs: 2000,
  };
  const dirName = "parilka-skill-0123456789abcdef";
  const md = renderSkillMd(skill, dirName);
  assert.ok(md.startsWith("---\n"));
  assert.ok(md.includes(`name: ${JSON.stringify(dirName)}`));
  assert.ok(md.includes(`description: ${JSON.stringify(skill.description)}`));
  assert.ok(md.includes("# Deploy Check"));
  assert.ok(md.includes("**Instructions:**"));
  assert.ok(md.includes("*Provenance: source: deploy-check msg: 42 updated: 2000*"));
});

test("skill markdown: description limited to 60 codepoints", () => {
  const skill: Parameters<typeof renderSkillMd>[0] = {
    chatId: CHAT_ID,
    key: "emoji-desc",
    name: "Emoji",
    description: "😀".repeat(70),
    instructions: "Do.",
    createdAtMs: 1000,
    updatedAtMs: 2000,
  };
  const md = renderSkillMd(skill, "parilka-skill-abc");
  const match = md.match(/^description: (.+)$/m)!;
  const value = JSON.parse(match[1]!) as string;
  assert.ok(Array.from(value).length <= 60);
  assert.ok(value.endsWith("..."));
});

test("skill content hash equals sha256 of final SKILL.md bytes", () => {
  const skill: Parameters<typeof renderSkillMd>[0] = {
    chatId: CHAT_ID,
    key: "test-skill",
    name: "Test Skill",
    description: "Testing.",
    instructions: "Do the thing.",
    sourceMessageId: 7,
    createdAtMs: 1000,
    updatedAtMs: 2000,
  };
  const dirName = "parilka-skill-abcdef0123456789";
  const expected = createHash("sha256")
    .update(renderSkillMd(skill, dirName))
    .digest("hex");
  assert.equal(skillContentHash(skill, dirName), expected);
});

test("seedSkill keys map to stable parilka-skill- dir names", () => {
  const { store, cleanup } = tmpStore();
  try {
    seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
    const snapshot = captureDreamSnapshot(store, CHAT_ID);
    const key = snapshot.skills[0]!.key;
    const expected = `parilka-skill-${createHash("sha256")
      .update(key)
      .digest("hex")
      .slice(0, 16)}`;
    assert.equal(skillDirName(key), expected);
    assert.match(expected, /^parilka-skill-[0-9a-f]{16}$/);
  } finally {
    cleanup();
  }
});
