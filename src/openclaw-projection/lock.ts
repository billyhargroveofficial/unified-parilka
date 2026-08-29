import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { MemoryLock } from "./types.js";

export class MemoryLockHeldError extends Error {
  readonly name = "MemoryLockHeldError";
  readonly code = "memory_lock_held";
}

export class MemoryLockTimeoutError extends Error {
  readonly name = "MemoryLockTimeoutError";
  readonly code = "memory_lock_timeout";
}

const FLOCK_BIN = "/usr/bin/flock";

/**
 * Acquire an fcntl flock on the MEMORY.md lock file.
 *
 * Spawns a child process that holds the lock: `flock --exclusive lockfile
 * /bin/sh -c 'printf TOKEN\n && read _'`. The parent resolves when it sees
 * TOKEN on stdout. The child holds the lock until the parent calls release(),
 * which closes stdin and kills the child.
 */
export function acquireMemoryLock(
  profileHome: string,
  timeoutMs: number,
  lockPath = join(profileHome, "MEMORY.md.lock"),
): Promise<MemoryLock> {

  try {
    const lockStat = lstatSync(lockPath);
    if (lockStat.isSymbolicLink()) {
      return Promise.reject(
        new MemoryLockHeldError(
          "Memory lock file must not be a symlink.",
        ),
      );
    }
    if (!lockStat.isFile()) {
      return Promise.reject(
        new MemoryLockHeldError(
          "Memory lock file must be a regular file.",
        ),
      );
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      return Promise.reject(error);
    }
  }

  return new Promise((resolve, reject) => {
    const readyToken = randomBytes(16).toString("hex");
    // GNU flock accepts fractional seconds, so keep full millisecond precision.
    const flockTimeoutSec = (timeoutMs / 1000).toFixed(3);

    const child: ChildProcess = spawn(
      FLOCK_BIN,
      [
        "--exclusive",
        "--no-fork",
        "--timeout",
        flockTimeoutSec,
        lockPath,
        "/bin/sh",
        "-c",
        `printf '${readyToken}\\n' && read _`,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs + 15_000,
        killSignal: "SIGKILL",
      },
    );

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new MemoryLockTimeoutError(
          `Could not acquire memory lock within ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs + 5_000);

    let stdout = "";
    let settled = false;

    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
      if (stdout.includes(readyToken) && !settled) {
        settled = true;
        clearTimeout(timer);
        const released = { value: false };
        resolve({
          release() {
            if (released.value) return;
            released.value = true;
            try {
              child.stdin!.end();
            } catch {
              // already closed
            }
            child.kill("SIGTERM");
            // Hard kill fallback
            setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // already dead
              }
            }, 2_000).unref();
          },
        });
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        reject(
          new MemoryLockTimeoutError(
            `Memory lock child killed by signal ${signal}.`,
          ),
        );
      } else if (code === 1) {
        // GNU flock exits 1 when --timeout expires without acquiring.
        reject(
          new MemoryLockTimeoutError(
            `Could not acquire memory lock within ${timeoutMs}ms.`,
          ),
        );
      } else {
        reject(
          new MemoryLockHeldError(
            "Memory lock is held by another process.",
          ),
        );
      }
    });
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
