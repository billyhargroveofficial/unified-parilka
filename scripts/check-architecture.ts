import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const PRODUCTION_LINE_CEILING = 700;
const TEST_LINE_CEILING = 500;
const BARREL_LINE_CEILING = 150;

const thinBarrels = [
  "src/index.ts",
  "src/sync-daemon.ts",
  "src/bot/read-tools.ts",
  "src/config.ts",
  "src/digests.ts",
  "src/store.ts",
  "src/sync-engine.ts",
  "src/telegram/mtcute-client.ts",
  "src/tools.ts",
  "src/vector-rag.ts",
];

const requiredPaths = [
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
];

const forbiddenRootTodos = [
  "ARCHITECTURE_TODO.md",
  "NEXT_ARCHITECTURE_TODO.md",
  "NEXT_CODEX_GOAL.md",
];

const documentationRoots = [
  ".agents/rules",
  "codex-skill",
  "docs",
  "loop-develop",
  "operations",
  "src",
];

const processShellEntrypoints = new Set([
  "src/index.ts",
  "src/sync-daemon.ts",
]);

const moduleResolutionOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

const deprecatedOperatorReferences = [
  "/root/telegram-parilka-mcp",
  "telegram-parilka-mcp-sync.service",
];

export type ArchitectureFinding = {
  code:
    | "active-goal-count"
    | "barrel-too-large"
    | "broken-doc-link"
    | "deprecated-operator-reference"
    | "forbidden-storage-dependency"
    | "forbidden-root-todo"
    | "invalid-claude-alias"
    | "missing-required-path"
    | "missing-thin-barrel"
    | "retired-bot-runtime"
    | "unsafe-bot-entrypoint"
    | "production-file-too-large"
    | "test-file-too-large";
  file: string;
  message: string;
};

export type ArchitectureCheck = {
  findings: ArchitectureFinding[];
  productionFiles: number;
  testFiles: number;
};

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(candidate);
    }
    return entry.isFile() ? [candidate] : [];
  });
}

