import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANAGED_SEMANTIC_PREFIX } from "../src/hermes-projection/render-memory.js";
import {
  parseOpenClawProjectionOptions,
  runOpenClawProjectionCliMain,
} from "../src/openclaw-projection/cli.js";
import { runOpenClawProjection } from "../src/openclaw-projection/apply.js";
import {
  CHAT_ID,
  seedFastMemory,
  seedMemory,
  tmpDb,
} from "./support/hermes-projection-helpers.js";

test("parseOptions respects kill switch without requiring workspace", () => {
  const skipped = parseOpenClawProjectionOptions(["--apply"], {});
  assert.equal(skipped.disabled, true);
  assert.equal(skipped.apply, true);
});

test("parseOptions dry-run and apply-enabled require workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "parilka-oc-ws-"));
  try {
    const opts = parseOpenClawProjectionOptions(
      ["--workspace", dir, "--db", join(dir, "missing.sqlite")],
      { PARILKA_OPENCLAW_PROJECTION_ENABLED: "true" },
    );
    assert.equal(opts.disabled, false);
    assert.equal(opts.workspace, dir);
  } catch (error) {
    assert.match(String(error), /database path does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply writes managed MEMORY.md into the OpenClaw workspace root", async () => {
  const { store, dbPath, cleanup } = tmpDb();
  const workspace = mkdtempSync(join(tmpdir(), "parilka-oc-mem-"));
  try {
    seedMemory(store, CHAT_ID, "dream fact");
    seedFastMemory(store, CHAT_ID, "note", "keep this", 2000);
    const report = await runOpenClawProjection(store, {
      apply: true,
      dbPath,
      chatId: CHAT_ID,
      workspace,
      lockTimeoutMs: 5_000,
      memoryCharLimit: 8000,
    });
    assert.equal(report.ok, true);
    assert.equal(report.memory.status, "ok");
    const text = readFileSync(join(workspace, "MEMORY.md"), "utf8");
    assert.match(text, new RegExp(MANAGED_SEMANTIC_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(text, /dream fact/);
  } finally {
    cleanup();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("disabled apply reports skipped without touching workspace", async () => {
  const chunks: string[] = [];
  const sink = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const code = await runOpenClawProjectionCliMain(["--apply"], {}, {
    stdout: sink,
    stderr: sink,
  } as Pick<NodeJS.Process, "stdout" | "stderr">);
  assert.equal(code, 0);
  assert.match(chunks.join(""), /skipped_disabled/);
});

test("apply-enabled missing workspace fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parilka-oc-cli-"));
  try {
    writeFileSync(join(dir, "db.sqlite"), "");
    const chunks: string[] = [];
    const code = await runOpenClawProjectionCliMain(
      ["--apply", "--db", join(dir, "db.sqlite"), "--chat", CHAT_ID],
      { PARILKA_OPENCLAW_PROJECTION_ENABLED: "true" },
      {
        stdout: { write(chunk: string) { chunks.push(chunk); return true; } },
        stderr: { write(chunk: string) { chunks.push(chunk); return true; } },
      } as Pick<NodeJS.Process, "stdout" | "stderr">,
    );
    assert.equal(code, 1);
    assert.match(chunks.join(""), /missing_workspace/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
