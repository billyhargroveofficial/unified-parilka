import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const unit = readFileSync(resolve("systemd/parilka-bot.service"), "utf8");
const preflightUnit = readFileSync(
  resolve("systemd/parilka-bot-preflight.service"),
  "utf8",
);
const maintainUnit = readFileSync(
  resolve("systemd/parilka-maintain.service"),
  "utf8",
);
const maintainTimer = readFileSync(
  resolve("systemd/parilka-maintain.timer"),
  "utf8",
);
const botLauncher = readFileSync(resolve("bin/parilka-bot"), "utf8");
const botEnvironmentSlice = readFileSync(
  resolve("config/parilka-bot.env.example"),
  "utf8",
);
const maintainEnvironmentSlice = readFileSync(
  resolve("config/parilka-maintain.env.example"),
  "utf8",
);
const sharedEnvironmentTemplate = readFileSync(resolve(".env.example"), "utf8");
const readme = readFileSync(resolve("README.md"), "utf8");
const botLockHelper = readFileSync(resolve("bin/parilka-bot-lock.mjs"), "utf8");

test("parilka-bot unit owns polling and injects its shared Codex subscription state", () => {
  assert.match(unit, /^After=network-online\.target parilka-sync\.service$/mu);
  assert.match(unit, /^Wants=network-online\.target parilka-sync\.service$/mu);
  assert.match(unit, /^Conflicts=hermes-gateway-parilka\.service$/mu);
  assert.match(unit, /^After=hermes-gateway-parilka\.service$/mu);
  assert.match(unit, /^WorkingDirectory=%h\/repos\/parilka-unified$/mu);
  assert.match(unit, /^EnvironmentFile=%h\/\.config\/parilka\/parilka-bot-codex\.env$/mu);
  assert.doesNotMatch(unit, /^EnvironmentFile=%h\/\.config\/parilka\/parilka-bot\.env$/mu);
  assert.doesNotMatch(unit, /^EnvironmentFile=.*parilka\.env$/mu);
  assert.doesNotMatch(unit, /^EnvironmentFile=.*telegram-mcp\/\.env$/mu);
  assert.doesNotMatch(unit, /^Environment=PARILKA_BOT_/mu);
  assert.match(botLauncher, /^export PARILKA_BOT_WORKERS=1$/mu);
  assertFinalExecEnvironment(unit, "NODE_ENV", "production");
  assertFinalExecEnvironment(unit, "TELEGRAM_PROJECT_DIR", "%h/repos/parilka-unified");
  assertFinalExecEnvironment(unit, "PARILKA_BOT_LOCK_FILE", "%h/.telegram-parilka-mcp/parilka-bot.lock");
  assert.doesNotMatch(unit, /^LoadCredential=/mu);
  assertFinalExecEnvironment(
    unit,
    "PARILKA_BOT_CODEX_AUTH_FILE",
    "%h/.telegram-parilka-mcp/codex-subscription/auth.json",
  );
  assert.match(
    unit,
    /^ExecStartPre=%h\/repos\/parilka-unified\/bin\/telegram-parilka-mcp-check-build %h\/repos\/parilka-unified %h\/repos\/parilka-unified\/\.deploy\/responses-current\/bot-daemon\.js$/mu,
  );
  assert.match(
    unit,
    /^ExecStartPre=\/usr\/bin\/env .* %h\/repos\/parilka-unified\/bin\/parilka-bot --preflight$/mu,
  );
  for (const [key, value] of [
    ["PARILKA_BOT_LOCK_FILE", "%h/.telegram-parilka-mcp/parilka-bot.lock"],
    ["PARILKA_BOT_ENTRYPOINT", "%h/repos/parilka-unified/.deploy/responses-current/bot-daemon.js"],
    ["PARILKA_BOT_CODEX_AUTH_FILE", "%h/.telegram-parilka-mcp/codex-subscription/auth.json"],
  ]) {
    assertPreflightEnvironment(unit, key, value);
  }
  assertFinalExecEnvironment(
    unit,
    "PARILKA_BOT_ENTRYPOINT",
    "%h/repos/parilka-unified/.deploy/responses-current/bot-daemon.js",
  );
  assertFinalExecCommand(unit, "%h/repos/parilka-unified/bin/parilka-bot");
});

test("launcher delegates lifetime owner-only flock to the no-follow helper", () => {
  assert.match(botLauncher, /lock_file="\$\{PARILKA_BOT_LOCK_FILE:\?PARILKA_BOT_LOCK_FILE must be configured\}"/u);
  assert.match(botLauncher, /\[\[ "\$lock_file" != \/\* \]\]/u);
  assert.match(botLauncher, /parilka-bot-lock\.mjs/u);
  assert.doesNotMatch(botLauncher, /\brm\b.*\$lock_file/u);
  assert.match(botLockHelper, /constants\.O_NOFOLLOW/u);
  assert.match(botLockHelper, /fstatSync\(descriptor\)/u);
  assert.match(botLockHelper, /\/proc\/self\/fd\/3/u);
  assert.match(botLockHelper, /--no-fork/u);
  assert.match(botLockHelper, /stdio: \["inherit", "inherit", "inherit", descriptor\]/u);
  assert.match(botLockHelper, /another Parilka Bot API owner already holds/u);
});

