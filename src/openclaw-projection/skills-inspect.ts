import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MANAGED_JSON = ".parilka-managed.json";
export const MANIFEST_JSON = ".manifest.json";
export const QUARANTINE_PREFIX = ".quarantine-";
export const MARKER_OWNER = "parilka-unified";
export const MARKER_VERSION = 1;
const KNOWN_DIR_FILES = new Set(["SKILL.md", MANAGED_JSON]);

export interface OwnedMarker {
  owner: string;
  version: number;
  sourceKey: string;
  sourceMessageId: number | null;
  updatedAtMs: number;
  contentHash: string;
}

export interface CurrentManagedDir {
  dirName: string;
  marker: OwnedMarker;
  actualHash: string;
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Inspect the managed root without following symlinks. Every marker-owned
 * directory is recorded with the hash of its actual SKILL.md bytes; any
 * invalid marker, symlink, quarantine leftover, or unexpected file pushes a
 * conflict.
 */
export function inspectManagedRoot(
  profileHome: string,
  root: string,
  conflicts: string[],
): { rootEntries: Set<string>; current: Map<string, CurrentManagedDir> } {
  const rootEntries = new Set<string>();
  const current = new Map<string, CurrentManagedDir>();

  const skillsPath = join(profileHome, "skills");
  let skillsStat;
  try {
    skillsStat = lstatSync(skillsPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { rootEntries, current };
    throw error;
  }
  if (skillsStat.isSymbolicLink()) {
    conflicts.push("skills: path is a symlink");
    return { rootEntries, current };
  }
  if (!skillsStat.isDirectory()) {
    conflicts.push("skills: path is not a directory");
    return { rootEntries, current };
  }

  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { rootEntries, current };
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    conflicts.push("parilka-managed: managed root is a symlink");
    return { rootEntries, current };
  }
  if (!rootStat.isDirectory()) {
    conflicts.push("parilka-managed: managed root is not a directory");
    return { rootEntries, current };
  }

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    conflicts.push("parilka-managed: cannot list managed root");
    return { rootEntries, current };
  }