export function countSourceLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function checkArchitecture(repositoryRoot = process.cwd()): ArchitectureCheck {
  const findings: ArchitectureFinding[] = [];
  const productionFiles = ["src", "scripts"].flatMap((relative) =>
    listFiles(path.join(repositoryRoot, relative)).filter((file) =>
      file.endsWith(".ts"),
    ),
  );

  for (const file of productionFiles) {
    const lines = countSourceLines(readFileSync(file, "utf8"));
    if (lines > PRODUCTION_LINE_CEILING) {
      const relative = path.relative(repositoryRoot, file);
      findings.push({
        code: "production-file-too-large",
        file: relative,
        message: `${relative} has ${lines} lines; ceiling is ${PRODUCTION_LINE_CEILING}`,
      });
    }
  }

  const testFiles = listFiles(path.join(repositoryRoot, "tests")).filter(
    (file) => file.endsWith(".ts"),
  );
  for (const file of testFiles) {
    const lines = countSourceLines(readFileSync(file, "utf8"));
    if (lines > TEST_LINE_CEILING) {
      const relative = path.relative(repositoryRoot, file);
      findings.push({
        code: "test-file-too-large",
        file: relative,
        message: `${relative} has ${lines} lines; test ceiling is ${TEST_LINE_CEILING}`,
      });
    }
  }

  for (const relative of thinBarrels) {
    const file = path.join(repositoryRoot, relative);
    if (!isRegularFile(file)) {
      findings.push({
        code: "missing-thin-barrel",
        file: relative,
        message: `${relative} is declared as a thin barrel but is missing`,
      });
      continue;
    }
    const lines = countSourceLines(readFileSync(file, "utf8"));
    if (lines > BARREL_LINE_CEILING) {
      findings.push({
        code: "barrel-too-large",
        file: relative,
        message: `${relative} has ${lines} lines; thin-barrel ceiling is ${BARREL_LINE_CEILING}`,
      });
    }
  }

  for (const relative of requiredPaths) {
    if (!existsSync(path.join(repositoryRoot, relative))) {
      findings.push({
        code: "missing-required-path",
        file: relative,
        message: `${relative} is required by the repository documentation contract`,
      });
    }
  }

  checkClaudeInstructionAlias(repositoryRoot, findings);

  checkRootDocLinks(repositoryRoot, findings);
  checkStorageDependencyDirection(repositoryRoot, findings);
  checkBotApiEntrypoints(repositoryRoot, findings);
  checkRetiredBotRuntime(repositoryRoot, productionFiles, findings);

  for (const relative of forbiddenRootTodos) {
    if (existsSync(path.join(repositoryRoot, relative))) {
      findings.push({
        code: "forbidden-root-todo",
        file: relative,
        message: `${relative} must live in loop-develop/current-todo or history`,
      });
    }
  }

  const documentationFiles = [
    "AGENTS.md",
    "README.md",
    "llms.txt",
    ...documentationRoots.flatMap((relative) =>
      listFiles(path.join(repositoryRoot, relative))
        .filter((file) => file.endsWith(".md"))
        .map((file) => path.relative(repositoryRoot, file)),
    ),
  ].filter((relative, index, all) => all.indexOf(relative) === index);

  for (const relative of documentationFiles) {
    const file = path.join(repositoryRoot, relative);
    if (!existsSync(file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const target of localMarkdownLinkTargets(text)) {
      if (!existsSync(path.resolve(path.dirname(file), target))) {
        findings.push({
          code: "broken-doc-link",
          file: relative,
          message: `${relative} links to missing local path ${target}`,
        });
      }
    }
    for (const reference of deprecatedOperatorReferences) {
      if (text.includes(reference)) {
        findings.push({
          code: "deprecated-operator-reference",
          file: relative,
          message: `${relative} contains retired operator reference ${reference}`,
        });
      }
    }
  }

  const currentTodoRoot = path.join(
    repositoryRoot,
    "loop-develop",
    "current-todo",
  );
  const activeGoals = listFiles(currentTodoRoot).filter(
    (file) =>
      path.dirname(file) === currentTodoRoot &&
      /^\d{3}-todo\.md$/u.test(path.basename(file)),
  );
  if (activeGoals.length > 1) {
    findings.push({
      code: "active-goal-count",
      file: path.relative(repositoryRoot, currentTodoRoot),
      message: `found ${activeGoals.length} active goal records; at most one is allowed`,
    });
  }

  return {
    findings,
    productionFiles: productionFiles.length,
    testFiles: testFiles.length,
  };
}

/**
 * Git is the rollback mechanism for the retired harnesses. Keeping their
 * executable trees or launch vocabulary in current TypeScript makes an
 * accidental app-server/Hermes resurrection too easy, while the legacy
 * `bot_codex_sessions` SQLite table may remain as inert schema compatibility.
 */
function checkRetiredBotRuntime(
  repositoryRoot: string,
  productionFiles: readonly string[],
  findings: ArchitectureFinding[],
): void {
  const retiredPaths = [
    "src/bot/codex",
    "src/bot-daemon/codex-agent.ts",
    "src/codex/digest-runner.ts",
    "src/openai-responses/sdk-transport.ts",
    "src/hermes-projection",
    "src/hermes-projection-cli.ts",
    "integrations/hermes",
  ] as const;
  for (const relative of retiredPaths) {
    const target = path.join(repositoryRoot, relative);
    if (!isRegularFile(target) && listFiles(target).length === 0) continue;
    findings.push({
      code: "retired-bot-runtime",
      file: relative,
      message: `${relative} is a retired executable bot runtime; restore it only through a new reviewed migration`,
    });
  }

  const retiredSourceMarkers = [
    "PARILKA_BOT_CODEX_HOME",
    "PARILKA_BOT_CODEX_PATH",
    "PARILKA_BOT_CODEX_CWD",
    "PARILKA_BOT_CODEX_AUTH_SOURCE",
    "spawnCodexAppServer",
    "runBotCodexPreflight",
    "OpenAiSdkResponsesTransport",
  ] as const;
  for (const file of productionFiles) {
    if (path.relative(repositoryRoot, file) === "scripts/check-architecture.ts") {
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const marker of retiredSourceMarkers) {
      if (!source.includes(marker)) continue;
      const relative = path.relative(repositoryRoot, file);
      findings.push({
        code: "retired-bot-runtime",
        file: relative,
        message: `${relative} contains retired bot runtime marker ${marker}`,
      });
    }
  }
}

function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function checkClaudeInstructionAlias(
  repositoryRoot: string,
  findings: ArchitectureFinding[],
): void {
  const relative = "CLAUDE.md";
  const file = path.join(repositoryRoot, relative);
  try {
    if (
      !lstatSync(file).isSymbolicLink() ||
      readlinkSync(file) !== "AGENTS.md"
    ) {
      findings.push({
        code: "invalid-claude-alias",
        file: relative,
        message: "CLAUDE.md must be a symbolic link whose exact target is AGENTS.md",
      });
    }
  } catch {
    findings.push({
      code: "invalid-claude-alias",
      file: relative,
      message: "CLAUDE.md must be a symbolic link whose exact target is AGENTS.md",
    });
  }
}

function checkStorageDependencyDirection(
  repositoryRoot: string,
  findings: ArchitectureFinding[],
): void {
  const storageRoot = path.join(repositoryRoot, "src", "storage");
  for (const file of listFiles(storageRoot).filter((candidate) =>
    candidate.endsWith(".ts"),
  )) {
    const source = readFileSync(file, "utf8");
    for (const specifier of staticModuleSpecifiers(file, source)) {
      if (!isRelativeModuleSpecifier(specifier)) {
        continue;
      }
      const target = resolveRelativeModuleSpecifier(file, specifier);
      if (!target) {
        continue;
      }
      const targetRelative = path.relative(repositoryRoot, target);
      const boundary = forbiddenStorageBoundary(targetRelative);
      if (!boundary) {
        continue;
      }
      const relative = path.relative(repositoryRoot, file);
      findings.push({
        code: "forbidden-storage-dependency",
        file: relative,
        message:
          `${relative} depends on ${boundary} module ${targetRelative} ` +
          `via ${specifier}`,
      });
    }
  }
}

function checkBotApiEntrypoints(
  repositoryRoot: string,
  findings: ArchitectureFinding[],
): void {
  const relative = "package.json";
  const file = path.join(repositoryRoot, relative);
  if (!existsSync(file)) {
    return;
  }

  let scripts: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = (parsed as { scripts?: unknown }).scripts;
      if (typeof candidate === "object" && candidate !== null) {
        scripts = candidate as Record<string, unknown>;
      }
    }
  } catch {
    findings.push({
      code: "unsafe-bot-entrypoint",
      file: relative,
      message: "package.json must declare Bot API scripts through ./bin/parilka-bot",
    });
    return;
  }

  for (const name of ["bot", "bot:start"]) {
    if (scripts?.[name] !== "./bin/parilka-bot") {
      findings.push({
        code: "unsafe-bot-entrypoint",
        file: relative,
        message: `package.json script ${name} must use ./bin/parilka-bot so the lifetime flock is held`,
      });
    }
  }

  const runtimeConfigRelative = path.join("src", "bot", "runtime-config.ts");
  const runtimeConfigFile = path.join(repositoryRoot, runtimeConfigRelative);
  if (existsSync(runtimeConfigFile)) {
    const source = readFileSync(runtimeConfigFile, "utf8");
    const sharedBootstrap = staticModuleSpecifiers(runtimeConfigFile, source)
      .some((specifier) =>
        specifier === "../config.js" || specifier.includes("config/env-files"),
      );
    if (sharedBootstrap) {
      findings.push({
        code: "unsafe-bot-entrypoint",
        file: runtimeConfigRelative,
        message:
          "Bot API runtime must use its explicit process environment and must not load the shared MTProto dotenv layer",
      });
    }
  }
}