test("standalone Codex subscription preflight is safe before the old Bot API owner stops", () => {
  assert.match(preflightUnit, /^Type=oneshot$/mu);
  assert.match(
    preflightUnit,
    /^EnvironmentFile=%h\/\.config\/parilka\/parilka-bot-codex\.env$/mu,
  );
  assert.match(
    preflightUnit,
    /^ExecStart=\/usr\/bin\/env .* %h\/repos\/parilka-unified\/bin\/parilka-bot --preflight$/mu,
  );
  assert.match(
    preflightUnit,
    /^ExecStartPre=%h\/repos\/parilka-unified\/bin\/telegram-parilka-mcp-check-build %h\/repos\/parilka-unified %h\/repos\/parilka-unified\/\.deploy\/responses-current\/bot-daemon\.js$/mu,
  );
  assert.doesNotMatch(preflightUnit, /^LoadCredential=/mu);
  assertFinalExecEnvironment(
    preflightUnit,
    "PARILKA_BOT_ENTRYPOINT",
    "%h/repos/parilka-unified/.deploy/responses-current/bot-daemon.js",
  );
  assertFinalExecEnvironment(
    preflightUnit,
    "PARILKA_BOT_CODEX_AUTH_FILE",
    "%h/.telegram-parilka-mcp/codex-subscription/auth.json",
  );
  assert.doesNotMatch(preflightUnit, /PARILKA_BOT_LOCK_FILE=/u);
  assert.doesNotMatch(preflightUnit, /Conflicts=/u);
  assert.doesNotMatch(preflightUnit, /hermes|telegram-mcp\.service/iu);
  assert.doesNotMatch(preflightUnit, /sendMessage|sendRichMessage|Bot API URL/iu);
});

test("Codex subscription bot and digest units do not inherit MTProto credentials", () => {
  assert.doesNotMatch(unit, /^EnvironmentFile=.*telegram-mcp\/\.env$/mu);
  assert.doesNotMatch(maintainUnit, /^EnvironmentFile=.*telegram-mcp\/\.env$/mu);
  assert.match(
    maintainUnit,
    /^EnvironmentFile=%h\/\.config\/parilka\/parilka-maintain-codex\.env$/mu,
  );
  assert.doesNotMatch(maintainUnit, /^EnvironmentFile=%h\/\.config\/parilka\/parilka-maintain\.env$/mu);
  assert.doesNotMatch(maintainUnit, /^EnvironmentFile=.*parilka\.env$/mu);
});

test("maintenance timer invokes the isolated Codex subscription digest unit without Hermes coupling", () => {
  assert.match(maintainUnit, /^After=parilka-sync\.service$/mu);
  assert.doesNotMatch(maintainUnit, /^Wants=.*hermes/mu);
  assert.doesNotMatch(maintainUnit, /^LoadCredential=/mu);
  assertFinalExecEnvironment(
    maintainUnit,
    "PARILKA_DIGEST_CODEX_AUTH_FILE",
    "%h/.telegram-parilka-mcp/codex-subscription/auth.json",
  );
  assertFinalExecEnvironment(
    maintainUnit,
    "PARILKA_MAINTENANCE_ENTRYPOINT",
    "%h/repos/parilka-unified/.deploy/responses-current/maintenance-cli.js",
  );
  assertFinalExecEnvironment(
    maintainUnit,
    "PARILKA_DIGEST_ENTRYPOINT",
    "%h/repos/parilka-unified/.deploy/responses-current/digest-cli.js",
  );
  assertFinalExecCommand(
    maintainUnit,
    "%h/repos/parilka-unified/bin/parilka-digests --apply --summary-only",
  );
  assert.match(maintainTimer, /^Unit=parilka-maintain\.service$/mu);
});

