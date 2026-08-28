#!/usr/bin/env tsx
/**
 * Deterministic exporter: reads BOT_READ_TOOL_DEFINITIONS, strips `chat`
 * and `source_message_id` from each schema, and writes the five cache-only
 * tools to `integrations/hermes/tool-schemas.json`.
 *
 * The output is a checked-in artifact. A drift test compares it against the
 * live TS definitions.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOT_READ_TOOL_DEFINITIONS,
} from "../src/bot/read-tools.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const CACHE_TOOL_NAMES = new Set([
  "rag_bm25_search",
  "keyword_search",
  "read_chat_slice",
  "day_digest",
  "thread_context",
]);

const EXCLUDED_PROPERTIES = new Set(["chat", "source_message_id"]);

interface ToolSchemaEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const entries: ToolSchemaEntry[] = [];

for (const def of BOT_READ_TOOL_DEFINITIONS) {
  if (!CACHE_TOOL_NAMES.has(def.name)) continue;

  const schema = structuredClone(def.inputSchema) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (!EXCLUDED_PROPERTIES.has(key)) {
      filtered[key] = value;
    }
  }

  const required = (schema.required as string[] | undefined) ?? [];
  const filteredRequired = required.filter(
    (r) => !EXCLUDED_PROPERTIES.has(r),
  );

  entries.push({
    name: def.name,
    description: def.description,
    parameters: {
      type: "object",
      properties: filtered,
      required: filteredRequired.length > 0 ? filteredRequired : undefined,
      additionalProperties: false,
    },
  });
}

// Sort for deterministic output
entries.sort((a, b) => a.name.localeCompare(b.name));

const outPath = path.join(
  REPO_ROOT,
  "integrations",
  "hermes",
  "tool-schemas.json",
);
writeFileSync(outPath, JSON.stringify(entries, null, 2) + "\n", "utf-8");
console.error(`Wrote ${entries.length} tool schemas to ${outPath}`);
