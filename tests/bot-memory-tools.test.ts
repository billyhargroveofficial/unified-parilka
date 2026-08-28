import assert from "node:assert/strict";
import { test } from "node:test";
import { BotMemoryTools } from "../src/bot/memory-tools.js";
import { MessageStore } from "../src/store.js";

const CHAT_ID = "-1003179772905";
const PRIMARY_AUTHORIZER_ID = "42";
const SECONDARY_AUTHORIZER_ID = "84";
const UNAUTHORIZED_SENDER_ID = "43";

function withTools(run: (tools: BotMemoryTools, store: MessageStore) => void): void {
  const store = new MessageStore(":memory:");
  try {
    run(
      new BotMemoryTools({
        store,
        writeAuthorizerIds: [PRIMARY_AUTHORIZER_ID, SECONDARY_AUTHORIZER_ID],
      }),
      store,
    );
  } finally {
    store.close();
  }
}

const writable = {
  chatId: CHAT_ID,
  sourceMessageId: 77,
  senderId: PRIMARY_AUTHORIZER_ID,
  allowWrite: true,
} as const;

test("write tools require both the direct-write gate and an authorized sender", () => {
  withTools((tools, store) => {
    const denied = tools.callTool(
      "remember_fast",
      { title: "deploy", note: "run the smoke" },
      { ...writable, allowWrite: false },
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.error.code, "write_not_authorized");
    }
    assert.equal(store.listFastChatMemory(CHAT_ID).length, 0);

    const impersonated = tools.callTool(
      "remember_fast",
      { title: "deploy", note: "run the smoke" },
      {
        ...writable,
        senderId: UNAUTHORIZED_SENDER_ID,
      },
    );
    assert.equal(impersonated.ok, false);
    if (!impersonated.ok) {
      assert.equal(impersonated.error.code, "write_not_authorized");
    }
    assert.equal(store.listFastChatMemory(CHAT_ID).length, 0);
  });
});

test("memory tools save source-attributed knowledge and progressively load it", () => {
  withTools((tools) => {
    const fast = tools.callTool(
      "remember_fast",
      { title: "deploy", note: "run full gates before restart" },
      writable,
    );
    assert.equal(fast.ok, true);

    const secondary = tools.callTool(
      "remember_fast",
      { title: "secondary", note: "also authorized" },
      {
        ...writable,
        senderId: SECONDARY_AUTHORIZER_ID,
      },
    );
    assert.equal(secondary.ok, true);

    const lesson = tools.callTool(
      "remember_lesson",
      {
        title: "Qwen timeout",
        problem: "A fixed short step limit killed a slow second answer.",
        solution: "Use the whole-turn deadline instead of a short step ceiling.",
        when_to_apply: "When a provider can take longer after tool output.",
      },
      writable,
    );
    assert.equal(lesson.ok, true);

    const searched = tools.callTool(
      "search_long_memory",
      { query: "step ceiling" },
      { ...writable, allowWrite: false },
    );
    assert.equal(searched.ok, true);
    if (searched.ok) {
      assert.equal(searched.status, "done");
      assert.match(JSON.stringify(searched.result), /Qwen timeout/u);
      assert.match(JSON.stringify(searched.result), /sourceMessageId":77/u);
    }

    const savedSkill = tools.callTool(
      "save_chat_skill",
      {
        name: "Release",
        description: "Safe bot release workflow.",
        instructions: "Run focused tests, full gates, then inspect startup logs.",
      },
      writable,
    );
    assert.equal(savedSkill.ok, true);

    const loaded = tools.callTool(
      "load_chat_skill",
      { name: "release" },
      { ...writable, allowWrite: false },
    );
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.status, "done");
      assert.match(JSON.stringify(loaded.result), /focused tests/u);
    }
  });
});

test("memory tool errors are typed and never echo rejected secret text", () => {
  withTools((tools) => {
    const result = tools.callTool(
      "remember_fast",
      { title: "credential", note: "sk-abcdefghijklmnopqrstuv" },
      writable,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "storage_error");
      assert.doesNotMatch(JSON.stringify(result), /sk-abcdefghijkl/u);
    }
  });
});

test("progressive skill output stays inside its hard model-output budget", () => {
  withTools((tools) => {
    const saved = tools.callTool(
      "save_chat_skill",
      {
        name: "Long playbook",
        description: "A deliberately large bounded fixture.",
        instructions: "x".repeat(4_000),
      },
      writable,
    );
    assert.equal(saved.ok, true);

    const loaded = tools.callTool(
      "load_chat_skill",
      { name: "long playbook" },
      { ...writable, allowWrite: false },
    );
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.ok(JSON.stringify(loaded.result).length <= 4_000);
      assert.deepEqual(loaded.result.projection, {
        truncated: true,
        maxCharacters: 4_000,
      });
    }
  });
});
