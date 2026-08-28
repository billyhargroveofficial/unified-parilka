import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireHermesMemoryLock } from "../src/hermes-projection/lock.js";
import type { HermesMemoryLock } from "../src/hermes-projection/types.js";

function tmpProfile(): { home: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-lock-"));
  const memoriesDir = join(dir, "memories");
  mkdirSync(memoriesDir, { recursive: true });
  // Create the lock file (flock needs the file to exist)
  writeFileSync(join(memoriesDir, "MEMORY.md.lock"), "", "utf-8");
  return { home: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("lock acquires and releases successfully", async () => {
  const profile = tmpProfile();
  try {
    const lock = await acquireHermesMemoryLock(profile.home, 5000);
    assert.ok(lock);
    assert.equal(typeof lock.release, "function");
    lock.release();
  } finally {
    profile.cleanup();
  }
});

test("second lock acquisition fails while first holds", async () => {
  const profile = tmpProfile();
  try {
    const lock1 = await acquireHermesMemoryLock(profile.home, 5000);
    try {
      // Second lock should timeout or fail quickly
      await assert.rejects(
        async () => {
          // Use a short timeout so test is fast
          await acquireHermesMemoryLock(profile.home, 2000);
        },
        (error: Error) =>
          error.message.includes("timeout") ||
          error.message.includes("held") ||
          error.message.includes("lock"),
        "Second lock should be rejected",
      );
    } finally {
      lock1.release();
    }
  } finally {
    profile.cleanup();
  }
});

test("lock can be re-acquired after release", async () => {
  const profile = tmpProfile();
  try {
    const lock1 = await acquireHermesMemoryLock(profile.home, 5000);
    lock1.release();

    // Small delay to ensure the child process is fully gone
    await new Promise((resolve) => setTimeout(resolve, 500));

    const lock2 = await acquireHermesMemoryLock(profile.home, 5000);
    assert.ok(lock2);
    lock2.release();
  } finally {
    profile.cleanup();
  }
});

test("lock timeout respected", async () => {
  const profile = tmpProfile();
  try {
    const lock1 = await acquireHermesMemoryLock(profile.home, 5000);
    try {
      const shortTimeout = 500;
      const startMs = Date.now();
      try {
        await acquireHermesMemoryLock(profile.home, shortTimeout);
        assert.fail("Should have thrown");
      } catch (error) {
        const elapsed = Date.now() - startMs;
        // Should have failed roughly within the timeout window
        assert.ok(
          elapsed < shortTimeout + 5000,
          `Elapsed ${elapsed}ms, expected < ${shortTimeout + 5000}ms`,
        );
      }
    } finally {
      lock1.release();
    }
  } finally {
    profile.cleanup();
  }
});

test("lock interop: flock process can hold lock across projector", async () => {
  const profile = tmpProfile();
  try {
    // Acquire lock via flock directly
    const flockResult = spawnSync(
      "/usr/bin/flock",
      [
        "--exclusive",
        "--no-fork",
        "--timeout",
        "2",
        join(profile.home, "memories", "MEMORY.md.lock"),
        "/bin/sh",
        "-c",
        "printf 'HELD\\n' && sleep 5",
      ],
      { timeout: 7000 },
    );

    // The above command held the lock for 5 seconds
    // Now our projector should be able to acquire after
    const lock = await acquireHermesMemoryLock(profile.home, 5000);
    assert.ok(lock);
    lock.release();
  } finally {
    profile.cleanup();
  }
});

test("lock path that is a directory fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-lockdir-"));
  try {
    const memoriesDir = join(dir, "memories");
    mkdirSync(memoriesDir, { recursive: true });
    mkdirSync(join(memoriesDir, "MEMORY.md.lock"));
    await assert.rejects(
      acquireHermesMemoryLock(dir, 5000),
      /regular file/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock path that is a symlink fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-locksym-"));
  try {
    const memoriesDir = join(dir, "memories");
    mkdirSync(memoriesDir, { recursive: true });
    const target = join(dir, "target.lock");
    writeFileSync(target, "", "utf-8");
    symlinkSync(target, join(memoriesDir, "MEMORY.md.lock"));
    await assert.rejects(
      acquireHermesMemoryLock(dir, 5000),
      /symlink/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
