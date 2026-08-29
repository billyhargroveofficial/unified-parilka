import assert from "node:assert/strict";
import test from "node:test";
import { BOT_READ_TOOL_DEFINITIONS } from "../src/bot/read-tools.js";
import {
  CACHE_TOOL_NAMES,
  TOOL_SCHEMA_LIST,
} from "../integrations/openclaw/parilka-chat/src/core/index.js";

const EXCLUDED = new Set(["chat", "source_message_id"]);

test("plugin cache schemas match BOT_READ_TOOL_DEFINITIONS minus trust fields", () => {
  const expected = BOT_READ_TOOL_DEFINITIONS
    .filter((def) => (CACHE_TOOL_NAMES as readonly string[]).includes(def.name))
    .map((def) => {
      const schema = structuredClone(def.inputSchema) as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        if (!EXCLUDED.has(key)) filtered[key] = value;
      }
      const required = ((schema.required as string[] | undefined) ?? []).filter(
        (name) => !EXCLUDED.has(name),
      );
      return {
        name: def.name,
        description: def.description,
        parameters: {
          type: "object",
          properties: filtered,
          required,
          additionalProperties: false,
        },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const actual = [...TOOL_SCHEMA_LIST].sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(actual.length, 5);
  assert.deepEqual(
    actual.map((item) => item.name),
    expected.map((item) => item.name),
  );
  for (const exp of expected) {
    const act = actual.find((item) => item.name === exp.name);
    assert.ok(act, exp.name);
    assert.equal(act!.description, exp.description, exp.name);
    assert.deepEqual(act!.parameters, exp.parameters, exp.name);
    assert.ok(!("chat" in act!.parameters.properties));
    assert.ok(!("source_message_id" in act!.parameters.properties));
  }
});
