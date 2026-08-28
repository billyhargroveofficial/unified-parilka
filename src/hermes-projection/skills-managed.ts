import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  DreamSnapshot,
  ManagedLessonAggregate,
  ManagedSkill,
} from "./types.js";
import {
  LESSONS_DIR,
  lessonsContentHash,
  renderLessonsSkillMd,
  renderSkillMd,
  skillContentHash,
  skillDirName,
} from "./render-skills.js";
import {
  hasErrorCode,
  inspectManagedRoot,
  MANIFEST_JSON,
  MARKER_OWNER,
  MARKER_VERSION,
  QUARANTINE_PREFIX,
  validateManifest,
  type OwnedMarker,
} from "./skills-inspect.js";

const MANAGED_ROOT = "parilka-managed";
const MANAGED_JSON = ".parilka-managed.json";

export interface SkillsReport {
  status: "ok" | "skipped" | "failed";
  created: number;
  updated: number;
  removed: number;
  lessonsCount: number;
  error?: string;
}

export interface ApplySkillsOptions {
  dryRun?: boolean;
}

interface DesiredState {
  skills: Map<string, ManagedSkill>;
  lessons: ManagedLessonAggregate | null;
}

/**
 * Apply managed skills from snapshot into <profileHome>/skills/parilka-managed/.
 * Every managed path is checked with lstat (symlinks fail closed), all
 * conflicts are detected before any write, and stale dirs are removed via
 * rename to a stamped quarantine name followed by unlink of the two known
 * regular files and rmdir — no recursion. Desired skills, removals, and the
 * manifest are serialized in stable dirName sort.
 */
export function applySkills(
  snapshot: DreamSnapshot,
  profileHome: string,
  options: ApplySkillsOptions = {},
): SkillsReport {
  const dryRun = options.dryRun === true;
  const root = join(profileHome, "skills", MANAGED_ROOT);
  const conflicts: string[] = [];
  const { rootEntries, current } = inspectManagedRoot(
    profileHome,
    root,
    conflicts,
  );
  const desired = computeDesiredSkills(snapshot);

  for (const existing of current.values()) {
    if (existing.marker.contentHash !== existing.actualHash) {
      conflicts.push(
        `${existing.dirName}: marker hash does not match SKILL.md (manual drift)`,
      );
    }
  }

  // Any entry in the root that is not the manifest or a managed dir is
  // unexpected; quarantine leftovers are already conflicts.
  for (const name of rootEntries) {
    if (name === MANIFEST_JSON) continue;
    if (current.has(name)) continue;
    if (desired.skills.has(name)) continue;
    if (desired.lessons && desired.lessons.dirName === name) continue;
    conflicts.push(`${name}: unexpected entry inside managed root`);
  }

  validateManifest(root, rootEntries, current, conflicts);

  if (conflicts.length > 0) {
    return {
      status: "failed",
      created: 0,
      updated: 0,
      removed: 0,
      lessonsCount: desired.lessons ? desired.lessons.lessons.length : 0,
      error: `Skill conflicts: ${conflicts.join("; ")}`,
    };
  }

  let created = 0;
  let updated = 0;
  for (const [dirName, entry] of desired.skills) {
    const existing = current.get(dirName);
    if (!existing) {
      created += 1;
    } else if (existing.actualHash !== entry.contentHash) {
      updated += 1;
    }
  }
  if (desired.lessons) {
    const existing = current.get(desired.lessons.dirName);
    if (!existing) {
      created += 1;
    } else if (existing.actualHash !== desired.lessons.contentHash) {
      updated += 1;
    }
  }
  const staleDirs = [...current.keys()]
    .filter(
      (dirName) =>
        !desired.skills.has(dirName) &&
        !(desired.lessons && desired.lessons.dirName === dirName),
    )
    .sort();
  const removed = staleDirs.length;

  if (dryRun) {
    return {
      status: "ok",
      created,
      updated,
      removed,
      lessonsCount: desired.lessons ? desired.lessons.lessons.length : 0,
    };
  }

  ensureManagedRoot(profileHome, root);

  const stamp = Date.now();
  for (const dirName of staleDirs) {
    quarantineAndRemove(root, dirName, stamp);
  }
  for (const [dirName, entry] of desired.skills) {
    const existing = current.get(dirName);
    if (!existing) {
      createManagedDir(root, dirName, entry, stamp);
    } else if (existing.actualHash !== entry.contentHash) {
      writeManagedDir(root, dirName, entry);
    }
  }
  if (desired.lessons) {
    const existing = current.get(desired.lessons.dirName);
    if (!existing) {
      createLessonDir(root, desired.lessons, stamp);
    } else if (existing.actualHash !== desired.lessons.contentHash) {
      writeLessonDir(root, desired.lessons);
    }
  }
  writeManifest(root, desired);

  return {
    status: "ok",
    created,
    updated,
    removed,
    lessonsCount: desired.lessons ? desired.lessons.lessons.length : 0,
  };
}

function computeDesiredSkills(snapshot: DreamSnapshot): DesiredState {
  const skills = new Map<string, ManagedSkill>();
  const skillEntries = snapshot.skills.map((skill) => {
    const dirName = skillDirName(skill.key);
    const sourceKey = `skill:${skill.key}`;
    return {
      dirName,
      sourceKey,
      skill,
      contentHash: skillContentHash(skill, dirName),
    };
  });
  skillEntries.sort((a, b) => a.dirName.localeCompare(b.dirName));
  for (const entry of skillEntries) {
    skills.set(entry.dirName, entry);
  }
  let lessons: ManagedLessonAggregate | null = null;
  if (snapshot.lessons.length > 0) {
    const sorted = [...snapshot.lessons].sort(
      (a, b) => b.updatedAtMs - a.updatedAtMs || b.key.localeCompare(a.key),
    );
    const newest = sorted[0]!;
    lessons = {
      dirName: LESSONS_DIR,
      lessons: sorted,
      sourceMessageId: newest.sourceMessageId ?? null,
      updatedAtMs: newest.updatedAtMs,
      contentHash: lessonsContentHash(sorted),
    };
  }
  return { skills, lessons };
}

