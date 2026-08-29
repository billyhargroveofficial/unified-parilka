import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const checkBuild = resolve("bin", "telegram-parilka-mcp-check-build");

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
    ["bin/parilka-openclaw-project", "dist/openclaw-projection-cli.js"],
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

test("the normal stdio proxy scrubs inherited Telegram and provider secrets", () => {
  const source = readFileSync(
    resolve("bin/telegram-parilka-mcp"),
    "utf8",
  );

  assert.match(source, /if \(\( ! owner_mode \)\); then/u);
  for (const name of [
    "TELEGRAM_API_HASH",
    "TELEGRAM_SESSION",
    "PARILKA_BOT_TOKEN",
    "PARILKA_DEEPSEEK_API_KEY",
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
