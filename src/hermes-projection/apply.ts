import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MessageStore } from "../store.js";
import { captureDreamSnapshot } from "./snapshot.js";
import {
  assembleMemoryContent,
  codepointLength,
  countManagedEntries,
  detectMemoryDrift,
  planMemoryRender,
} from "./render-memory.js";
import { applySkills } from "./skills-managed.js";
import type {
  HermesMemoryLock,
  ProjectionOptions,
  ProjectionReport,
} from "./types.js";
import { acquireHermesMemoryLock } from "./lock.js";

const TOP_LEVEL_MEMORY = /^memory: *(?: +#.*)?$/u;
const MEMORY_CHAR_LIMIT_SCALAR =
  /^  memory_char_limit: ([0-9]+)(?: +)?(?: +#.*)?$/u;
const LOOKS_LIKE_CHAR_LIMIT = /^memory_char_limit([ \t]|:)/u;

/**
 * Read memory.memory_char_limit from Hermes profile config.yaml.
 * Strict grammar: a top-level `memory:` block whose scalar appears with
 * exactly two leading spaces, an integer value, and an optional plain-space
 * tail and/or comment. Duplicate keys, junk suffixes, tabs, nested or wrong
 * indentation, and invalid values are rejected fail-closed.
 */
export function readMemoryCharLimit(profileHome: string): number {
  const configPath = join(profileHome, "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`Hermes profile config not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf-8");
  let inMemoryBlock = false;
  let found: number | undefined;
  for (const line of raw.split("\n")) {
    if (!inMemoryBlock) {
      if (TOP_LEVEL_MEMORY.test(line)) {
        inMemoryBlock = true;
      }
      continue;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!LOOKS_LIKE_CHAR_LIMIT.test(line.trimStart())) {
      if (/^[ \t]/u.test(line)) continue; // sibling scalar or deeper nesting
      inMemoryBlock = false; // next top-level key ends the memory block
      continue;
    }
    const match = MEMORY_CHAR_LIMIT_SCALAR.exec(line);
    if (!match) {
      throw new Error("Invalid memory_char_limit line in config.yaml");
    }
    if (found !== undefined) {
      throw new Error("Duplicate memory_char_limit in config.yaml");
    }
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 100) {
      throw new Error(`Invalid memory_char_limit in config: ${match[1]}`);
    }
    found = value;
  }
  if (found === undefined) {
    throw new Error("memory.memory_char_limit not found in config.yaml");
  }
  return found;
}

/**
 * Read MEMORY.md without following symlinks on any path below the profile
 * home. Returns undefined when the file does not exist.
 */
function readMemoryMd(profileHome: string): string | undefined {
  const memoriesPath = join(profileHome, "memories");
  let memoriesStat;
  try {
    memoriesStat = lstatSync(memoriesPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (memoriesStat.isSymbolicLink()) {
    throw new Error("memories path is a symlink — refusing to follow.");
  }
  if (!memoriesStat.isDirectory()) {
    throw new Error("memories path is not a directory.");
  }
  const memoryPath = join(memoriesPath, "MEMORY.md");
  let stat;
  try {
    stat = lstatSync(memoryPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error("MEMORY.md is a symlink — refusing to follow.");
  }
  if (!stat.isFile()) {
    throw new Error("MEMORY.md is not a regular file.");
  }
  return readFileSync(memoryPath, "utf-8");
}

/**
 * Validate (and in apply mode create) the memories directory. Never follows
 * symlinks; a symlinked memories path fails closed. Creation happens only in
 * apply mode.
 */
export function prepareMemoriesDir(profileHome: string, create: boolean): void {
  const memoriesPath = join(profileHome, "memories");
  let stat;
  try {
    stat = lstatSync(memoriesPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    if (!create) {
      throw new Error("memories directory is missing.");
    }
    mkdirSync(memoriesPath, { mode: 0o700 });
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error("memories path is a symlink — refusing to follow.");
  }
  if (!stat.isDirectory()) {
    throw new Error("memories path is not a directory.");
  }
}

/**
 * Exact backup of drifted MEMORY.md content to MEMORY.md.bak.<epoch>.
 * The backup is a byte-exact copy of the raw content.
 */
export function createDriftBackup(profileHome: string, raw: string): string {
  const memoryPath = join(profileHome, "memories", "MEMORY.md");
  const bakPath = `${memoryPath}.bak.${Date.now()}`;
  writeFileSync(bakPath, raw, { mode: 0o600, flag: "wx" });
  return bakPath;
}

/** Atomic write + fsync + rename; exact content, no trailing newline. */
function atomicWriteMemoryMd(profileHome: string, content: string): void {
  const memoryPath = join(profileHome, "memories", "MEMORY.md");
  const tmpPath = `${memoryPath}.tmp-${Date.now()}`;
  writeFileSync(tmpPath, content, { mode: 0o600, flag: "wx" });
  const fd = openSync(tmpPath, "r+");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmpPath, memoryPath);
}

/**
 * Main projection flow: snapshot → render → apply (if --apply). Drift aborts
 * the memory phase after an exact backup; dry-run never writes but still
 * reports the failure.
 */
export async function runProjection(
  store: MessageStore,
  options: ProjectionOptions,
): Promise<ProjectionReport> {
  const snapshot = captureDreamSnapshot(store, options.chatId);
  const charLimit = readMemoryCharLimit(options.profileHome);

  let memoryStatus: ProjectionReport["memory"]["status"] = "ok";
  let memoryError: string | undefined;
  let managedEntries = 0;
  let ownerChars = 0;
  let totalChars = 0;

  let raw: string | undefined;
  try {
    raw = readMemoryMd(options.profileHome);
  } catch (error) {
    memoryStatus = "failed";
    memoryError = error instanceof Error ? error.message : String(error);
  }

  const plan = planMemoryRender(snapshot, raw);
  ownerChars = plan.ownerChars;
  managedEntries = countManagedEntries(plan);
  totalChars = plan.combinedChars;

  if (memoryStatus === "ok") {
    const drift = detectMemoryDrift(raw, charLimit);
    if (drift) {
      memoryStatus = "failed";
      memoryError = drift;
      if (options.apply) {
        createDriftBackup(options.profileHome, raw!);
      }
    } else {
      const assembled = assembleMemoryContent(plan, charLimit);
      if (!assembled) {
        memoryStatus = "oversize";
        memoryError = `Semantic memory and owner entries do not fit within ${charLimit} codepoints.`;
      } else {
        managedEntries = assembled.managedEntries;
        totalChars = codepointLength(assembled.content);
        if (options.apply) {
          atomicWriteMemoryMd(options.profileHome, assembled.content);
        }
      }
    }
  }

  const skillsReport = applySkills(snapshot, options.profileHome, {
    dryRun: !options.apply,
  });

  const report: ProjectionReport = {
    ok: memoryStatus === "ok" && skillsReport.status === "ok",
    mode: options.apply ? "applied" : "dry_run",
    chatId: options.chatId,
    dbPath: options.dbPath,
    profileHome: options.profileHome,
    contentHash: snapshot.contentHash,
    memory: {
      status: memoryStatus,
      managedEntries,
      ownerChars,
      totalChars,
      limit: charLimit,
      ...(memoryError !== undefined ? { error: memoryError } : {}),
    },
    skills: skillsReport,
  };

  return report;
}

/**
 * Full flow with the Hermes memory flock covering the profile read + apply.
 */
export async function runProjectionWithLocks(
  store: MessageStore,
  options: ProjectionOptions,
): Promise<ProjectionReport> {
  let hermesLock: HermesMemoryLock | undefined;
  try {
    prepareMemoriesDir(options.profileHome, options.apply);
    hermesLock = await acquireHermesMemoryLock(
      options.profileHome,
      options.lockTimeoutMs,
    );
    const report = await runProjection(store, options);
    return {
      ...report,
      lock: { mechanism: "fcntl_flock", acquired: true },
    };
  } finally {
    hermesLock?.release();
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
