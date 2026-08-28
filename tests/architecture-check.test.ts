import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkArchitecture,
  countSourceLines,
  localMarkdownLinkTargets,
} from "../scripts/check-architecture.js";

const thinBarrels = [
  "src/bot-daemon.ts",
  "src/index.ts",
  "src/sync-daemon.ts",
  "src/bot/read-tools.ts",
  "src/bot/runtime.ts",
  "src/bot/runtime-config.ts",
  "src/bot/turn-coordinator.ts",
  "src/bot/worker.ts",
  "src/config.ts",
  "src/digests.ts",
  "src/providers/model-router.ts",
  "src/store.ts",
  "src/sync-engine.ts",
  "src/telegram/mtcute-client.ts",
  "src/tools.ts",
  "src/vector-rag.ts",
];

function writeFixtureFile(
  root: string,
  relative: string,
  text = "# fixture\n",
): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "parilka-architecture-"));
  try {
    for (const directory of ["loop-develop/current-todo", "tests"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    for (const file of [
      ".agents/rules/README.md",
      ".agents/rules/documentation.md",
      "AGENTS.md",
      "codex-skill/telegram-parilka-mcp/SKILL.md",
      "docs/README.md",
      "docs/architecture.md",
      "docs/adr/README.md",
      "llms.txt",
      "loop-develop/README.md",
      "operations/README.md",
      "operations/MIGRATION.md",
      ...thinBarrels,
    ]) {
      writeFixtureFile(root, file);
    }
    symlinkSync("AGENTS.md", path.join(root, "CLAUDE.md"));
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("source line counting ignores one terminal newline", () => {
  assert.equal(countSourceLines(""), 0);
  assert.equal(countSourceLines("one"), 1);
  assert.equal(countSourceLines("one\n"), 1);
  assert.equal(countSourceLines("one\ntwo\n"), 2);
});

test("documentation link parser keeps only local file targets", () => {
  assert.deepEqual(
    localMarkdownLinkTargets(
      "[local](../README.md#usage) [web](https://example.com) [anchor](#top)",
    ),
    ["../README.md"],
  );
});

test("architecture check accepts bounded source and one active goal", () => {
  withFixture((root) => {
    writeFileSync(path.join(root, "src", "bounded.ts"), "export {};\n");
    writeFileSync(
      path.join(root, "loop-develop", "current-todo", "001-todo.md"),
      "# active\n",
    );

    assert.deepEqual(checkArchitecture(root), {
      findings: [],
      productionFiles: thinBarrels.length + 1,
      testFiles: 0,
    });
  });
});

test("architecture check rejects monsters and multiple active goals", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "src", "monster.ts"),
      `${"const value = 1;\n".repeat(701)}`,
    );
    writeFileSync(
      path.join(root, "loop-develop", "current-todo", "001-todo.md"),
      "# first\n",
    );
    writeFileSync(
      path.join(root, "loop-develop", "current-todo", "002-todo.md"),
      "# second\n",
    );

    const result = checkArchitecture(root);
    assert.deepEqual(
      result.findings.map((finding) => finding.code).sort(),
      ["active-goal-count", "production-file-too-large"],
    );
  });
});

test("architecture check rejects a mixed test monster", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "tests", "monster.test.ts"),
      `${"test('case', () => {});\n".repeat(501)}`,
    );

    const result = checkArchitecture(root);
    assert.equal(result.findings[0]?.code, "test-file-too-large");
  });
});

test("architecture check rejects a broken canonical documentation-rule link", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, ".agents", "rules", "documentation.md"),
      "[missing](does-not-exist.md)\n",
    );

    assert.equal(checkArchitecture(root).findings[0]?.code, "broken-doc-link");
  });
});

test("architecture check rejects retired operator instructions", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "codex-skill", "telegram-parilka-mcp", "SKILL.md"),
      "Run /root/telegram-parilka-mcp and telegram-parilka-mcp-sync.service\n",
    );

    assert.deepEqual(
      checkArchitecture(root).findings.map((finding) => finding.code),
      ["deprecated-operator-reference", "deprecated-operator-reference"],
    );
  });
});

