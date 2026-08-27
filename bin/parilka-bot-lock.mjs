#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, sep } from "node:path";

const LOCK_CONFLICT_EXIT = 75;
const FLOCK_BINARY = "/usr/bin/flock";
const VERIFIED_LOCK_DESCRIPTOR_PATH = "/proc/self/fd/3";

const [projectDirectory, lockPath, nodeBinary, daemonEntrypoint, ...daemonArguments] = process.argv.slice(2);
if (!projectDirectory || !lockPath || !nodeBinary || !daemonEntrypoint) {
  fail("parilka-bot lock helper requires project, lock, Node, and daemon paths");
}
if (!isAbsolute(lockPath)) fail("PARILKA_BOT_LOCK_FILE must be an absolute path");

const uid = process.getuid?.();
if (uid === undefined) fail("Parilka Bot API ownership requires a POSIX user identity");
assertPathHasNoSymlink(lockPath, "PARILKA_BOT_LOCK_FILE");
assertPrivateLockDirectory(dirname(lockPath), uid);

let descriptor;
try {
  descriptor = openSync(
    lockPath,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || opened.uid !== uid) {
    fail("PARILKA_BOT_LOCK_FILE must be an owner-owned regular non-symlink file");
  }
  fchmodSync(descriptor, 0o600);
  // O_NOFOLLOW protects the leaf at open time. Confirm the pathname still
  // identifies this inode before giving it to flock so a renamed replacement
  // cannot create a separate Bot API ownership domain.
  const named = lstatSync(lockPath);
  if (named.isSymbolicLink() || !named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
    fail("PARILKA_BOT_LOCK_FILE changed while it was opened");
  }
} catch (error) {
  if (typeof descriptor === "number") closeSync(descriptor);
  fail(error instanceof Error ? error.message : "could not safely open PARILKA_BOT_LOCK_FILE");
}

let child;
let forwardedSignal;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    forwardedSignal = signal;
    child?.kill(signal);
  });
}

// Pass the verified descriptor as fd 3. With a following command, util-linux
// flock interprets a bare `3` as a pathname; /proc/self/fd/3 makes it reopen
// the already-verified inode instead of creating a cwd-relative file named 3.
// --no-fork then execs the daemon while retaining the opened lock.
child = spawn(
  FLOCK_BINARY,
  ["-n", "-E", String(LOCK_CONFLICT_EXIT), "--no-fork", VERIFIED_LOCK_DESCRIPTOR_PATH, nodeBinary, daemonEntrypoint, ...daemonArguments],
  {
    cwd: projectDirectory,
    env: process.env,
    stdio: ["inherit", "inherit", "inherit", descriptor],
  },
);
closeSync(descriptor);
if (forwardedSignal !== undefined) child.kill(forwardedSignal);

child.once("error", (error) => fail(`could not start flock: ${error.message}`));
child.once("exit", (code, signal) => {
  if (code === LOCK_CONFLICT_EXIT) {
    fail(`another Parilka Bot API owner already holds ${lockPath}`);
  }
  if (code !== null) process.exit(code);
  process.exit(signal === null ? 1 : 128 + signalNumber(signal));
});

function assertPrivateLockDirectory(path, expectedUid) {
  const directory = lstatSync(path);
  if (directory.isSymbolicLink() || !directory.isDirectory() || directory.uid !== expectedUid || (directory.mode & 0o077) !== 0) {
    fail("PARILKA_BOT_LOCK_FILE parent must be an owner-only regular directory");
  }
}

function assertPathHasNoSymlink(path, name) {
  const root = parse(path).root;
  let current = root;
  for (const segment of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) fail(`${name} must not contain symbolic links`);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function signalNumber(signal) {
  return { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 1;
}

function fail(message) {
  writeSync(2, `${message}\n`);
  process.exit(1);
}
