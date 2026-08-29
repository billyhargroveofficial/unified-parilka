import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MessageStore } from "../store.js";
import { acquireHermesMemoryLock } from "../hermes-projection/lock.js";
import {
  assembleMemoryContent,
  codepointLength,
  countManagedEntries,
  detectMemoryDrift,
  planMemoryRender,
} from "../hermes-projection/render-memory.js";
import { applySkills } from "../hermes-projection/skills-managed.js";
import { captureDreamSnapshot } from "../hermes-projection/snapshot.js";
import type {
  HermesMemoryLock,
  ProjectionReport,
} from "../hermes-projection/types.js";

export const DEFAULT_MEMORY_CHAR_LIMIT = 8000;

export interface OpenClawProjectionOptions {
  apply: boolean;
  dbPath: string;
  chatId: string;
  workspace: string;
  lockTimeoutMs: number;
  memoryCharLimit: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function readWorkspaceMemory(workspace: string): string | undefined {
  const memoryPath = join(workspace, "MEMORY.md");
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

export function atomicWriteWorkspaceMemory(workspace: string, content: string): void {
  const memoryPath = join(workspace, "MEMORY.md");
  const tmpPath = `${memoryPath}.tmp-${Date.now()}`;
  writeFileSync(tmpPath, content, { mode: 0o600, flag: "wx" });
  const fd = openSync(tmpPath, "r+");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmpPath, memoryPath);
}

export function createWorkspaceDriftBackup(workspace: string, raw: string): string {
  const bakPath = join(workspace, `MEMORY.md.bak.${Date.now()}`);
  writeFileSync(bakPath, raw, { mode: 0o600, flag: "wx" });
  return bakPath;
}

export async function runOpenClawProjection(
  store: MessageStore,
  options: OpenClawProjectionOptions,
): Promise<ProjectionReport> {
  const snapshot = captureDreamSnapshot(store, options.chatId);
  const charLimit = options.memoryCharLimit;

  let memoryStatus: ProjectionReport["memory"]["status"] = "ok";
  let memoryError: string | undefined;
  let managedEntries = 0;
  let ownerChars = 0;
  let totalChars = 0;
  let raw: string | undefined;
  try {
    raw = readWorkspaceMemory(options.workspace);
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
        createWorkspaceDriftBackup(options.workspace, raw!);
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
          atomicWriteWorkspaceMemory(options.workspace, assembled.content);
        }
      }
    }
  }

  const skillsReport = applySkills(snapshot, options.workspace, {
    dryRun: !options.apply,
  });

  return {
    ok: memoryStatus === "ok" && skillsReport.status === "ok",
    mode: options.apply ? "applied" : "dry_run",
    chatId: options.chatId,
    dbPath: options.dbPath,
    profileHome: options.workspace,
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
}

export async function runOpenClawProjectionWithLocks(
  store: MessageStore,
  options: OpenClawProjectionOptions,
): Promise<ProjectionReport> {
  let lock: HermesMemoryLock | undefined;
  try {
    lock = await acquireHermesMemoryLock(
      options.workspace,
      options.lockTimeoutMs,
      join(options.workspace, "MEMORY.md.lock"),
    );
    const report = await runOpenClawProjection(store, options);
    return {
      ...report,
      lock: { mechanism: "fcntl_flock", acquired: true },
    };
  } finally {
    lock?.release();
  }
}
