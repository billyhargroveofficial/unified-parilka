import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseBotRuntimeConfig, safeBotRuntimeConfig } from "../src/bot/runtime-config.js";

test("Responses bot runtime config is explicit, secret-safe, and pins Luna fast", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "token");
  const authFile = join(directory, "codex-auth");
  writeFileSync(tokenFile, "123456789:abcdefghijklmnopqrstuvwxyz_ABCD\n", { mode: 0o600 });
  writeFileSync(authFile, '{"auth_mode":"chatgpt","tokens":{"access_token":"fake","refresh_token":"fake"}}', { mode: 0o600 });
  const config = parseBotRuntimeConfig({
    PARILKA_BOT_TOKEN_FILE: tokenFile,
    PARILKA_BOT_EXCLUSIVE_POLLER: "true",
    PARILKA_BOT_CHAT_ID: "-1003179772905",
    PARILKA_BOT_ID: "123456789",
    PARILKA_BOT_USERNAME: "@ParilkaBot",
    PARILKA_BOT_DB_PATH: join(directory, "shared.sqlite"),
    TELEGRAM_DB_PATH: join(directory, "shared.sqlite"),
    PARILKA_BOT_CODEX_AUTH_FILE: authFile,
  });
  assert.equal(config.mode, "shadow");
  assert.equal(config.responses.model, "gpt-5.6-luna");
  assert.equal(config.responses.serviceTier, "fast");
  assert.equal(config.responses.turnTimeoutMs, 180_000);
  assert.equal(config.rag.vector.embeddings.backend, "local_bge_m3");
  const safe = JSON.stringify(safeBotRuntimeConfig(config));
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz_ABCD/u);
  assert.doesNotMatch(safe, /codex-auth|refresh_token/u);
});

test("runtime config refuses implicit poller ownership and diverging databases", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-config-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const authFile = join(directory, "codex-auth");
  writeFileSync(authFile, '{"auth_mode":"chatgpt","tokens":{"access_token":"fake","refresh_token":"fake"}}', { mode: 0o600 });
  const valid = {
    PARILKA_BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
    PARILKA_BOT_EXCLUSIVE_POLLER: "true",
    PARILKA_BOT_CHAT_ID: "-1003179772905",
    PARILKA_BOT_ID: "123456789",
    PARILKA_BOT_USERNAME: "ParilkaBot",
    PARILKA_BOT_DB_PATH: join(directory, "shared.sqlite"),
    TELEGRAM_DB_PATH: join(directory, "shared.sqlite"),
    PARILKA_BOT_CODEX_AUTH_FILE: authFile,
  };
  assert.throws(() => parseBotRuntimeConfig({ ...valid, PARILKA_BOT_EXCLUSIVE_POLLER: "false" }), /EXCLUSIVE_POLLER/u);
  assert.throws(() => parseBotRuntimeConfig({ ...valid, TELEGRAM_DB_PATH: join(directory, "other.sqlite") }), /same shared SQLite/u);
  assert.throws(() => parseBotRuntimeConfig({ ...valid, PARILKA_BOT_WORKERS: "2" }), /PARILKA_BOT_WORKERS/u);
});

test("token file is fail-closed against symlink, permissive mode, and oversized input", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-token-file-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "token");
  const authFile = join(directory, "codex-auth");
  writeFileSync(authFile, '{"auth_mode":"chatgpt","tokens":{"access_token":"fake","refresh_token":"fake"}}', { mode: 0o600 });
  writeFileSync(tokenFile, "123456789:abcdefghijklmnopqrstuvwxyz_ABCD\n", { mode: 0o600 });
  const env = validTokenFileEnvironment(directory, tokenFile, authFile);

  const tokenTarget = join(directory, "token-target");
  writeFileSync(tokenTarget, "123456789:abcdefghijklmnopqrstuvwxyz_ABCD\n", { mode: 0o600 });
  unlinkSync(tokenFile);
  symlinkSync(tokenTarget, tokenFile);
  assert.throws(() => parseBotRuntimeConfig(env), /regular non-symlink/u);

  unlinkSync(tokenFile);
  writeFileSync(tokenFile, "123456789:abcdefghijklmnopqrstuvwxyz_ABCD\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o644);
  assert.throws(() => parseBotRuntimeConfig(env), /mode 0400 or 0600/u);

  chmodSync(tokenFile, 0o600);
  writeFileSync(tokenFile, "x".repeat(4_097), { mode: 0o600 });
  assert.throws(() => parseBotRuntimeConfig(env), /bounded one-line/u);
});

function validTokenFileEnvironment(directory: string, tokenFile: string, authFile: string): Record<string, string> {
  const dbPath = join(directory, "shared.sqlite");
  return {
    PARILKA_BOT_TOKEN_FILE: tokenFile,
    PARILKA_BOT_EXCLUSIVE_POLLER: "true",
    PARILKA_BOT_CHAT_ID: "-1003179772905",
    PARILKA_BOT_ID: "123456789",
    PARILKA_BOT_USERNAME: "ParilkaBot",
    PARILKA_BOT_DB_PATH: dbPath,
    TELEGRAM_DB_PATH: dbPath,
    PARILKA_BOT_CODEX_AUTH_FILE: authFile,
  };
}
