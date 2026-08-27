import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

const checkBuild = resolve("bin", "telegram-parilka-mcp-check-build");

test("Responses release builder stages an immutable version before atomically switching current", () => {
  const source = readFileSync(resolve("scripts/build-responses-release.mjs"), "utf8");
  assert.match(source, /responses-releases/u);
  assert.match(source, /\.staging-\$\{releaseId\}/u);
  assert.match(source, /renameSync\(temporaryPointer, pointer\)/u);
  assert.match(source, /makeReadOnly\(releaseDir\)/u);
  assert.match(source, /RESPONSES_SOURCE_MANIFEST_NAME/u);
  assert.match(source, /verifyResponsesReleaseProvenance\(projectDir, releaseDir\)/u);
  assert.match(source, /rmSync\(legacyArtifact, \{ recursive: true, force: true \}\)/u);
});

test("build guard reports missing deployed entrypoint clearly", () => {
  const projectDir = makeTempProject();
  try {
    const entrypoint = join(projectDir, "dist", "index.js");
    const result = spawnSync(checkBuild, [projectDir, entrypoint], { encoding: "utf8" });

    assert.equal(result.status, 78);
    assert.match(result.stderr, /missing built entrypoint/);
    assert.match(result.stderr, /npm run build/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("build guard reports stale deployed entrypoint clearly", () => {
  const projectDir = makeTempProject();
  try {
    const entrypoint = join(projectDir, "dist", "index.js");
    mkdirSync(join(projectDir, "dist"), { recursive: true });
    writeFileSync(entrypoint, "console.log('old build');\n");

    const oldDate = new Date("2026-01-01T00:00:00Z");
    const newDate = new Date("2026-01-02T00:00:00Z");
    utimesSync(entrypoint, oldDate, oldDate);
    utimesSync(join(projectDir, "src", "index.ts"), newDate, newDate);

    const result = spawnSync(checkBuild, [projectDir, entrypoint], { encoding: "utf8" });

    assert.equal(result.status, 78);
    assert.match(result.stderr, /built entrypoint is stale/);
    assert.match(result.stderr, /Newer source\/config file:/);
    assert.match(result.stderr, /npm run build/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("build guard ignores documentation-only changes", () => {
  const projectDir = makeTempProject();
  try {
    const entrypoint = join(projectDir, "dist", "index.js");
    const readme = join(projectDir, "src", "README.md");
    mkdirSync(join(projectDir, "dist"), { recursive: true });
    writeFileSync(entrypoint, "console.log('current build');\n");
    writeFileSync(readme, "# newer documentation\n");

    const oldDate = new Date("2026-01-01T00:00:00Z");
    const buildDate = new Date("2026-01-02T00:00:00Z");
    const docsDate = new Date("2026-01-03T00:00:00Z");
    for (const source of [
      join(projectDir, "src", "index.ts"),
      join(projectDir, "package.json"),
      join(projectDir, "tsconfig.json"),
    ]) {
      utimesSync(source, oldDate, oldDate);
    }
    utimesSync(entrypoint, buildDate, buildDate);
    utimesSync(readme, docsDate, docsDate);

    const result = spawnSync(checkBuild, [projectDir, entrypoint], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("every production state wrapper rejects a stale build", () => {
  const wrappers = new Map([
    ["bin/parilka-digests", "dist/digest-cli.js"],
    ["bin/parilka-import-python-state", "dist/python-import-cli.js"],
    ["bin/parilka-maintain", "dist/maintenance-cli.js"],
  ]);

  for (const [wrapper, entrypoint] of wrappers) {
    const source = readFileSync(resolve(wrapper), "utf8");
    assert.match(
      source,
      /telegram-parilka-mcp-check-build/u,
      `${wrapper} must call the build guard`,
    );
    assert.ok(
      source.includes(entrypoint),
      `${wrapper} must guard ${entrypoint}`,
    );
  }
});

test("wrappers accept only their owned Responses release artifacts", () => {
  const project = mkdtempSync(join(tmpdir(), "parilka-responses-release-"));
  const releaseId = "20260827000000000-12345-abcdef123456";
  const releaseDir = join(project, ".deploy", "responses-releases", releaseId);
  const currentPointer = join(project, ".deploy", "responses-current");
  const guarded = join(project, "guarded-entrypoint");
  const outside = join(project, "outside.js");
  mkdirSync(join(project, "bin"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(join(project, "state"), { recursive: true, mode: 0o700 });
  symlinkSync(join("responses-releases", releaseId), currentPointer);
  writeFileSync(join(project, "src", "index.ts"), "export {};\n");
  writeFileSync(join(project, "package.json"), "{}\n");
  writeFileSync(join(project, "tsconfig.json"), "{}\n");
  writeFileSync(
    join(project, "bin", "telegram-parilka-mcp-check-build"),
    "#!/usr/bin/env bash\nprintf '%s' \"$2\" > guarded-entrypoint\n",
    { mode: 0o700 },
  );
  writeFileSync(outside, "process.exit(99);\n");
  const wrappers = [
    ["bin/parilka-bot", "PARILKA_BOT_ENTRYPOINT", "bot-daemon.js"],
    ["bin/parilka-digests", "PARILKA_DIGEST_ENTRYPOINT", "digest-cli.js"],
    ["bin/parilka-maintain", "PARILKA_MAINTENANCE_ENTRYPOINT", "maintenance-cli.js"],
  ] as const;
  try {
    for (const [wrapper, environmentKey, filename] of wrappers) {
      const releaseEntrypoint = join(releaseDir, filename);
      const entrypoint = join(currentPointer, filename);
      writeFileSync(releaseEntrypoint, "process.exit(0);\n");
      const environment = {
        ...process.env,
        TELEGRAM_PROJECT_DIR: project,
        TELEGRAM_NODE: process.execPath,
        [environmentKey]: entrypoint,
      };
      if (environmentKey === "PARILKA_BOT_ENTRYPOINT") {
        environment.PARILKA_BOT_LOCK_FILE = join(project, "state", "bot.lock");
      }
      const allowed = spawnSync(resolve(wrapper), [], { env: environment, encoding: "utf8" });
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.equal(readFileSync(guarded, "utf8"), releaseEntrypoint);

      const rejected = spawnSync(resolve(wrapper), [], {
        env: { ...environment, [environmentKey]: outside },
        encoding: "utf8",
      });
      assert.equal(rejected.status, 78);
      assert.match(rejected.stderr, /exact active Responses release entrypoint/u);
    }

    symlinkSync("bot-daemon.js", join(releaseDir, "poisoned-link"));
    const rejectedPoisonedTree = spawnSync(resolve("bin/parilka-bot"), [], {
      env: {
        ...process.env,
        TELEGRAM_PROJECT_DIR: project,
        TELEGRAM_NODE: process.execPath,
        PARILKA_BOT_ENTRYPOINT: join(currentPointer, "bot-daemon.js"),
        PARILKA_BOT_LOCK_FILE: join(project, "state", "poisoned.lock"),
      },
      encoding: "utf8",
    });
    assert.equal(rejectedPoisonedTree.status, 78);
    assert.match(rejectedPoisonedTree.stderr, /release tree must not contain symbolic links/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("bot release preflight bypasses the owner lock while ordinary execution remains fenced", async (t) => {
  const project = mkdtempSync(join(tmpdir(), "parilka-bot-preflight-lock-"));
  const lockFile = join(project, "state", "parilka-bot.lock");
  const launcher = resolve("bin/parilka-bot");
  const releaseId = "20260827000000000-12345-abcdef123456";
  const releaseDir = join(project, ".deploy", "responses-releases", releaseId);
  const currentPointer = join(project, ".deploy", "responses-current");
  mkdirSync(join(project, "bin"), { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(join(project, "state"), { recursive: true, mode: 0o700 });
  symlinkSync(join("responses-releases", releaseId), currentPointer);
  writeFileSync(
    join(project, "bin", "telegram-parilka-mcp-check-build"),
    "#!/usr/bin/env bash\nexit 0\n",
    { mode: 0o700 },
  );
  const releaseEntrypoint = join(releaseDir, "bot-daemon.js");
  const entrypoint = join(currentPointer, "bot-daemon.js");
  writeFileSync(
    releaseEntrypoint,
    "if (process.argv.includes('--preflight')) { console.log('preflight-only'); process.exit(0); } if (process.env.PARILKA_TEST_HOLD === 'true') { console.log('owner'); setInterval(() => {}, 1_000); } else { process.exit(0); }\n",
  );
  const environment = {
    ...process.env,
    TELEGRAM_PROJECT_DIR: project,
    PARILKA_BOT_ENTRYPOINT: entrypoint,
    PARILKA_BOT_LOCK_FILE: lockFile,
    TELEGRAM_NODE: process.execPath,
  };
  const owner = spawn(launcher, [], {
    env: { ...environment, PARILKA_TEST_HOLD: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (owner.exitCode === null) owner.kill("SIGTERM");
    rmSync(project, { recursive: true, force: true });
  });
  assert.ok(owner.stdout);
  await once(owner.stdout, "data", { signal: AbortSignal.timeout(5_000) });

  const preflight = spawnSync(launcher, ["--preflight"], {
    env: { ...environment, PARILKA_BOT_LOCK_FILE: "" },
    encoding: "utf8",
  });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.match(preflight.stdout, /preflight-only/u);
  assert.doesNotMatch(preflight.stderr, /another Parilka Bot API owner/u);

  const secondOwner = spawnSync(launcher, [], {
    env: environment,
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(secondOwner.status, 1);
  assert.match(secondOwner.stderr, /another Parilka Bot API owner/u);
});

test("the bot wrapper leaves token-file loading to the typed Node preflight", () => {
  const source = readFileSync(resolve("bin/parilka-bot"), "utf8");
  assert.doesNotMatch(source, /parilka_load_secret_file/u);
  assert.doesNotMatch(source, /PARILKA_BOT_TOKEN\b/u);
});

test("all package Bot API entrypoints route through the exclusive launcher", () => {
  const scripts = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
    scripts?: Record<string, unknown>;
  };
  for (const name of ["bot", "bot:start"]) {
    assert.equal(scripts.scripts?.[name], "./bin/parilka-bot");
  }
});

test("the Bot API lock descriptor survives launcher exec and fences a second owner", async (t) => {
  const project = mkdtempSync(join(tmpdir(), "parilka-bot-lock-"));
  const lockFile = join(project, "state", "parilka-bot.lock");
  const launcher = resolve("bin/parilka-bot");
  mkdirSync(join(project, "bin"), { recursive: true });
  mkdirSync(join(project, "dist"), { recursive: true });
  mkdirSync(join(project, "state"), { recursive: true, mode: 0o700 });
  const guard = join(project, "bin", "telegram-parilka-mcp-check-build");
  writeFileSync(guard, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  chmodSync(guard, 0o700);
  writeFileSync(
    join(project, "dist", "bot-daemon.js"),
    "if (process.env.PARILKA_TEST_HOLD === 'true') { console.log('ready'); setInterval(() => {}, 1_000); }\n",
  );
  const environment = {
    ...process.env,
    TELEGRAM_PROJECT_DIR: project,
    PARILKA_BOT_LOCK_FILE: lockFile,
    TELEGRAM_NODE: process.execPath,
    PARILKA_TEST_HOLD: "false",
  };
  const first = spawn(launcher, [], {
    env: { ...environment, PARILKA_TEST_HOLD: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (first.exitCode === null) first.kill("SIGTERM");
    rmSync(project, { recursive: true, force: true });
  });
  assert.ok(first.stdout);
  const [ready] = await once(first.stdout, "data", {
    signal: AbortSignal.timeout(5_000),
  });
  assert.match(String(ready), /ready/u);
  assert.equal(first.exitCode, null, "first owner must remain alive after exec");
  assert.equal(existsSync(lockFile), true, "configured lock inode must exist");
  assert.equal(existsSync(join(project, "3")), false, "flock must not reinterpret fd 3 as a cwd-relative path");
  const second = spawnSync(launcher, [], {
    env: environment,
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /another Parilka Bot API owner/u);

  const firstExit = once(first, "exit");
  first.kill("SIGTERM");
  await firstExit;
  const afterExit = spawnSync(launcher, [], { env: environment, encoding: "utf8" });
  assert.equal(afterExit.status, 0, afterExit.stderr);
});

test("the Bot API launcher refuses a symlinked lock instead of following it", (t) => {
  const project = mkdtempSync(join(tmpdir(), "parilka-bot-lock-symlink-"));
  const state = join(project, "state");
  const target = join(project, "target.lock");
  const lock = join(state, "parilka-bot.lock");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(join(project, "bin"), { recursive: true });
  mkdirSync(join(project, "dist"), { recursive: true });
  const guard = join(project, "bin", "telegram-parilka-mcp-check-build");
  writeFileSync(guard, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  chmodSync(guard, 0o700);
  writeFileSync(join(project, "dist", "bot-daemon.js"), "process.exit(0);\n");
  writeFileSync(target, "do-not-follow", { mode: 0o600 });
  symlinkSync(target, lock);
  t.after(() => rmSync(project, { recursive: true, force: true }));

  const launched = spawnSync(resolve("bin/parilka-bot"), [], {
    env: {
      ...process.env,
      TELEGRAM_PROJECT_DIR: project,
      PARILKA_BOT_LOCK_FILE: lock,
      TELEGRAM_NODE: process.execPath,
    },
    encoding: "utf8",
  });
  assert.equal(launched.status, 1);
  assert.match(launched.stderr, /PARILKA_BOT_LOCK_FILE must not contain symbolic links/u);
  assert.equal(readFileSync(target, "utf8"), "do-not-follow");
});

test("the normal stdio proxy scrubs inherited Telegram and embedding secrets", () => {
  const source = readFileSync(
    resolve("bin/telegram-parilka-mcp"),
    "utf8",
  );

  assert.match(source, /if \(\( ! owner_mode \)\); then/u);
  for (const name of [
    "TELEGRAM_API_HASH",
    "TELEGRAM_SESSION",
    "PARILKA_BOT_TOKEN",
  ]) {
    assert.match(source, new RegExp(`\\b${name}\\b`, "u"));
  }
});

test("maintenance unit uses the canonical state lock and compact digest report", () => {
  const source = readFileSync(
    resolve("systemd/parilka-maintain.service"),
    "utf8",
  );

  assert.doesNotMatch(source, /^RuntimeDirectory=/mu);
  assert.doesNotMatch(source, /^Environment=XDG_RUNTIME_DIR=/mu);
  assert.match(
    source,
    /^ReadWritePaths=%h\/\.telegram-parilka-mcp$/mu,
  );
  assert.match(
    source,
    /^EnvironmentFile=%h\/\.config\/parilka\/parilka-maintain-codex\.env$/mu,
  );
  assert.doesNotMatch(source, /^LoadCredential=/mu);
  assert.match(
    source,
    /^ExecStart=\/usr\/bin\/env .*PARILKA_DIGEST_CODEX_AUTH_FILE=%h\/\.telegram-parilka-mcp\/codex-subscription\/auth\.json /mu,
  );
  assert.match(
    source,
    /^ExecStart=.*parilka-digests --apply --summary-only$/mu,
  );
});

function makeTempProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "telegram-parilka-mcp-entrypoint-"));
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", "index.ts"), "export {};\n");
  writeFileSync(join(projectDir, "package.json"), "{}\n");
  writeFileSync(join(projectDir, "tsconfig.json"), "{}\n");
  return projectDir;
}
