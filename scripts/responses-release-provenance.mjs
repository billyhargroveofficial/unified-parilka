#!/usr/bin/env node
import {
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESPONSES_SOURCE_MANIFEST_NAME = "RESPONSES_SOURCE_MANIFEST.json";
const MANIFEST_SCHEMA_VERSION = 1;

/**
 * The direct Responses runtime's complete build/deploy input surface. It is
 * deliberately explicit: no environment, database, credential, `.deploy`,
 * test, documentation, or user-owned runtime file can enter the manifest.
 */
const STATIC_SOURCE_FILES = Object.freeze([
  ".env.example",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "bin/parilka-bot",
  "bin/parilka-bot-lock.mjs",
  "bin/parilka-digests",
  "bin/parilka-maintain",
  "bin/telegram-parilka-mcp-check-build",
  "config/parilka-bot.env.example",
  "config/parilka-maintain.env.example",
  "scripts/build-responses-release.mjs",
  "scripts/responses-release-provenance.mjs",
  "systemd/parilka-bot-preflight.service",
  "systemd/parilka-bot.service",
  "systemd/parilka-maintain.service",
  "systemd/parilka-maintain.timer",
]);

/** Returns a sorted, non-secret list of files that determine a release. */
export function responsesReleaseSourceFiles(projectDir) {
  const root = resolve(projectDir);
  const files = [
    ...STATIC_SOURCE_FILES,
    ...listTypeScriptFiles(root, "src"),
  ];
  return Object.freeze([...new Set(files)].sort());
}

/** A deterministic manifest: no timestamps, host paths, secrets, or runtime state. */
export function createResponsesReleaseProvenance(projectDir, files = responsesReleaseSourceFiles(projectDir)) {
  const root = resolve(projectDir);
  const normalizedFiles = [...new Set(files)].sort();
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    algorithm: "sha256",
    files: normalizedFiles.map((file) => hashRegularProjectFile(root, file)),
  });
}

export function serializeResponsesReleaseProvenance(provenance) {
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

/**
 * Fails closed if the immutable release's source manifest does not exactly
 * match the current reviewed project inputs. The optional file list exists
 * only for isolated unit fixtures; production always uses the complete list.
 */
export function verifyResponsesReleaseProvenance(projectDir, releaseDir, files = responsesReleaseSourceFiles(projectDir)) {
  const root = resolve(projectDir);
  const manifest = join(resolve(releaseDir), RESPONSES_SOURCE_MANIFEST_NAME);
  const expected = serializeResponsesReleaseProvenance(
    createResponsesReleaseProvenance(root, files),
  );
  let actual;
  try {
    const details = lstatSync(manifest);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    actual = readFileSync(manifest, "utf8");
  } catch {
    throw new Error("Responses release provenance manifest is missing or unsafe.");
  }
  if (actual !== expected) {
    throw new Error("Responses release provenance does not match current source/config/package inputs.");
  }
}

function hashRegularProjectFile(projectDir, file) {
  if (typeof file !== "string" || file.length === 0 || file.startsWith("/") || file.includes("\\") || file.split("/").includes("..")) {
    throw new Error("Responses release provenance contains an invalid relative path.");
  }
  const absolute = resolve(projectDir, file);
  if (relative(projectDir, absolute) !== file) {
    throw new Error("Responses release provenance path escapes the project.");
  }
  const details = lstatSync(absolute);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Responses release provenance input must be a regular non-symlink file: ${file}`);
  }
  const bytes = readFileSync(absolute);
  return Object.freeze({
    path: file,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function listTypeScriptFiles(projectDir, directory) {
  const absolute = join(projectDir, directory);
  const details = lstatSync(absolute);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Responses release provenance source directory is unsafe: ${directory}`);
  }
  return listDirectory(absolute, projectDir);
}

function listDirectory(directory, projectDir) {
  // This indirection avoids accepting Dirent metadata as authority: every
  // candidate is re-checked with lstat before it is included or descended.
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name);
    const details = lstatSync(absolute);
    if (details.isSymbolicLink()) {
      throw new Error(`Responses release provenance source tree contains a symbolic link: ${relative(projectDir, absolute)}`);
    }
    if (details.isDirectory()) {
      files.push(...listDirectory(absolute, projectDir));
    } else if (details.isFile() && name.endsWith(".ts")) {
      files.push(relative(projectDir, absolute));
    }
  }
  return files;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, releaseDir] = process.argv.slice(2);
  if (flag !== "--release" || typeof releaseDir !== "string" || process.argv.length !== 4) {
    process.stderr.write("Usage: responses-release-provenance.mjs --release <immutable-release-dir>\n");
    process.exitCode = 64;
  } else {
    try {
      verifyResponsesReleaseProvenance(process.cwd(), releaseDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Responses release provenance verification failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 78;
    }
  }
}
