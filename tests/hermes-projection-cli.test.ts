import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../src/store.js";
import {
  parseHermesProjectionOptions,
  CliConfigError,
  runHermesProjectionCliMain,
} from "../src/hermes-projection/cli.js";
import { MANAGED_SEMANTIC_PREFIX } from "../src/hermes-projection/render-memory.js";
import {
  CHAT_ID,
  tmpDb,
  seedMemory,
  seedSkill,
} from "./support/hermes-projection-helpers.js";

type CliOutput = Pick<NodeJS.Process, "stdout" | "stderr">;

function fakeOutput(): {
  output: CliOutput;
  stdoutText(): string;
  stderrText(): string;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = {
    write(chunk: string) {
      stdoutChunks.push(chunk);
    },
  } as unknown as NodeJS.WriteStream;
  const stderr = {
    write(chunk: string) {
      stderrChunks.push(chunk);
    },
  } as unknown as NodeJS.WriteStream;
  return {
    output: { stdout, stderr } as CliOutput,
    stdoutText: () => stdoutChunks.join(""),
    stderrText: () => stderrChunks.join(""),
  };
}

function tmpProfile(configYaml: string): { home: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-cli-"));
  mkdirSync(join(dir, "memories"), { recursive: true });
  writeFileSync(join(dir, "config.yaml"), configYaml, "utf-8");
  return {
    home: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function emptyFile(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-clidb-"));
  const path = join(dir, "db.sqlite");
  writeFileSync(path, "", "utf-8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("parseOptions resolves db and chat from env with --hermes-home", () => {
  const db = emptyFile();
  const profile = tmpProfile("memory:\n  memory_char_limit: 8000\n");
  try {
    const opts = parseHermesProjectionOptions(["--hermes-home", profile.home], {
      PARILKA_DIGEST_DB_PATH: db.path,
      PARILKA_DIGEST_CHAT_ID: CHAT_ID,
    });
    assert.ok(opts.dbPath);
    assert.equal(opts.chatId, CHAT_ID);
    assert.equal(opts.hermesHome, profile.home);
    assert.equal(opts.disabled, false);
  } finally {
    db.cleanup();
    profile.cleanup();
  }
});

test("parseOptions throws on missing db", () => {
  assert.throws(() => parseHermesProjectionOptions([], {}), CliConfigError);
});

test("parseOptions throws on invalid chat id", () => {
  const db = emptyFile();
  try {
    assert.throws(
      () =>
        parseHermesProjectionOptions([], {
          PARILKA_DIGEST_DB_PATH: db.path,
          PARILKA_DIGEST_CHAT_ID: "not-a-chat-id",
        }),
      CliConfigError,
    );
  } finally {
    db.cleanup();
  }
});

test("parseOptions --apply disabled returns disabled option, no throw", () => {
  const db = emptyFile();
  try {
    const opts = parseHermesProjectionOptions(
      ["--apply", "--hermes-home", "/does/not/exist"],
      {
        PARILKA_DIGEST_DB_PATH: db.path,
        PARILKA_DIGEST_CHAT_ID: CHAT_ID,
      },
    );
    assert.equal(opts.apply, true);
    assert.equal(opts.disabled, true);
    assert.equal(opts.hermesHome, "");
  } finally {
    db.cleanup();
  }
});

test("parseOptions disabled skips db/chat/profile resolution entirely", () => {
  // Nonexistent paths and no chat anywhere: nothing is resolved or stat'd.
  const opts = parseHermesProjectionOptions(
    ["--apply", "--db", "/nonexistent/db.sqlite", "--hermes-home", "/nonexistent/profile"],
    {},
  );
  assert.equal(opts.apply, true);
  assert.equal(opts.disabled, true);
  assert.equal(opts.dbPath, "");
  assert.equal(opts.chatId, "");
  assert.equal(opts.hermesHome, "");
});

test("parseOptions disabled still validates argv syntax and lock timeout", () => {
  assert.throws(
    () => parseHermesProjectionOptions(["--apply", "--bogus"], {}),
    CliConfigError,
  );
  assert.throws(
    () =>
      parseHermesProjectionOptions(
        ["--apply", "--lock-timeout-ms", "abc"],
        {},
      ),
    CliConfigError,
  );
  assert.throws(
    () =>
      parseHermesProjectionOptions(
        ["--apply", "--lock-timeout-ms", "50"],
        {},
      ),
    CliConfigError,
  );
});

test("parseOptions --apply enabled requires hermes home", () => {
  const db = emptyFile();
  try {
    assert.throws(
      () =>
        parseHermesProjectionOptions(["--apply"], {
          PARILKA_DIGEST_DB_PATH: db.path,
          PARILKA_DIGEST_CHAT_ID: CHAT_ID,
          PARILKA_HERMES_PROJECTION_ENABLED: "true",
        }),
      CliConfigError,
    );
  } finally {
    db.cleanup();
  }
});

test("parseOptions dry-run also requires hermes home", () => {
  const db = emptyFile();
  try {
    assert.throws(
      () =>
        parseHermesProjectionOptions([], {
          PARILKA_DIGEST_DB_PATH: db.path,
          PARILKA_DIGEST_CHAT_ID: CHAT_ID,
        }),
      CliConfigError,
    );
  } finally {
    db.cleanup();
  }
});

test("parseOptions --apply enabled resolves profile home", () => {
  const db = emptyFile();
  const profile = tmpProfile("memory:\n  memory_char_limit: 8000\n");
  try {
    const opts = parseHermesProjectionOptions(
      ["--apply", "--hermes-home", profile.home],
      {
        PARILKA_DIGEST_DB_PATH: db.path,
        PARILKA_DIGEST_CHAT_ID: CHAT_ID,
        PARILKA_HERMES_PROJECTION_ENABLED: "yes",
      },
    );
    assert.equal(opts.apply, true);
    assert.equal(opts.disabled, false);
    assert.equal(opts.hermesHome, profile.home);
  } finally {
    db.cleanup();
    profile.cleanup();
  }
});

test("parseOptions lock timeout arg and default", () => {
  const db = emptyFile();
  const profile = tmpProfile("memory:\n  memory_char_limit: 8000\n");
  try {
    const opts = parseHermesProjectionOptions(
      ["--hermes-home", profile.home, "--lock-timeout-ms", "45000"],
      {
        PARILKA_DIGEST_DB_PATH: db.path,
        PARILKA_DIGEST_CHAT_ID: CHAT_ID,
      },
    );
    assert.equal(opts.lockTimeoutMs, 45000);
    const def = parseHermesProjectionOptions(
      ["--hermes-home", profile.home],
      {
        PARILKA_DIGEST_DB_PATH: db.path,
        PARILKA_DIGEST_CHAT_ID: CHAT_ID,
      },
    );
    assert.equal(def.lockTimeoutMs, 30000);
  } finally {
    db.cleanup();
    profile.cleanup();
  }
});

test("main: disabled apply emits skipped_disabled success JSON", async () => {
  const db = emptyFile();
  const out = fakeOutput();
  try {
    const code = await runHermesProjectionCliMain(
      [
        "--apply",
        "--db",
        db.path,
        "--chat",
        CHAT_ID,
        "--hermes-home",
        "/does/not/exist",
      ],
      {}, // PARILKA_HERMES_PROJECTION_ENABLED missing
      out.output,
    );
    assert.equal(code, 0);
    const report = JSON.parse(out.stdoutText());
    assert.equal(report.ok, true);
    assert.equal(report.mode, "skipped_disabled");
    assert.equal(report.memory.status, "skipped");
    assert.equal(report.skills.status, "skipped");
    assert.equal(out.stderrText(), "");
  } finally {
    db.cleanup();
  }
});

test("main: disabled with explicit false value also skips cleanly", async () => {
  const db = emptyFile();
  const out = fakeOutput();
  try {
    const code = await runHermesProjectionCliMain(
      ["--apply", "--db", db.path, "--chat", CHAT_ID],
      { PARILKA_HERMES_PROJECTION_ENABLED: "false" },
      out.output,
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.stdoutText()).mode, "skipped_disabled");
  } finally {
    db.cleanup();
  }
});

test("main: disabled apply with no db/chat/profile touches nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-disabled-"));
  const out = fakeOutput();
  try {
    const code = await runHermesProjectionCliMain(
      [
        "--apply",
        "--db",
        join(dir, "missing.sqlite"),
        "--hermes-home",
        join(dir, "profile"),
      ],
      {}, // no chat anywhere and projection disabled
      out.output,
    );
    assert.equal(code, 0);
    const report = JSON.parse(out.stdoutText());
    assert.equal(report.ok, true);
    assert.equal(report.mode, "skipped_disabled");
    assert.equal(report.dbPath, "");
    assert.equal(report.chatId, "");
    assert.equal(report.profileHome, "");
    // No file or directory was created by the disabled run.
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: dry-run reports plan without touching profile or skills", async () => {
  const { store, dbPath, cleanup: dbCleanup } = tmpDb();
  seedMemory(store, CHAT_ID, "semantic memory", 1, 42);
  seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
  store.close();

  const profile = tmpProfile("memory:\n  memory_char_limit: 8000\n");
  const ownerContent = "owner note";
  writeFileSync(
    join(profile.home, "memories", "MEMORY.md"),
    ownerContent,
    "utf-8",
  );
  const out = fakeOutput();
  try {
    const code = await runHermesProjectionCliMain(
      ["--db", dbPath, "--chat", CHAT_ID, "--hermes-home", profile.home],
      {},
      out.output,
    );
    assert.equal(code, 0);
    const report = JSON.parse(out.stdoutText());
    assert.equal(report.mode, "dry_run");
    assert.equal(report.memory.status, "ok");
    assert.equal(report.skills.status, "ok");
    assert.equal(report.skills.created, 1);
    assert.equal(report.lock.acquired, true);
    assert.equal(
      readFileSync(join(profile.home, "memories", "MEMORY.md"), "utf-8"),
      ownerContent,
    );
    assert.ok(!existsSync(join(profile.home, "skills", "parilka-managed")));
  } finally {
    dbCleanup();
    profile.cleanup();
  }
});

