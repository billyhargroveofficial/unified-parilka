import assert from "node:assert/strict";
import { test } from "node:test";
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
import {
  createDriftBackup,
  runProjection,
  runProjectionWithLocks,
} from "../src/hermes-projection/apply.js";
import {
  codepointLength,
  MANAGED_SEMANTIC_PREFIX,
} from "../src/hermes-projection/render-memory.js";
import {
  CHAT_ID,
  seedMemory,
  seedFastMemory,
} from "./support/hermes-projection-helpers.js";

const CONFIG = "memory:\n  memory_char_limit: 8000\n";

function tmpProfile(
  configYaml: string = CONFIG,
  withMemories = true,
): { home: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-apply-"));
  if (withMemories) {
    mkdirSync(join(dir, "memories"), { recursive: true });
  }
  writeFileSync(join(dir, "config.yaml"), configYaml, "utf-8");
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

function projectionOptions(
  home: string,
  apply: boolean,
): Parameters<typeof runProjection>[1] {
  return {
    apply,
    dbPath: "/tmp/unused.sqlite",
    chatId: CHAT_ID,
    profileHome: home,
    lockTimeoutMs: 5000,
  };
}

test("apply: writes owner first, no trailing newline, counts from result", async () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "semantic text", 1, 42);
    seedFastMemory(store, CHAT_ID, "fast", "note", 1000);
    writeFileSync(
      join(profile.home, "memories", "MEMORY.md"),
      "owner note",
      "utf-8",
    );
    const report = await runProjection(
      store,
      projectionOptions(profile.home, true),
    );
    assert.equal(report.mode, "applied");
    assert.equal(report.memory.status, "ok");
    const written = readFileSync(
      join(profile.home, "memories", "MEMORY.md"),
      "utf-8",
    );
    assert.ok(written.startsWith("owner note"));
    assert.ok(written.includes(MANAGED_SEMANTIC_PREFIX));
    assert.equal(written.endsWith("\n"), false);
    assert.equal(report.memory.managedEntries, 2);
    assert.equal(report.memory.totalChars, codepointLength(written));
    assert.equal(report.memory.ownerChars, codepointLength("owner note"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("apply: drift backs up exact raw and aborts without overwrite", async () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "semantic", 1);
    const drifted = "abc  \n§\ndef";
    writeFileSync(
      join(profile.home, "memories", "MEMORY.md"),
      drifted,
      "utf-8",
    );
    const report = await runProjection(
      store,
      projectionOptions(profile.home, true),
    );
    assert.equal(report.memory.status, "failed");
    assert.ok(report.memory.error!.includes("roundtrip"));
    assert.equal(report.ok, false);
    const memories = readdirSync(join(profile.home, "memories"));
    const backups = memories.filter((name) => name.startsWith("MEMORY.md.bak."));
    assert.equal(backups.length, 1);
    assert.equal(
      readFileSync(join(profile.home, "memories", backups[0]!), "utf-8"),
      drifted,
    );
    assert.equal(
      readFileSync(join(profile.home, "memories", "MEMORY.md"), "utf-8"),
      drifted,
    );
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("dry-run: drift is reported as failure but nothing is written", async () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "semantic", 1);
    const drifted = "abc  \n§\ndef";
    writeFileSync(
      join(profile.home, "memories", "MEMORY.md"),
      drifted,
      "utf-8",
    );
    const report = await runProjection(
      store,
      projectionOptions(profile.home, false),
    );
    assert.equal(report.mode, "dry_run");
    assert.equal(report.memory.status, "failed");
    assert.ok(report.memory.error!.includes("roundtrip"));
    const memories = readdirSync(join(profile.home, "memories"));
    assert.equal(
      memories.some((name) => name.startsWith("MEMORY.md.bak.")),
      false,
    );
    assert.equal(
      readFileSync(join(profile.home, "memories", "MEMORY.md"), "utf-8"),
      drifted,
    );
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("apply: oversize reports no write", async () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "s".repeat(4000), 1);
    const owner = "y".repeat(5000);
    writeFileSync(
      join(profile.home, "memories", "MEMORY.md"),
      owner,
      "utf-8",
    );
    const report = await runProjection(
      store,
      projectionOptions(profile.home, true),
    );
    assert.equal(report.memory.status, "oversize");
    assert.equal(report.ok, false);
    assert.equal(
      readFileSync(join(profile.home, "memories", "MEMORY.md"), "utf-8"),
      owner,
    );
    assert.ok(report.memory.totalChars > report.memory.limit);
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("apply: sizing uses codepoints, not bytes", async () => {
  const profile = tmpProfile("memory:\n  memory_char_limit: 600\n");
  const { store, cleanup } = tmpStore();
  try {
    // 300 emoji = 300 codepoints but 1200 bytes; still fits the 600 limit.
    seedMemory(store, CHAT_ID, "😀".repeat(300), 1);
    const report = await runProjection(
      store,
      projectionOptions(profile.home, true),
    );
    assert.equal(report.memory.status, "ok");
    assert.ok(report.memory.totalChars <= 600);
    const written = readFileSync(
      join(profile.home, "memories", "MEMORY.md"),
      "utf-8",
    );
    assert.ok(Buffer.byteLength(written, "utf-8") > 600);
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("apply: symlinked MEMORY.md fails closed", async () => {
  const profile = tmpProfile();
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "semantic", 1);
    const target = join(profile.home, "outside.md");
    writeFileSync(target, "secret", "utf-8");
    symlinkSync(target, join(profile.home, "memories", "MEMORY.md"));
    const report = await runProjection(
      store,
      projectionOptions(profile.home, true),
    );
    assert.equal(report.memory.status, "failed");
    assert.ok(report.memory.error!.includes("symlink"));
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("locks: apply creates memories dir; dry-run requires it", async () => {
  const profile = tmpProfile(CONFIG, false);
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "semantic", 1);
    const applied = await runProjectionWithLocks(
      store,
      projectionOptions(profile.home, true),
    );
    assert.equal(applied.memory.status, "ok");
    assert.ok(existsSync(join(profile.home, "memories", "MEMORY.md")));
    assert.equal(applied.lock?.mechanism, "fcntl_flock");
    assert.equal(applied.lock?.acquired, true);

    const fresh = tmpProfile(CONFIG, false);
    try {
      await assert.rejects(
        runProjectionWithLocks(store, projectionOptions(fresh.home, false)),
        /memories directory is missing/,
      );
    } finally {
      fresh.cleanup();
    }
  } finally {
    cleanup();
    profile.cleanup();
  }
});

test("drift backup is exact and named .bak.<epoch>", () => {
  const profile = tmpProfile();
  try {
    const memoryPath = join(profile.home, "memories", "MEMORY.md");
    const content = "exact  content\n§\nwith spaces ";
    writeFileSync(memoryPath, content, "utf-8");
    const bakPath = createDriftBackup(profile.home, content);
    assert.ok(bakPath.includes(".bak."));
    assert.equal(readFileSync(bakPath, "utf-8"), content);
  } finally {
    profile.cleanup();
  }
});
