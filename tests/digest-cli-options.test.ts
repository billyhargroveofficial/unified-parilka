import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CliConfigError, parseOptions } from "../src/digest-cli/options.js";

function tempDbPath(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-digest-cli-"));
  const dbPath = join(dir, "state.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY);
    PRAGMA user_version = 20;
  `);
  db.close();
  return { dbPath, dir };
}

test("dry-run digest does not require bot id", () => {
  const { dbPath, dir } = tempDbPath();
  try {
    const options = parseOptions(
      ["--chat", "-1001234567890", "--db", dbPath],
      {},
    );
    assert.equal(options.apply, false);
    assert.equal(options.dreamOnly, false);
    assert.equal(options.botId, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply --dream-only without bot id fails clearly", () => {
  const { dbPath, dir } = tempDbPath();
  const modelConfigPath = join(dir, "model-router.json");
  writeFileSync(modelConfigPath, "{}");
  try {
    assert.throws(
      () =>
        parseOptions(
          [
            "--chat",
            "-1001234567890",
            "--db",
            dbPath,
            "--apply",
            "--dream-only",
            "--model-config",
            modelConfigPath,
          ],
          {},
        ),
      (error: unknown) =>
        error instanceof CliConfigError && error.code === "missing_bot_id",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply --dream-only accepts bot id from env", () => {
  const { dbPath, dir } = tempDbPath();
  const modelConfigPath = join(dir, "model-router.json");
  writeFileSync(modelConfigPath, "{}");
  try {
    const options = parseOptions(
      [
        "--chat",
        "-1001234567890",
        "--db",
        dbPath,
        "--apply",
        "--dream-only",
        "--model-config",
        modelConfigPath,
      ],
      { PARILKA_BOT_ID: "123456789" },
    );
    assert.equal(options.botId, "123456789");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