  for (const name of names) {
    if (name.startsWith(QUARANTINE_PREFIX)) {
      conflicts.push(`${name}: unexpected quarantine leftover`);
      continue;
    }
    rootEntries.add(name);
    if (name === MANIFEST_JSON) continue;
    const dirPath = join(root, name);
    let stat;
    try {
      stat = lstatSync(dirPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      conflicts.push(`${name}: symlink inside managed root`);
      continue;
    }
    if (!stat.isDirectory()) {
      conflicts.push(`${name}: unexpected non-directory inside managed root`);
      continue;
    }
    const marker = readMarker(dirPath, name, conflicts);
    if (!marker) continue;
    const actualHash = readSkillHash(dirPath, name, conflicts);
    if (actualHash === undefined) continue;
    readUnexpectedFiles(dirPath, name, conflicts);
    current.set(name, { dirName: name, marker, actualHash });
  }
  return { rootEntries, current };
}

function readMarker(
  dirPath: string,
  dirName: string,
  conflicts: string[],
): OwnedMarker | undefined {
  const markerPath = join(dirPath, MANAGED_JSON);
  let stat;
  try {
    stat = lstatSync(markerPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      conflicts.push(`${dirName}: missing owned marker`);
      return undefined;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    conflicts.push(`${dirName}: marker is a symlink`);
    return undefined;
  }
  if (!stat.isFile()) {
    conflicts.push(`${dirName}: marker is not a regular file`);
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf-8");
  } catch {
    conflicts.push(`${dirName}: cannot read marker`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    conflicts.push(`${dirName}: marker is not valid JSON`);
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    conflicts.push(`${dirName}: marker is not a valid owned marker`);
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "contentHash",
    "owner",
    "sourceKey",
    "sourceMessageId",
    "updatedAtMs",
    "version",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    conflicts.push(`${dirName}: marker is not a valid owned marker`);
    return undefined;
  }
  const owner = record.owner;
  const version = record.version;
  const sourceKey = record.sourceKey;
  const sourceMessageId = record.sourceMessageId;
  const updatedAtMs = record.updatedAtMs;
  const contentHash = record.contentHash;
  const validSourceMessageId =
    sourceMessageId === null ||
    (typeof sourceMessageId === "number" &&
      Number.isSafeInteger(sourceMessageId));
  if (
    owner !== MARKER_OWNER ||
    version !== MARKER_VERSION ||
    typeof sourceKey !== "string" ||
    !validSourceMessageId ||
    typeof updatedAtMs !== "number" ||
    !Number.isSafeInteger(updatedAtMs) ||
    updatedAtMs < 0 ||
    !isContentHash(contentHash)
  ) {
    conflicts.push(`${dirName}: marker is not a valid owned marker`);
    return undefined;
  }
  return {
    owner: MARKER_OWNER,
    version: MARKER_VERSION,
    sourceKey,
    sourceMessageId,
    updatedAtMs,
    contentHash,
  };
}

function readSkillHash(
  dirPath: string,
  dirName: string,
  conflicts: string[],
): string | undefined {
  const skillPath = join(dirPath, "SKILL.md");
  let stat;
  try {
    stat = lstatSync(skillPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      conflicts.push(`${dirName}: SKILL.md missing`);
      return undefined;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    conflicts.push(`${dirName}: SKILL.md is a symlink`);
    return undefined;
  }
  if (!stat.isFile()) {
    conflicts.push(`${dirName}: SKILL.md is not a regular file`);
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(skillPath, "utf-8");
  } catch {
    conflicts.push(`${dirName}: cannot read SKILL.md`);
    return undefined;
  }
  return createSha256Hex(raw);
}

function readUnexpectedFiles(
  dirPath: string,
  dirName: string,
  conflicts: string[],
): void {
  let names: string[];
  try {
    names = readdirSync(dirPath);
  } catch {
    conflicts.push(`${dirName}: cannot list directory`);
    return;
  }
  for (const name of names) {
    if (KNOWN_DIR_FILES.has(name)) continue;
    conflicts.push(`${dirName}: unexpected file ${name}`);
    let stat;
    try {
      stat = lstatSync(join(dirPath, name));
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      conflicts.push(`${dirName}: symlink ${name} inside managed dir`);
    }
  }
}

/**
 * Validate .manifest.json against the marker-owned directories on disk.
 * The manifest must have exact keys (owner, version, entries), each entry
 * exact keys (sourceKey, contentHash), and a 64-lowercase-hex contentHash.
 * A missing manifest is allowed only for a new or empty managed root.
 */
export function validateManifest(
  root: string,
  rootEntries: Set<string>,
  current: Map<string, CurrentManagedDir>,
  conflicts: string[],
): void {
  if (!rootEntries.has(MANIFEST_JSON)) {
    if (current.size > 0) {
      conflicts.push(
        `${MANIFEST_JSON}: missing manifest with managed directories on disk`,
      );
    }
    return;
  }
  const manifestPath = join(root, MANIFEST_JSON);
  let stat;
  try {
    stat = lstatSync(manifestPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    conflicts.push(`${MANIFEST_JSON}: symlink`);
    return;
  }
  if (!stat.isFile()) {
    conflicts.push(`${MANIFEST_JSON}: not a regular file`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    conflicts.push(`${MANIFEST_JSON}: invalid JSON`);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    conflicts.push(`${MANIFEST_JSON}: invalid or unowned manifest`);
    return;
  }
  const manifest = parsed as Record<string, unknown>;
  const manifestKeys = Object.keys(manifest).sort();
  const expectedManifestKeys = ["entries", "owner", "version"];
  if (
    manifestKeys.length !== expectedManifestKeys.length ||
    manifestKeys.some((key, index) => key !== expectedManifestKeys[index])
  ) {
    conflicts.push(`${MANIFEST_JSON}: invalid or unowned manifest`);
    return;
  }
  if (manifest.owner !== MARKER_OWNER || manifest.version !== MARKER_VERSION) {
    conflicts.push(`${MANIFEST_JSON}: invalid or unowned manifest`);
    return;
  }
  const entries = manifest.entries;
  if (
    typeof entries !== "object" ||
    entries === null ||
    Array.isArray(entries)
  ) {
    conflicts.push(`${MANIFEST_JSON}: invalid or unowned manifest`);
    return;
  }
  const entryRecords = entries as Record<string, unknown>;
  const names = Object.keys(entryRecords);
  const diskNames = [...current.keys()];
  if (
    names.length !== diskNames.length ||
    names.some((name) => !current.has(name))
  ) {
    conflicts.push(
      `${MANIFEST_JSON}: does not match managed directories on disk`,
    );
    return;
  }
  for (const name of names) {
    const entry = entryRecords[name];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      conflicts.push(`${MANIFEST_JSON}: drift from disk state for ${name}`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const entryKeys = Object.keys(record).sort();
    const expectedEntryKeys = ["contentHash", "sourceKey"];
    const dir = current.get(name)!;
    if (
      entryKeys.length !== expectedEntryKeys.length ||
      entryKeys.some((key, index) => key !== expectedEntryKeys[index]) ||
      record.sourceKey !== dir.marker.sourceKey ||
      !isContentHash(record.contentHash) ||
      record.contentHash !== dir.actualHash
    ) {
      conflicts.push(`${MANIFEST_JSON}: drift from disk state for ${name}`);
      return;
    }
  }
}

function isContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function createSha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
