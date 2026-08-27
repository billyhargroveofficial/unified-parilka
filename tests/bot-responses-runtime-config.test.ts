import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  assertBotCodexAuthFile,
  parseBotResponsesRuntimeConfig,
  safeBotResponsesRuntimeConfig,
} from "../src/bot/responses/runtime-config.js";

const FAKE_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: "not-a-real-token", refresh_token: "not-a-real-refresh-token" },
});

test("Responses runtime pins Luna/Fast and redacts shared subscription auth state", (t) => {
  const directory = fixtureDirectory(t);
  const authFile = writeAuth(directory);
  const config = parseBotResponsesRuntimeConfig({ PARILKA_BOT_CODEX_AUTH_FILE: authFile });

  assert.deepEqual(config, {
    authFile,
    model: "gpt-5.6-luna",
    serviceTier: "fast",
    turnTimeoutMs: 180_000,
  });
  assert.doesNotThrow(() => assertBotCodexAuthFile(config));
  const safe = JSON.stringify(safeBotResponsesRuntimeConfig(config));
  assert.doesNotMatch(safe, /not-a-real-(?:token|refresh-token)|codex-auth/u);
  assert.match(safe, /subscriptionAuthConfigured/u);
});

test("Codex auth state fails closed for missing path, symlink, and non-0600 mode", (t) => {
  const directory = fixtureDirectory(t);
  const authFile = writeAuth(directory);
  assert.throws(
    () => parseBotResponsesRuntimeConfig({}),
    /PARILKA_BOT_CODEX_AUTH_FILE is required/u,
  );
  assert.throws(
    () => parseBotResponsesRuntimeConfig({ PARILKA_BOT_CODEX_AUTH_FILE: "relative-auth" }),
    /absolute path/u,
  );

  const target = join(directory, "auth-target");
  writeFileSync(target, FAKE_AUTH, { mode: 0o600 });
  unlinkSync(authFile);
  symlinkSync(target, authFile);
  assert.throws(
    () => parseBotResponsesRuntimeConfig({ PARILKA_BOT_CODEX_AUTH_FILE: authFile }),
    /regular non-symlink/u,
  );

  unlinkSync(authFile);
  writeFileSync(authFile, FAKE_AUTH, { mode: 0o600 });
  chmodSync(authFile, 0o400);
  assert.throws(
    () => parseBotResponsesRuntimeConfig({ PARILKA_BOT_CODEX_AUTH_FILE: authFile }),
    /mode 0600/u,
  );
  chmodSync(authFile, 0o644);
  assert.throws(
    () => parseBotResponsesRuntimeConfig({ PARILKA_BOT_CODEX_AUTH_FILE: authFile }),
    /mode 0600/u,
  );
});

function fixtureDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "parilka-responses-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeAuth(directory: string): string {
  const authFile = join(directory, "codex-auth");
  writeFileSync(authFile, FAKE_AUTH, { mode: 0o600 });
  chmodSync(authFile, 0o600);
  return authFile;
}
