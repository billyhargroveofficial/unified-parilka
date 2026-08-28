/**
 * Drift test: verifies that the checked-in tool-schemas.json artifact matches
 * the live BOT_READ_TOOL_DEFINITIONS.
 *
 * If this test fails, run:
 *   npx tsx scripts/export-hermes-tool-schemas.ts
 * to regenerate the artifact.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
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

test("checked-in tool-schemas.json matches BOT_READ_TOOL_DEFINITIONS", () => {
  const artifactPath = path.join(
    REPO_ROOT,
    "integrations",
    "hermes",
    "tool-schemas.json",
  );
  let raw: string;
  try {
    raw = readFileSync(artifactPath, "utf-8");
  } catch {
    assert.fail(`tool-schemas.json not found at ${artifactPath}`);
  }
  const artifact = JSON.parse(raw) as ToolSchemaEntry[];
  assert.ok(Array.isArray(artifact), "artifact must be a JSON array");

  // Build expected entries from live TS definitions
  const expected: ToolSchemaEntry[] = [];
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

    expected.push({
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
  expected.sort((a, b) => a.name.localeCompare(b.name));

  assert.equal(artifact.length, expected.length, "tool count mismatch");
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]!;
    const act = artifact[i]!;
    assert.equal(act.name, exp.name, `name mismatch at index ${i}`);
    assert.equal(
      act.description,
      exp.description,
      `description mismatch for ${exp.name}`,
    );
    assert.deepEqual(
      act.parameters,
      exp.parameters,
      `parameters mismatch for ${exp.name}`,
    );
  }
});

test("tool-schemas.json contains exactly five entries sorted alphabetically", () => {
  const artifactPath = path.join(
    REPO_ROOT,
    "integrations",
    "hermes",
    "tool-schemas.json",
  );
  const raw = readFileSync(artifactPath, "utf-8");
  const artifact = JSON.parse(raw) as ToolSchemaEntry[];

  const names = artifact.map((e) => e.name);
  assert.deepEqual(names, [
    "day_digest",
    "keyword_search",
    "rag_bm25_search",
    "read_chat_slice",
    "thread_context",
  ]);
});

test("tool-schemas.json entries have no chat or source_message_id fields", () => {
  const artifactPath = path.join(
    REPO_ROOT,
    "integrations",
    "hermes",
    "tool-schemas.json",
  );
  const raw = readFileSync(artifactPath, "utf-8");
  const artifact = JSON.parse(raw) as ToolSchemaEntry[];

  for (const entry of artifact) {
    const props = entry.parameters.properties as Record<string, unknown>;
    assert.ok(!("chat" in props), `${entry.name} must not expose chat`);
    assert.ok(
      !("source_message_id" in props),
      `${entry.name} must not expose source_message_id`,
    );
  }
});

test("tool-schemas.json entries match plugin tool set", () => {
  const artifactPath = path.join(
    REPO_ROOT,
    "integrations",
    "hermes",
    "tool-schemas.json",
  );
  const raw = readFileSync(artifactPath, "utf-8");
  const artifact = JSON.parse(raw) as ToolSchemaEntry[];

  const expectedNames = new Set([
    "rag_bm25_search",
    "keyword_search",
    "read_chat_slice",
    "day_digest",
    "thread_context",
  ]);
  const actualNames = new Set(artifact.map((e) => e.name));
  assert.deepEqual(actualNames, expectedNames);

  for (const entry of artifact) {
    assert.ok(
      typeof entry.description === "string" && entry.description.length > 10,
      `${entry.name} must have a non-trivial description`,
    );
    assert.equal(
      entry.parameters.type,
      "object",
      `${entry.name} parameters.type must be "object"`,
    );
    assert.equal(
      entry.parameters.additionalProperties,
      false,
      `${entry.name} parameters.additionalProperties must be false`,
    );
  }
});