test("service environment slices are minimal and cannot override unit-owned subscription state", () => {
  const botAssignments = environmentAssignments(botEnvironmentSlice);
  const maintainAssignments = environmentAssignments(maintainEnvironmentSlice);

  assert.equal(botAssignments.get("PARILKA_BOT_MODE"), "shadow");
  assert.equal(botAssignments.get("PARILKA_BOT_EXCLUSIVE_POLLER"), "");
  assert.equal(botAssignments.get("PARILKA_BOT_TOKEN_FILE"), "/absolute/path/to/parilka-bot-token");
  assert.equal(botAssignments.has("PARILKA_BOT_RESPONSES_REASONING_EFFORT"), false);
  assert.equal(botAssignments.get("PARILKA_BOT_RESPONSES_TURN_TIMEOUT_MS"), "180000");
  assert.equal(botAssignments.get("PARILKA_BOT_RAG_LOCAL_ENDPOINT"), "http://127.0.0.1:8767");
  assert.equal(botAssignments.get("PARILKA_BOT_RAG_LOCAL_REQUEST_TIMEOUT_MS"), "2000");
  assert.equal(botAssignments.get("PARILKA_BOT_RAG_RERANK_TIMEOUT_MS"), "2000");
  assert.equal(botAssignments.get("PARILKA_BOT_RAG_RERANK_MAX_CANDIDATES"), "8");
  assert.equal(botAssignments.get("PARILKA_BOT_RAG_AUTOMATIC_TIMEOUT_MS"), "2500");

  for (const key of [
    "PARILKA_BOT_LOCK_FILE",
    "PARILKA_BOT_CODEX_AUTH_FILE",
  ]) {
    assert.equal(botAssignments.has(key), false, `${key} must be unit-owned`);
  }
  for (const key of [
    "PARILKA_DIGEST_CODEX_AUTH_FILE",
    "PARILKA_DIGEST_RESPONSES_REASONING_EFFORT",
  ]) {
    assert.equal(maintainAssignments.has(key), false, `${key} must be unit-owned`);
  }
  for (const key of ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION"]) {
    assert.equal(botAssignments.has(key), false, `${key} must not enter bot`);
    assert.equal(maintainAssignments.has(key), false, `${key} must not enter maintenance`);
  }

  const sharedAssignments = environmentAssignments(sharedEnvironmentTemplate);
  assert.deepEqual(
    [...sharedAssignments.keys()].filter((key) => key.startsWith("PARILKA_BOT_")),
    ["PARILKA_BOT_ID"],
  );
  assert.equal(
    [...sharedAssignments.keys()].some((key) => key.startsWith("PARILKA_DIGEST_")),
    false,
  );
  assert.match(readme, /config\/parilka-bot\.env\.example/u);
  assert.match(readme, /config\/parilka-maintain\.env\.example/u);
  assert.equal(botAssignments.has("PARILKA_BOT_CODEX_AUTH_FILE"), false);
  assert.equal(maintainAssignments.has("PARILKA_DIGEST_CODEX_AUTH_FILE"), false);
});

test("parilka-bot unit stays private, hardened, and has no listener gateway", () => {
  assert.match(unit, /^Restart=on-failure$/mu);
  assert.match(unit, /^KillMode=mixed$/mu);
  assert.match(unit, /^TimeoutStartSec=2min$/mu);
  assert.match(unit, /^TimeoutStopSec=12min$/mu);
  for (const setting of [
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "ReadWritePaths=%h/.telegram-parilka-mcp",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  ]) {
    assert.match(unit, new RegExp(`^${escapeRegExp(setting)}$`, "mu"));
  }
  assert.doesNotMatch(unit, /^(?:ListenStream|ListenDatagram|ListenSequentialPacket)=/mu);
  assert.doesNotMatch(unit, /\bTCP\b/iu);
  assert.doesNotMatch(unit, /^(?:ExecStart|ExecStartPre)=.*hermes/imu);
  const hermesLines = unit.match(/^.*hermes.*$/gimu) ?? [];
  assert.deepEqual(hermesLines, [
    "Conflicts=hermes-gateway-parilka.service",
    "After=hermes-gateway-parilka.service",
  ]);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertFinalExecEnvironment(
  contents: string,
  key: string,
  value: string,
): void {
  const execStartLines = contents.match(/^ExecStart(?:Pre)?=.*$/gmu) ?? [];
  assert.ok(
    execStartLines.some((line) => line.includes(`/usr/bin/env ${key}=${value}`) || line.includes(` ${key}=${value}`)),
    `${key} must be set through the final /usr/bin/env exec seam`,
  );
}

function assertFinalExecCommand(contents: string, command: string): void {
  const execStartLines = contents.match(/^ExecStart=.*$/gmu) ?? [];
  assert.ok(
    execStartLines.some((line) => line === `ExecStart=/usr/bin/env ${command}` || line.endsWith(` ${command}`)),
    `${command} must run through the protected final /usr/bin/env exec seam`,
  );
}

function assertPreflightEnvironment(
  contents: string,
  key: string,
  value: string,
): void {
  const preflight = (contents.match(/^ExecStartPre=.*--preflight$/gmu) ?? []).at(0);
  assert.ok(preflight?.includes(` ${key}=${value}`), `${key} must reach --preflight`);
}

function environmentAssignments(contents: string): Map<string, string> {
  return new Map(
    contents
      .split(/\r?\n/u)
      .flatMap((line) => {
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
        return match ? [[match[1], match[2]] as const] : [];
      }),
  );
}
