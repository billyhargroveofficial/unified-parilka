import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AiSdkSummaryPort,
  DigestLockHeldError,
  acquireDigestProcessLock,
} from "../src/digests.js";
import { ModelRouter } from "../src/providers/model-router.js";
import { MessageStore } from "../src/store.js";
import {
  CHAT_ID,
  message,
  seedMessages,
} from "./digest-generation-fixtures.js";

test("AI SDK summary adapter uses ordered ModelRouter summary fallbacks", async () => {
  const router = new ModelRouter(
    {
      allowInsecureLocal: false,
      providers: [
        {
          id: "primary",
          protocol: "openai",
          baseUrl: "https://primary.invalid/v1",
          apiKeyEnv: "DIGEST_TEST_PRIMARY",
        },
        {
          id: "secondary",
          protocol: "openai",
          baseUrl: "https://secondary.invalid/v1",
          apiKeyEnv: "DIGEST_TEST_SECONDARY",
        },
      ],
      roles: {
        turn: ["primary:turn-model"],
        summary: [
          "primary:summary-model",
          "secondary:summary-model",
        ],
      },
    },
    {
      env: {
        DIGEST_TEST_PRIMARY: "unit-test-primary",
        DIGEST_TEST_SECONDARY: "unit-test-secondary",
      },
    },
  );
  const attempted: string[] = [];
  const port = new AiSdkSummaryPort(router, {
    generate: async ({ candidate }) => {
      attempted.push(candidate.reference);
      if (candidate.providerId === "primary") {
        throw Object.assign(new Error("transport"), {
          code: "ECONNRESET",
        });
      }
      return {
        text: "Итоговая сводка",
        finishReason: "stop",
        inputTokens: 10,
        outputTokens: 4,
      };
    },
  });

  const result = await port.summarize({
    kind: "day",
    period: "2026-07-29",
    dayFrom: "2026-07-29",
    dayTo: "2026-07-29",
    sourceText: "{}",
    sourceCount: 1,
    maxOutputChars: 1_000,
    signal: new AbortController().signal,
  });

  assert.deepEqual(attempted, [
    "primary:summary-model",
    "secondary:summary-model",
  ]);
  assert.equal(result.providerId, "secondary");
  assert.equal(result.model, "secondary:summary-model");
  assert.equal(result.fallbackCount, 1);
});

test("process lock has one OS-backed owner and can be reacquired after release", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-lock-"));
  const dbPath = join(directory, "messages.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(dbPath, "");

  const first = acquireDigestProcessLock(dbPath, {
    lockDirectory: directory,
  });
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.throws(
    () =>
      acquireDigestProcessLock(dbPath, {
        lockDirectory: directory,
      }),
    DigestLockHeldError,
  );

  first.release();
  const reacquired = acquireDigestProcessLock(dbPath, {
    lockDirectory: directory,
  });
  assert.equal(reacquired.mechanism, "sqlite_immediate");
  first.release();
  assert.equal(existsSync(reacquired.path), true);
  reacquired.release();
  // The tiny lock database persists, but ownership is only the live SQLite
  // transaction; no stale pathname needs unsafe recovery.
  assert.equal(existsSync(reacquired.path), true);
});

test("default process lock namespace is stable across XDG runtime contexts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-lock-db-"));
  const otherRuntime = mkdtempSync(
    join(tmpdir(), "parilka-digest-lock-xdg-"),
  );
  const dbPath = join(directory, "messages.sqlite");
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  t.after(() => {
    if (previousRuntime === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = previousRuntime;
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(otherRuntime, { recursive: true, force: true });
  });
  writeFileSync(dbPath, "");

  process.env.XDG_RUNTIME_DIR = otherRuntime;
  const first = acquireDigestProcessLock(dbPath);
  assert.equal(first.path.startsWith(`${directory}/`), true);

  process.env.XDG_RUNTIME_DIR = directory;
  assert.throws(
    () => acquireDigestProcessLock(dbPath),
    DigestLockHeldError,
  );
  first.release();
});

test("process lock rejects a database inode with hardlink aliases", (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "parilka-digest-lock-hardlink-"),
  );
  const dbPath = join(directory, "messages.sqlite");
  const aliasPath = join(directory, "messages-alias.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(dbPath, "");
  linkSync(dbPath, aliasPath);

  assert.throws(
    () => acquireDigestProcessLock(dbPath),
    /must not have hardlink aliases/u,
  );
});

