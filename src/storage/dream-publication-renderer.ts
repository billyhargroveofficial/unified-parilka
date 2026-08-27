import { createHash } from "node:crypto";
import type { EnqueueDreamPublicationInput } from "./dream-publications.js";
import type {
  AuditLayerDelta,
  DreamAudit,
} from "./dream-audit-types.js";

const PUBLICATION_VERSION = 1;
const MAX_VISIBLE_NAMES_PER_ACTION = 2;
const MAX_VISIBLE_NAME_CHARS = 48;
const MAX_PUBLICATION_CHARS = 1_800;

/**
 * Builds a deterministic, content-minimal public changelog from the exact
 * audit committed with a Dream day. Notes, descriptions, instructions and
 * semantic-memory text never cross this boundary; only bounded record names
 * and operation counts are visible to the chat.
 */
export function renderDreamAuditPublication(
  audit: DreamAudit,
  nowMs: number,
): EnqueueDreamPublicationInput | undefined {
  const lines = [`🌙 Dream digest · ${audit.day}`];
  if (semanticTextChanged(audit)) {
    lines.push("Memory: updated");
  }
  appendLayer(lines, "Skills", audit.skills, (item) => item.name);
  appendLayer(lines, "Lessons", audit.lessons, (item) => item.title);
  appendLayer(lines, "Notes", audit.fastMemory, (item) => item.title);
  if (lines.length === 1) return undefined;

  // Publication is observability, never part of the memory transaction's
  // correctness. Keep a final deterministic fence so a future larger audit
  // shape cannot make an otherwise valid Dream commit fail.
  const plainText = boundedPublicationText(lines.join("\n"));
  const identityHash = sha256(
    `${String(PUBLICATION_VERSION)}\0${audit.chatId}\0${audit.day}`,
  );
  const payloadHash = sha256(`${plainText}\0${plainText}`);
  return {
    id: `dream-${identityHash}`,
    dedupeKey: `dream-audit:v${String(PUBLICATION_VERSION)}:${identityHash}`,
    payloadHash,
    chatId: audit.chatId,
    markdown: plainText,
    plainText,
    nowMs,
  };
}

function semanticTextChanged(audit: DreamAudit): boolean {
  return (audit.semanticMemory.before?.memoryText ?? "") !==
    (audit.semanticMemory.after?.memoryText ?? "");
}

function appendLayer<T>(
  lines: string[],
  label: string,
  delta: AuditLayerDelta<T>,
  nameOf: (item: T) => string,
): void {
  const actions = [
    renderAction("+", delta.created, nameOf),
    renderAction("~", delta.updated.map((item) => item.after), nameOf),
    renderAction("−", delta.deleted, nameOf),
    renderAction("evicted", delta.evicted, nameOf),
  ].filter((item): item is string => item !== undefined);
  if (actions.length > 0) {
    lines.push(`${label}: ${actions.join(" · ")}`);
  }
}

function renderAction<T>(
  marker: string,
  items: readonly T[],
  nameOf: (item: T) => string,
): string | undefined {
  if (items.length === 0) return undefined;
  const visible = items
    .slice(0, MAX_VISIBLE_NAMES_PER_ACTION)
    .map((item) => boundedSingleLine(nameOf(item)));
  const omitted = items.length - visible.length;
  return `${marker}${visible.join(", ")}${omitted > 0 ? ` (+${String(omitted)})` : ""}`;
}

function boundedSingleLine(value: string): string {
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(normalized || "unnamed");
  if (characters.length <= MAX_VISIBLE_NAME_CHARS) return characters.join("");
  return `${characters.slice(0, MAX_VISIBLE_NAME_CHARS - 1).join("")}…`;
}

function boundedPublicationText(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_PUBLICATION_CHARS) return value;
  return `${characters.slice(0, MAX_PUBLICATION_CHARS - 1).join("")}…`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