test("main: apply writes memory and skills end to end", async () => {
  const { store, dbPath, cleanup: dbCleanup } = tmpDb();
  seedMemory(store, CHAT_ID, "semantic memory", 1, 42);
  seedSkill(store, CHAT_ID, "Skill", "Desc", "Instructions.", 1000);
  store.close();

  const profile = tmpProfile("memory:\n  memory_char_limit: 8000\n");
  writeFileSync(
    join(profile.home, "memories", "MEMORY.md"),
    "owner note",
    "utf-8",
  );
  const out = fakeOutput();
  try {
    const code = await runHermesProjectionCliMain(
      ["--apply", "--db", dbPath, "--chat", CHAT_ID, "--hermes-home", profile.home],
      { PARILKA_HERMES_PROJECTION_ENABLED: "true" },
      out.output,
    );
    assert.equal(code, 0);
    const report = JSON.parse(out.stdoutText());
    assert.equal(report.mode, "applied");
    assert.equal(report.memory.status, "ok");
    assert.equal(report.skills.status, "ok");
    assert.equal(report.lock.acquired, true);

    const memoryMd = readFileSync(
      join(profile.home, "memories", "MEMORY.md"),
      "utf-8",
    );
    assert.ok(memoryMd.startsWith("owner note"));
    assert.ok(memoryMd.includes(MANAGED_SEMANTIC_PREFIX));
    const root = join(profile.home, "skills", "parilka-managed");
    assert.equal(
      readdirSync(root).filter((name) => name.startsWith("parilka-skill-"))
        .length,
      1,
    );
  } finally {
    dbCleanup();
    profile.cleanup();
  }
});

test("main: unexpected errors emit stable projection_failed without paths", async () => {
  // Profile without config.yaml makes the run fail inside projection.
  const { store, dbPath, cleanup: dbCleanup } = tmpDb();
  seedMemory(store, CHAT_ID, "semantic", 1);
  store.close();

  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-badprofile-"));
  mkdirSync(join(dir, "memories"), { recursive: true });
  writeFileSync(join(dir, "memories", "MEMORY.md"), "owner", "utf-8");
  const out = fakeOutput();
  try {
    const code = await runHermesProjectionCliMain(
      ["--db", dbPath, "--chat", CHAT_ID, "--hermes-home", dir],
      {},
      out.output,
    );
    assert.equal(code, 1);
    const error = JSON.parse(out.stderrText());
    assert.equal(error.ok, false);
    assert.equal(error.error.code, "projection_failed");
    assert.equal(error.error.message, "Projection failed.");
    assert.ok(!out.stderrText().includes(dbPath));
    assert.ok(!out.stderrText().includes("config.yaml"));
  } finally {
    dbCleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