function staticModuleSpecifiers(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
  );
  const specifiers: string[] = [];
  for (const statement of parsed.statements) {
    const moduleSpecifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }
  return specifiers;
}

function isRelativeModuleSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

function resolveRelativeModuleSpecifier(
  file: string,
  specifier: string,
): string | undefined {
  return ts.resolveModuleName(
    specifier,
    file,
    moduleResolutionOptions,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
}

function forbiddenStorageBoundary(
  targetRelative: string,
): string | undefined {
  if (
    isPathWithin(targetRelative, path.join("src", "bot"))
  ) {
    return "bot";
  }
  if (
    isPathWithin(targetRelative, path.join("src", "mcp-tools")) ||
    isPathWithin(targetRelative, path.join("src", "mcp-proxy")) ||
    [
      path.join("src", "mcp-loopback.ts"),
      path.join("src", "mcp-protocol.ts"),
      path.join("src", "tools.ts"),
    ].includes(targetRelative)
  ) {
    return "MCP registry, tools, or proxy";
  }
  if (processShellEntrypoints.has(targetRelative)) {
    return "process shell";
  }
  return undefined;
}

function isPathWithin(candidate: string, directory: string): boolean {
  return (
    candidate === directory ||
    candidate.startsWith(`${directory}${path.sep}`)
  );
}

export function localMarkdownLinkTargets(text: string): string[] {
  const targets: string[] = [];
  const links = text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g);
  for (const match of links) {
    const raw = match[1];
    if (raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
      continue;
    }
    const withoutAnchor = raw.split("#", 1)[0];
    if (withoutAnchor.length > 0) {
      targets.push(decodeURIComponent(withoutAnchor));
    }
  }
  return targets;
}

function checkRootDocLinks(
  repositoryRoot: string,
  findings: ArchitectureFinding[],
): void {
  for (const relative of ["AGENTS.md", "llms.txt"]) {
    const file = path.join(repositoryRoot, relative);
    if (!existsSync(file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const target of localMarkdownLinkTargets(text)) {
      if (!existsSync(path.resolve(path.dirname(file), target))) {
        findings.push({
          code: "broken-doc-link",
          file: relative,
          message: `${relative} links to missing local path ${target}`,
        });
      }
    }
  }
}

function main(): void {
  const result = checkArchitecture();
  if (result.findings.length > 0) {
    for (const finding of result.findings) {
      console.error(`${finding.code}: ${finding.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        productionFiles: result.productionFiles,
        testFiles: result.testFiles,
        productionLineCeiling: PRODUCTION_LINE_CEILING,
        testLineCeiling: TEST_LINE_CEILING,
        thinBarrelLineCeiling: BARREL_LINE_CEILING,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
