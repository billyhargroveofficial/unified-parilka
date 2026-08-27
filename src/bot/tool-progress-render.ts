import type { ToolCallStatus } from "./tool-progress.js";

const MAX_PROGRESS_LINE_LENGTH = 48;

export function renderProgressText(
  pending: ReadonlyMap<string, ToolCallStatus>,
  maxLength: number,
): string {
  const capacity = Math.max(1, Math.floor(maxLength));
  const lines: string[] = [];
  let used = 0;
  for (const status of groupedProgressStatuses(pending)) {
    const separatorLength = lines.length === 0 ? 0 : 1;
    const remaining = capacity - used - separatorLength;
    if (remaining <= 0) break;
    const preview = status.inputPreview ? ` · ${status.inputPreview}` : "";
    const quantity = status.toolId === "hosted_web" ? ` ×${String(status.batchSize ?? 1)}` : "";
    const line = truncateSingleLine(
      `${progressIcon(status)} ${status.toolName}${quantity}${preview}`,
      Math.min(MAX_PROGRESS_LINE_LENGTH, remaining),
    );
    lines.push(line);
    used += separatorLength + Array.from(line).length;
  }
  return lines.join("\n");
}

function groupedProgressStatuses(
  pending: ReadonlyMap<string, ToolCallStatus>,
): readonly ToolCallStatus[] {
  const rows: ToolCallStatus[] = [];
  const hosted = new Map<string, ToolCallStatus & { count: number; failed: boolean }>();
  for (const status of pending.values()) {
    if (status.kind !== "tool" || status.toolId !== "hosted_web") {
      rows.push(status);
      continue;
    }
    const existing = hosted.get(status.toolName);
    const count = displayBatchSize(status.batchSize) ?? 1;
    if (existing === undefined) {
      const grouped = { ...status, batchSize: count, count, failed: status.state === "error" };
      hosted.set(status.toolName, grouped);
      rows.push(grouped);
      continue;
    }
    const failed = existing.failed || status.state === "error";
    const state = status.state === "running"
      ? "running"
      : existing.state === "running" ? "running" : failed ? "error" : "ok";
    const grouped = {
      ...existing,
      batchSize: Math.min(existing.count + count, 99),
      count: existing.count + count,
      failed,
      state,
    } as const;
    hosted.set(status.toolName, grouped);
    rows[rows.indexOf(existing)] = grouped;
  }
  return rows;
}

function progressIcon(status: ToolCallStatus): string {
  if (status.kind === "thinking" && status.state === "running") return "🧠";
  if (status.state === "running") return "⏳";
  return status.state === "ok" ? "✓" : "✗";
}

function displayBatchSize(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return undefined;
  return Math.min(value, 99);
}

function truncateSingleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  const capacity = Math.max(1, Math.floor(maxLength));
  if (characters.length <= capacity) return normalized;
  if (capacity === 1) return "…";
  return `${characters.slice(0, capacity - 1).join("")}…`;
}