function ensureManagedRoot(profileHome: string, root: string): void {
  ensureRealDirectory(join(profileHome, "skills"));
  ensureRealDirectory(root);
}

/** mkdir (or accept EEXIST), then lstat and require a real directory. */
function ensureRealDirectory(dirPath: string): void {
  try {
    mkdirSync(dirPath, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  const stat = lstatSync(dirPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${dirPath} is a symlink — refusing to follow.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${dirPath} is not a directory.`);
  }
}

function quarantineAndRemove(
  root: string,
  dirName: string,
  stamp: number,
): void {
  const dirPath = join(root, dirName);
  const quarantinePath = join(
    root,
    `${QUARANTINE_PREFIX}${stamp}-${dirName}`,
  );
  renameSync(dirPath, quarantinePath);
  // Re-lstat both known files after the rename and require regular
  // non-symlink files before unlink — no recursive deletion.
  unlinkRegular(join(quarantinePath, "SKILL.md"));
  unlinkRegular(join(quarantinePath, MANAGED_JSON));
  rmdirSync(quarantinePath);
}

function unlinkRegular(filePath: string): void {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to unlink non-regular file: ${filePath}`);
  }
  unlinkSync(filePath);
}

function createManagedDir(
  root: string,
  dirName: string,
  entry: ManagedSkill,
  stamp: number,
): void {
  const tmpDir = join(root, `.tmp-${dirName}-${stamp}`);
  mkdirSync(tmpDir, { mode: 0o700 });
  try {
    writeSkillFiles(tmpDir, entry);
    renameSync(tmpDir, join(root, dirName));
  } catch (error) {
    try {
      rmdirSync(tmpDir);
    } catch {
      // preserve original error
    }
    throw error;
  }
}

function writeManagedDir(
  root: string,
  dirName: string,
  entry: ManagedSkill,
): void {
  writeSkillFiles(join(root, dirName), entry);
}

function writeSkillFiles(dirPath: string, entry: ManagedSkill): void {
  atomicWriteFile(
    join(dirPath, "SKILL.md"),
    renderSkillMd(entry.skill, entry.dirName),
  );
  atomicWriteFile(
    join(dirPath, MANAGED_JSON),
    markerJson(
      ownedMarker(
        entry.sourceKey,
        entry.skill.sourceMessageId ?? null,
        entry.skill.updatedAtMs,
        entry.contentHash,
      ),
    ),
  );
}

function createLessonDir(
  root: string,
  lessons: ManagedLessonAggregate,
  stamp: number,
): void {
  const tmpDir = join(root, `.tmp-${LESSONS_DIR}-${stamp}`);
  mkdirSync(tmpDir, { mode: 0o700 });
  try {
    writeLessonFiles(tmpDir, lessons);
    renameSync(tmpDir, join(root, LESSONS_DIR));
  } catch (error) {
    try {
      rmdirSync(tmpDir);
    } catch {
      // preserve original error
    }
    throw error;
  }
}

function writeLessonDir(
  root: string,
  lessons: ManagedLessonAggregate,
): void {
  writeLessonFiles(join(root, LESSONS_DIR), lessons);
}

function writeLessonFiles(
  dirPath: string,
  lessons: ManagedLessonAggregate,
): void {
  atomicWriteFile(
    join(dirPath, "SKILL.md"),
    renderLessonsSkillMd(lessons.lessons),
  );
  atomicWriteFile(
    join(dirPath, MANAGED_JSON),
    markerJson(
      ownedMarker(
        "lessons:aggregate",
        lessons.sourceMessageId,
        lessons.updatedAtMs,
        lessons.contentHash,
      ),
    ),
  );
}

function writeManifest(root: string, desired: DesiredState): void {
  const entries: Record<string, { sourceKey: string; contentHash: string }> =
    {};
  const dirNames = [...desired.skills.keys()];
  if (desired.lessons) dirNames.push(desired.lessons.dirName);
  dirNames.sort();
  for (const dirName of dirNames) {
    const skill = desired.skills.get(dirName);
    if (skill) {
      entries[dirName] = {
        sourceKey: skill.sourceKey,
        contentHash: skill.contentHash,
      };
    } else if (desired.lessons && desired.lessons.dirName === dirName) {
      entries[dirName] = {
        sourceKey: "lessons:aggregate",
        contentHash: desired.lessons.contentHash,
      };
    }
  }
  const manifest = { owner: MARKER_OWNER, version: MARKER_VERSION, entries };
  atomicWriteFile(
    join(root, MANIFEST_JSON),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function ownedMarker(
  sourceKey: string,
  sourceMessageId: number | null,
  updatedAtMs: number,
  contentHash: string,
): OwnedMarker {
  return {
    owner: MARKER_OWNER,
    version: MARKER_VERSION,
    sourceKey,
    sourceMessageId,
    updatedAtMs,
    contentHash,
  };
}

function markerJson(marker: OwnedMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  writeFileSync(tmpPath, content, { mode: 0o600, flag: "wx" });
  const fd = openSync(tmpPath, "r+");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmpPath, filePath);
}
