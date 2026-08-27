#!/usr/bin/env node
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESPONSES_SOURCE_MANIFEST_NAME,
  createResponsesReleaseProvenance,
  serializeResponsesReleaseProvenance,
  verifyResponsesReleaseProvenance,
} from "./responses-release-provenance.mjs";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deployDir = join(projectDir, ".deploy");
const releasesDir = join(deployDir, "responses-releases");
const currentPointer = join(deployDir, "responses-current");
const legacyArtifact = join(deployDir, "responses-dist");
const releaseId = `${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${process.pid}-${randomBytes(6).toString("hex")}`;
const stagingDir = join(releasesDir, `.staging-${releaseId}`);
const releaseDir = join(releasesDir, releaseId);
const requiredEntrypoints = ["bot-daemon.js", "maintenance-cli.js", "digest-cli.js"];
const buildLockDir = join(deployDir, ".responses-release-build.lock");

function main() {
  mkdirSync(releasesDir, { recursive: true, mode: 0o755 });
  const buildLock = acquireResponsesReleaseBuildLock(buildLockDir);
  try {
    const previousReleaseDir = assertCurrentPointerIsSafe();
    mkdirSync(stagingDir, { mode: 0o755 });
    const sourceProvenance = serializeResponsesReleaseProvenance(
      createResponsesReleaseProvenance(projectDir),
    );
  const tsc = join(projectDir, "node_modules", "typescript", "bin", "tsc");
  const compiled = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", stagingDir], {
    cwd: projectDir,
    stdio: "inherit",
  });
  if (compiled.status !== 0) fail("TypeScript Responses release build failed.");

  for (const entrypoint of requiredEntrypoints) {
    const candidate = join(stagingDir, entrypoint);
    const details = lstatSync(candidate);
    if (!details.isFile() || details.isSymbolicLink()) fail(`Missing regular release entrypoint: ${entrypoint}`);
    const checked = spawnSync(process.execPath, ["--check", candidate], { cwd: projectDir, stdio: "inherit" });
    if (checked.status !== 0) fail(`Syntax check failed for release entrypoint: ${entrypoint}`);
  }

  // A compiler success alone cannot prove what source tree produced an
  // artifact if files changed during the build. Capture the exact, explicitly
  // non-secret input list before compilation, then require the same hashes at
  // the activation boundary and seal that evidence inside the release.
  const postBuildProvenance = serializeResponsesReleaseProvenance(
    createResponsesReleaseProvenance(projectDir),
  );
  if (postBuildProvenance !== sourceProvenance) {
    fail("Responses source/config/package inputs changed during the release build.");
  }
  writeFileSync(join(stagingDir, RESPONSES_SOURCE_MANIFEST_NAME), sourceProvenance, {
    encoding: "utf8",
    mode: 0o444,
  });

  renameSync(stagingDir, releaseDir);
  makeReadOnly(releaseDir);
  const activation = switchCurrentPointer(releaseDir);
  try {
    verifyResponsesReleaseProvenance(projectDir, releaseDir);
  } catch (error) {
    // A stale builder must never revert a pointer it no longer owns. The
    // build lock serializes cooperating builders; this exact identity check is
    // a second fence against a writer that bypassed the lock.
    restoreCurrentPointerIfOwned(previousReleaseDir, activation);
    throw error;
  }
  // This exact ignored directory was the former generated staging artifact.
  // It is never a target for activation once the atomic pointer is live.
  rmSync(legacyArtifact, { recursive: true, force: true });
  process.stdout.write(`Responses release activated: ${releaseId}\n`);
} catch (error) {
  try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  throw error;
  } finally {
    releaseResponsesReleaseBuildLock(buildLock);
  }
}

