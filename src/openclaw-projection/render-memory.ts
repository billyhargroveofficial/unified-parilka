import { createHash } from "node:crypto";
import type {
  DreamSnapshot,
  MemoryAssembledContent,
  MemoryRenderPlan,
} from "./types.js";

export const MEMORY_ENTRY_DELIMITER = "\n§\n";
export const MANAGED_SEMANTIC_PREFIX = "[parilka:managed:v1:semantic]";
export const MANAGED_FAST_PREFIX = "[parilka:managed:v1:fast:";

/** Python-style Unicode codepoint length, not UTF-16 units or bytes. */
export function codepointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Codepoint ranges stripped by Python str.strip (str.isspace members), in
 * contrast to JS trim which also removes U+FEFF and misses U+001C..U+001F.
 */
const PYTHON_STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0009, 0x000d],
  [0x001c, 0x0020],
  [0x0085, 0x0085],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];

function isPythonStripCodepoint(code: number): boolean {
  return PYTHON_STRIP_RANGES.some(
    ([start, end]) => code >= start && code <= end,
  );
}

/** Exact replica of Python str.strip: strips only the Python whitespace set. */
export function pythonStrip(value: string): string {
  const codepoints = Array.from(value);
  let start = 0;
  let end = codepoints.length;
  while (
    start < end &&
    isPythonStripCodepoint(codepoints[start]!.codePointAt(0)!)
  ) {
    start += 1;
  }
  while (
    end > start &&
    isPythonStripCodepoint(codepoints[end - 1]!.codePointAt(0)!)
  ) {
    end -= 1;
  }
  return codepoints.slice(start, end).join("");
}

/**
 * Split MEMORY.md by the entry delimiter, strip whitespace from each
 * entry, drop empty entries.
 */
export function parseMemoryEntries(raw: string): string[] {
  return raw
    .split(MEMORY_ENTRY_DELIMITER)
    .map((entry) => pythonStrip(entry))
    .filter((entry) => entry.length > 0);
}

export function joinMemoryEntries(entries: string[]): string {
  return entries.join(MEMORY_ENTRY_DELIMITER);
}

function isManagedEntry(entry: string): boolean {
  return (
    entry.startsWith(MANAGED_SEMANTIC_PREFIX) ||
    entry.startsWith(MANAGED_FAST_PREFIX)
  );
}

/**
 * Drift detection: the raw content must roundtrip through the entry parse,
 * and no single entry may exceed the full memory_char_limit in codepoints.
 * Returns a reason string when the memory phase must abort.
 */
export function detectMemoryDrift(
  raw: string | undefined,
  charLimit: number,
): string | undefined {
  if (raw === undefined) return undefined;
  const entries = parseMemoryEntries(raw);
  if (pythonStrip(raw) !== joinMemoryEntries(entries)) {
    return "MEMORY.md content does not roundtrip through the entry parser.";
  }
  for (const entry of entries) {
    const length = codepointLength(entry);
    if (length > charLimit) {
      return `A MEMORY.md entry exceeds memory_char_limit (${length} > ${charLimit} codepoints).`;
    }
  }
  return undefined;
}

/**
 * Render the memory plan: owner entries first (their order preserved),
 * then the managed semantic entry, then managed fast entries newest-first.
 */
export function planMemoryRender(
  snapshot: DreamSnapshot,
  existingRaw: string | undefined,
): MemoryRenderPlan {
  const ownerEntries = (existingRaw ? parseMemoryEntries(existingRaw) : []).filter(
    (entry) => !isManagedEntry(entry),
  );
  const semanticEntry = renderSemanticEntry(snapshot);
  const fastEntries = [...snapshot.fastMemory]
    .sort(
      (a, b) => b.updatedAtMs - a.updatedAtMs || b.key.localeCompare(a.key),
    )
    .map(renderFastEntry);
  return {
    ownerEntries,
    semanticEntry,
    fastEntries,
    ownerChars: codepointLength(joinMemoryEntries(ownerEntries)),
    managedChars: codepointLength(
      joinMemoryEntries([semanticEntry, ...fastEntries].filter(Boolean)),
    ),
    combinedChars: codepointLength(
      joinMemoryEntries(
        [...ownerEntries, semanticEntry, ...fastEntries].filter(Boolean),
      ),
    ),
  };
}

/**
 * Build the final MEMORY.md content: owner entries first, then the managed
 * semantic entry, then the maximal newest-first prefix of fast entries that
 * still fits the limit. Returns undefined when owner + semantic do not fit.
 */
export function assembleMemoryContent(
  plan: MemoryRenderPlan,
  charLimit: number,
): MemoryAssembledContent | undefined {
  const parts: string[] = [...plan.ownerEntries];
  if (
    parts.length > 0 &&
    codepointLength(joinMemoryEntries(parts)) > charLimit
  ) {
    return undefined;
  }
  let managedEntries = 0;
  if (plan.semanticEntry) {
    parts.push(plan.semanticEntry);
    if (codepointLength(joinMemoryEntries(parts)) > charLimit) {
      return undefined;
    }
    managedEntries += 1;
  }
  for (const fastEntry of plan.fastEntries) {
    parts.push(fastEntry);
    if (codepointLength(joinMemoryEntries(parts)) > charLimit) {
      parts.pop();
      break;
    }
    managedEntries += 1;
  }
  return { content: joinMemoryEntries(parts), managedEntries };
}

/** Total managed entries in the plan (semantic + all fast). */
export function countManagedEntries(plan: MemoryRenderPlan): number {
  return (plan.semanticEntry ? 1 : 0) + plan.fastEntries.length;
}

function renderSemanticEntry(snapshot: DreamSnapshot): string {
  if (!snapshot.memory || !pythonStrip(snapshot.memory.memoryText)) return "";
  const provenance = `rev:${snapshot.memory.revision} msg:${snapshot.memory.lastConsolidatedMessageId ?? "none"}`;
  return pythonStrip(
    `${MANAGED_SEMANTIC_PREFIX} ${provenance}\n${snapshot.memory.memoryText}`,
  );
}

function renderFastEntry(entry: {
  key: string;
  title: string;
  note: string;
  updatedAtMs: number;
  sourceMessageId?: number;
}): string {
  const hash = stableFastHash(entry);
  const provenance = `msg:${entry.sourceMessageId ?? "none"}`;
  return pythonStrip(
    `${MANAGED_FAST_PREFIX}${hash}] ${provenance}\n${entry.title}: ${entry.note}`,
  );
}

function stableFastHash(entry: {
  key: string;
  title: string;
  note: string;
  updatedAtMs: number;
  sourceMessageId?: number;
}): string {
  const hash = createHash("sha256");
  hash.update(`k:${entry.key}\n`);
  hash.update(`t:${entry.title}\n`);
  hash.update(`n:${entry.note}\n`);
  hash.update(`u:${entry.updatedAtMs}\n`);
  if (entry.sourceMessageId !== undefined) {
    hash.update(`s:${entry.sourceMessageId}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}
