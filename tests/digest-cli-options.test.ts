import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CliConfigError,
  parseOptions,
} from "../src/digest-cli/options.js";

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

function responsesEnv(dir: string): Record<string, string> {
  const authPath = join(dir, "codex-auth.json");
  writeFileSync(authPath, "{}\n", { mode: 0o600 });
  return {
    PARILKA_DIGEST_CODEX_AUTH_FILE: authPath,
  };
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
          ],
          responsesEnv(dir),
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
  try {
    const options = parseOptions(
      [
        "--chat",
        "-1001234567890",
        "--db",
        dbPath,
        "--apply",
        "--dream-only",
      ],
      { ...responsesEnv(dir), PARILKA_BOT_ID: "123456789" },
    );
    assert.equal(options.botId, "123456789");
    assert.equal(options.responses?.model, "gpt-5.6-luna");
    assert.equal(options.responses?.serviceTier, "fast");
    assert.equal(options.responses?.authFile, join(dir, "codex-auth.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply accepts only its Codex subscription auth path, never an API-key environment value", () => {
  const { dbPath, dir } = tempDbPath();
  try {
    assert.throws(
      () => parseOptions(
        ["--chat", "-1001234567890", "--db", dbPath, "--apply", "--bot-id", "123456789"],
        { OPENAI_API_KEY: "must-not-be-read" },
      ),
      (error: unknown) =>
        error instanceof CliConfigError && error.code === "missing_codex_auth_file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply requires an absolute Codex subscription auth path", () => {
  const { dbPath, dir } = tempDbPath();
  try {
    assert.throws(
      () => parseOptions(
        ["--chat", "-1001234567890", "--db", dbPath, "--apply", "--bot-id", "123456789"],
        { PARILKA_DIGEST_CODEX_AUTH_FILE: "relative-auth.json" },
      ),
      (error: unknown) =>
        error instanceof CliConfigError && error.code === "path_not_absolute",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