test("process lock refuses shared and symbolic lock directories", (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "parilka-digest-lock-policy-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "messages.sqlite");
  writeFileSync(dbPath, "");

  const shared = join(directory, "shared");
  mkdirSync(shared, { mode: 0o700 });
  chmodSync(shared, 0o777);
  assert.throws(
    () =>
      acquireDigestProcessLock(dbPath, {
        lockDirectory: shared,
      }),
    /private, non-symbolic directory/u,
  );

  const privateDirectory = join(directory, "private");
  const symbolicDirectory = join(directory, "symbolic");
  mkdirSync(privateDirectory, { mode: 0o700 });
  symlinkSync(privateDirectory, symbolicDirectory, "dir");
  assert.throws(
    () =>
      acquireDigestProcessLock(dbPath, {
        lockDirectory: symbolicDirectory,
      }),
    /private, non-symbolic directory/u,
  );
});

test("MessageStore read-only mode validates and rejects writes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-readonly-"));
  const dbPath = join(directory, "messages.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writable = new MessageStore(dbPath);
  seedMessages(writable, [
    message(1, "2026-07-29T08:00:00.000Z", "Alice", "Текст"),
  ]);
  writable.close();

  const readOnly = new MessageStore(dbPath, { readOnly: true });
  t.after(() => readOnly.close());
  assert.equal(
    readOnly.getDigestSourceMessages({
      chatId: CHAT_ID,
      startInclusive: "2026-07-28T21:00:00.000Z",
      endExclusive: "2026-07-29T21:00:00.000Z",
    }).length,
    1,
  );
  assert.throws(
    () =>
      readOnly.upsertDayDigest({
        chatId: CHAT_ID,
        day: "2026-07-29",
        startMessageId: 1,
        endMessageId: 1,
        messageCount: 1,
        text: "Нельзя записать",
        promptVersion: "test",
      }),
    /readonly|read-only/iu,
  );
});

test("CLI defaults to a read-only dry-run and needs no model config", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-cli-"));
  const dbPath = join(directory, "messages.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writable = new MessageStore(dbPath);
  seedMessages(writable, [
    message(
      1,
      new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      "Alice",
      "CLI dry run",
    ),
  ]);
  writable.close();
  const env = { ...process.env };
  for (const name of [
    "PARILKA_BOT_DB_PATH",
    "PARILKA_DIGEST_DB_PATH",
    "TELEGRAM_DB_PATH",
    "TELEGRAM_ALLOWED_CHAT_IDS",
    "PARILKA_BOT_MODEL_CONFIG_PATH",
    "PARILKA_DIGEST_MODEL_CONFIG_PATH",
  ]) {
    delete env[name];
  }

  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/generate-digests.ts",
      "--db",
      dbPath,
      "--chat",
      CHAT_ID,
    ],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout) as {
    mode?: unknown;
    days?: { generated?: unknown };
  };
  assert.equal(report.mode, "dry_run");
  assert.equal(report.days?.generated, 0);
  const readOnly = new MessageStore(dbPath, { readOnly: true });
  assert.equal(readOnly.listDayDigests(CHAT_ID).length, 0);
  readOnly.close();
});

test("CLI rejects a hardlink alias without relying on shared DB env", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-hardlink-"));
  const primaryPath = join(directory, "messages.sqlite");
  const hardlinkPath = join(directory, "alias.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writable = new MessageStore(primaryPath);
  writable.close();
  linkSync(primaryPath, hardlinkPath);
  const env = { ...process.env };
  for (const name of [
    "PARILKA_BOT_DB_PATH",
    "PARILKA_DIGEST_DB_PATH",
    "TELEGRAM_DB_PATH",
    "TELEGRAM_ALLOWED_CHAT_IDS",
    "PARILKA_BOT_MODEL_CONFIG_PATH",
    "PARILKA_DIGEST_MODEL_CONFIG_PATH",
  ]) {
    delete env[name];
  }

  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/generate-digests.ts",
      "--db",
      hardlinkPath,
      "--chat",
      CHAT_ID,
    ],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 1, child.stdout);
  const result = JSON.parse(child.stderr) as {
    error?: { code?: unknown };
  };
  assert.equal(result.error?.code, "database_has_hardlinks");
});

test("CLI rejects a database divergent from configured shared state", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-divergent-"));
  const primaryPath = join(directory, "messages.sqlite");
  const divergentPath = join(directory, "other.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new MessageStore(primaryPath).close();
  new MessageStore(divergentPath).close();
  const env: Record<string, string | undefined> = {
    ...process.env,
    TELEGRAM_DB_PATH: primaryPath,
  };
  for (const name of [
    "PARILKA_BOT_DB_PATH",
    "PARILKA_DIGEST_DB_PATH",
    "TELEGRAM_ALLOWED_CHAT_IDS",
    "PARILKA_BOT_MODEL_CONFIG_PATH",
    "PARILKA_DIGEST_MODEL_CONFIG_PATH",
  ]) {
    delete env[name];
  }

  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/generate-digests.ts",
      "--db",
      divergentPath,
      "--chat",
      CHAT_ID,
    ],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 1, child.stdout);
  const result = JSON.parse(child.stderr) as {
    error?: { code?: unknown };
  };
  assert.equal(result.error?.code, "database_path_mismatch");
});