test("architecture check scans canonical docs but ignores scratch roots", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      ".agents/audit/scratch.md",
      "[missing](does-not-exist.md) /root/telegram-parilka-mcp\n",
    );
    writeFixtureFile(
      root,
      ".opencode/command/scratch.md",
      "[missing](does-not-exist.md) telegram-parilka-mcp-sync.service\n",
    );

    assert.deepEqual(checkArchitecture(root).findings, []);
  });
});

test("architecture check rejects a stale declared thin barrel", () => {
  withFixture((root) => {
    rmSync(path.join(root, "src", "tools.ts"));

    assert.deepEqual(checkArchitecture(root).findings.map((finding) => finding.code), [
      "missing-thin-barrel",
    ]);
  });
});

test("architecture check requires the exact CLAUDE.md instruction alias", () => {
  withFixture((root) => {
    assert.equal(
      checkArchitecture(root).findings.some(
        (finding) => finding.code === "invalid-claude-alias",
      ),
      false,
    );

    rmSync(path.join(root, "CLAUDE.md"));
    writeFixtureFile(root, "CLAUDE.md", "# duplicated instructions\n");

    assert.deepEqual(checkArchitecture(root).findings.map((finding) => finding.code), [
      "invalid-claude-alias",
    ]);

    rmSync(path.join(root, "CLAUDE.md"));
    symlinkSync("./AGENTS.md", path.join(root, "CLAUDE.md"));

    assert.deepEqual(checkArchitecture(root).findings.map((finding) => finding.code), [
      "invalid-claude-alias",
    ]);
  });
});

test("architecture check permits storage local, core, and shared dependencies", () => {
  withFixture((root) => {
    writeFixtureFile(root, "src/storage/core.ts", "export class StoreCore {}\n");
    writeFixtureFile(root, "src/observability/logger.ts", "export const logger = {};\n");
    writeFixtureFile(root, "src/telegram/types.ts", "export type ChatInfo = {};\n");
    writeFixtureFile(
      root,
      "src/storage/allowed.ts",
      [
        'import { StoreCore } from "./core.js";',
        'import { logger } from "../observability/logger.js";',
        'export type { ChatInfo } from "../telegram/types.js";',
        "void StoreCore;",
        "void logger;",
      ].join("\n"),
    );

    assert.deepEqual(checkArchitecture(root).findings, []);
  });
});

test("architecture check rejects static storage dependencies on upper layers", () => {
  withFixture((root) => {
    for (const file of [
      "src/bot/read-tools.ts",
      "src/bot-daemon.ts",
      "src/index.ts",
      "src/mcp-loopback.ts",
      "src/mcp-protocol.ts",
      "src/mcp-proxy/proxy.ts",
      "src/mcp-tools/registry.ts",
      "src/sync-daemon.ts",
      "src/tools.ts",
    ]) {
      writeFixtureFile(root, file, "export const value = true;\n");
    }
    writeFixtureFile(
      root,
      "src/storage/forbidden.ts",
      [
        'import "../bot/read-tools.js";',
        'import "../bot-daemon.js";',
        'export * from "../index.js";',
        'import "../mcp-loopback.js";',
        'export * from "../mcp-protocol.js";',
        'import "../mcp-proxy/proxy.js";',
        'export { value as registry } from "../mcp-tools/registry.js";',
        'export * from "../sync-daemon.js";',
        'import "../tools.js";',
      ].join("\n"),
    );

    const findings = checkArchitecture(root).findings.filter(
      (finding) => finding.code === "forbidden-storage-dependency",
    );
    assert.equal(findings.length, 9);
    assert.deepEqual(
      findings.map((finding) => finding.file),
      Array(9).fill("src/storage/forbidden.ts"),
    );
  });
});