function assertCurrentPointerIsSafe() {
  try {
    const details = lstatSync(currentPointer);
    if (!details.isSymbolicLink()) fail(".deploy/responses-current must be a symbolic link when present.");
    const resolved = realpathSync(currentPointer);
    const releaseName = relative(releasesDir, resolved);
    if (
      releaseName.length === 0
      || releaseName.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || releaseName.includes(process.platform === "win32" ? "\\" : "/")
      || !/^[0-9]+-[0-9]+-[0-9a-f]{12}$/u.test(releaseName)
      || !lstatSync(resolved).isDirectory()
    ) {
      fail(".deploy/responses-current must resolve to one versioned release directory.");
    }
    return resolved;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function switchCurrentPointer(target, options = {}) {
  const pointer = options.pointer ?? currentPointer;
  const pointerDirectory = options.pointerDirectory ?? deployDir;
  const temporaryName = options.temporaryName ?? `.responses-current-${releaseId}`;
  const temporaryPointer = join(pointerDirectory, temporaryName);
  symlinkSync(relative(pointerDirectory, target), temporaryPointer);
  renameSync(temporaryPointer, pointer);
  return currentPointerIdentity(pointer);
}

function restoreCurrentPointerIfOwned(previousReleaseDir, activation, options = {}) {
  const pointer = options.pointer ?? currentPointer;
  if (!samePointerIdentity(tryCurrentPointerIdentity(pointer), activation)) return false;
  if (previousReleaseDir !== undefined) {
    switchCurrentPointer(previousReleaseDir, options);
    return true;
  }
  unlinkSync(pointer);
  return true;
}

function currentPointerIdentity(pointer) {
  const details = lstatSync(pointer);
  if (!details.isSymbolicLink()) fail(".deploy/responses-current must be a symbolic link when present.");
  return Object.freeze({
    device: details.dev,
    inode: details.ino,
    target: readlinkSync(pointer),
  });
}

function tryCurrentPointerIdentity(pointer) {
  try {
    return currentPointerIdentity(pointer);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function samePointerIdentity(left, right) {
  return left !== undefined && right !== undefined &&
    left.device === right.device && left.inode === right.inode && left.target === right.target;
}

/**
 * A mkdir lock makes release activation/rollback one critical section across
 * processes. It is deliberately fail-closed for unknown lock state; only a
 * regular, same-user owner record for a known-dead local PID is reclaimable.
 */
function acquireResponsesReleaseBuildLock(lockDir) {
  const owner = Object.freeze({
    pid: process.pid,
    uid: process.getuid?.(),
    hostname: hostname(),
    nonce: randomBytes(16).toString("hex"),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      try {
        writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        try { rmSync(lockDir, { recursive: true, force: false }); } catch { /* leave an unknown lock fail-closed */ }
        throw error;
      }
      return Object.freeze({ directory: lockDir, owner, identity: directoryIdentity(lockDir) });
    } catch (error) {
      if (!isErrno(error, "EEXIST") || attempt !== 0 || !reclaimStaleResponsesReleaseBuildLock(lockDir)) {
        throw new Error("Another Responses release builder already holds the build lock.");
      }
    }
  }
  fail("Unable to acquire Responses release build lock.");
}

function releaseResponsesReleaseBuildLock(lock) {
  if (!sameDirectoryIdentity(directoryIdentity(lock.directory), lock.identity) ||
    !sameLockOwner(readLockOwner(lock.directory), lock.owner)) {
    fail("Responses release build lock changed before it could be released.");
  }
  rmSync(lock.directory, { recursive: true, force: false });
}

function reclaimStaleResponsesReleaseBuildLock(lockDir) {
  const details = lstatSync(lockDir);
  if (details.isSymbolicLink() || !details.isDirectory() || details.uid !== process.getuid?.() || (details.mode & 0o777) !== 0o700) {
    fail("Responses release build lock is unsafe.");
  }
  const names = readdirSync(lockDir);
  if (names.length !== 1 || names[0] !== "owner.json") {
    fail("Responses release build lock has an unknown owner state.");
  }
  const owner = readLockOwner(lockDir);
  if (owner.uid !== process.getuid?.() || owner.hostname !== hostname() || isPidAlive(owner.pid)) {
    return false;
  }
  rmSync(lockDir, { recursive: true, force: false });
  return true;
}

function readLockOwner(lockDir) {
  const ownerPath = join(lockDir, "owner.json");
  const details = lstatSync(ownerPath);
  if (details.isSymbolicLink() || !details.isFile() || details.uid !== process.getuid?.() || details.size < 1 || details.size > 1_024) {
    fail("Responses release build lock has an unsafe owner record.");
  }
  let value;
  try { value = JSON.parse(readFileSync(ownerPath, "utf8")); } catch { fail("Responses release build lock has an invalid owner record."); }
  if (value === null || typeof value !== "object" || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    (value.uid !== undefined && (!Number.isSafeInteger(value.uid) || value.uid < 0)) ||
    typeof value.hostname !== "string" || value.hostname.length === 0 || value.hostname.length > 255 ||
    typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/u.test(value.nonce)) {
    fail("Responses release build lock has an invalid owner record.");
  }
  return Object.freeze({ pid: value.pid, ...(value.uid === undefined ? {} : { uid: value.uid }), hostname: value.hostname, nonce: value.nonce });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function directoryIdentity(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isDirectory()) fail("Responses release build lock is unsafe.");
  return Object.freeze({ device: details.dev, inode: details.ino });
}

function sameDirectoryIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function sameLockOwner(left, right) {
  return left.pid === right.pid && left.uid === right.uid && left.hostname === right.hostname && left.nonce === right.nonce;
}

function isErrno(error, code) {
  return error !== null && typeof error === "object" && error.code === code;
}

function makeReadOnly(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) fail(`Release tree must not contain symbolic links: ${path}`);
  if (details.isDirectory()) {
    for (const name of readdirSync(path)) makeReadOnly(join(path, name));
    chmodSync(path, 0o555);
    return;
  }
  if (details.isFile()) {
    chmodSync(path, 0o444);
    return;
  }
  fail(`Release tree contains an unsupported entry: ${path}`);
}

function fail(message) {
  throw new Error(message);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export {
  acquireResponsesReleaseBuildLock,
  releaseResponsesReleaseBuildLock,
  restoreCurrentPointerIfOwned,
  switchCurrentPointer,
};
