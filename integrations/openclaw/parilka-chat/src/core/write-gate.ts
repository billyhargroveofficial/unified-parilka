import { isAllowedWriter } from "./session.js";
import {
  MANAGED_MEMORY_PREFIX,
  MANAGED_SKILL_MARKERS,
  WRITE_TOOL_NAMES,
  type PluginEnv,
} from "./types.js";

export const WRITE_DENIED = "parilka-chat: memory/skill write denied";
export const MANAGED_DENIED = "parilka-chat: managed memory/skill is read-only";

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStrings(nested, into);
    }
  }
}

export function touchesManagedTarget(params: unknown): boolean {
  const strings: string[] = [];
  collectStrings(params, strings);
  return strings.some((value) => {
    if (value.includes(MANAGED_MEMORY_PREFIX)) return true;
    return MANAGED_SKILL_MARKERS.some((marker) => value.includes(marker));
  });
}

export function isWriteTool(name: string): boolean {
  const lower = name.toLowerCase();
  if (WRITE_TOOL_NAMES.has(lower) || WRITE_TOOL_NAMES.has(name)) return true;
  return lower.startsWith("memory") && lower !== "memory_search" && lower !== "memory_get";
}

export function gateWriteTool(options: {
  name: string;
  params: unknown;
  env: PluginEnv;
  senderId?: string;
}): { block: true; reason: string } | { block: false } {
  if (!isWriteTool(options.name)) {
    return { block: false };
  }
  if (touchesManagedTarget(options.params)) {
    return { block: true, reason: MANAGED_DENIED };
  }
  if (!isAllowedWriter(options.env, options.senderId)) {
    return { block: true, reason: WRITE_DENIED };
  }
  return { block: false };
}
