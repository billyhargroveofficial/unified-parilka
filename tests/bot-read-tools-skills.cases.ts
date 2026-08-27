import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotReadTools,
  MAX_LOAD_CHAT_SKILL_OUTPUT_CHARS,
} from "../src/bot/read-tools.js";
import { MessageStore } from "../src/store.js";
import { CHAT, emptyCache } from "./support/bot-read-tools.js";

test("load_chat_skill is a bounded causal same-chat read and preserves a full playbook", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  const instructions = '"\\'.repeat(2_000);
  store.upsertChatSkill({
    chatId: CHAT.chatId,
    name: "Research playbook",
    description: "Search, verify, then cite.",
    instructions,
    sourceMessageId: 77,
  });
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    skillStore: store,
  });

  const visible = await tools.callTool(
    "load_chat_skill",
    { name: "Research playbook" },
    { sourceMessageId: 78 },
  );
  assert.equal(visible.ok, true);
  if (!visible.ok) return;
  assert.equal(visible.status, "done");
  assert.deepEqual(visible.evidence, []);
  assert.equal(visible.result.instructions, instructions);
  assert.equal(visible.result.projection, undefined);
  assert.ok(JSON.stringify(visible).length <= MAX_LOAD_CHAT_SKILL_OUTPUT_CHARS);

  for (const sourceMessageId of [undefined, 77]) {
    const result = await tools.callTool(
      "load_chat_skill",
      { name: "Research playbook" },
      ...(sourceMessageId === undefined ? [] : [{ sourceMessageId }]),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, "empty");
      assert.deepEqual(result.result, { name: "Research playbook", found: false });
    }
  }
});

test("load_chat_skill fails closed when a skill store returns a cross-chat record", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    skillStore: {
      getChatSkill() {
        return {
          chatId: "-100other",
          key: "research",
          name: "Research",
          description: "private",
          instructions: "private",
          sourceMessageId: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
        };
      },
    },
  });
  const result = await tools.callTool(
    "load_chat_skill",
    { name: "Research" },
    { sourceMessageId: 2 },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, "empty");
    assert.deepEqual(result.result, { name: "Research", found: false });
  }
});
