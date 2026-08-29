import assert from "node:assert/strict";
import test from "node:test";
import {
  INVALID_ARGS,
  PROTOCOL_ERROR,
  SESSION_REJECTED,
  SourceMessageLedger,
  chatIdFromSessionKey,
  appendFooter,
  compactTokens,
  dispatchCacheTool,
  formatElapsed,
  gateWriteTool,
  hasLiteralBotMention,
  loadPluginEnv,
  normalizeChatId,
  parseLoopbackMcpUrl,
  parseTelegramMessageId,
  renderFooter,
  type PluginEnv,
} from "../integrations/openclaw/parilka-chat/src/core/index.js";

const env: PluginEnv = {
  chatId: "-1003179772905",
  agentId: "parilka",
  writeSenderIds: new Set(["111"]),
  mcpUrl: "http://127.0.0.1:8766/mcp",
};

function seededLedger(messageId = 42): SourceMessageLedger {
  const ledger = new SourceMessageLedger();
  ledger.capture({
    agentId: "parilka",
    channel: "telegram",
    chatId: "-1003179772905",
    senderId: "111",
    messageId,
    sessionKey: "s1",
    runId: "r1",
  });
  return ledger;
}

test("loadPluginEnv requires chat id and parses writer allowlist", () => {
  assert.throws(() => loadPluginEnv({}), /PARILKA_TELEGRAM_CHAT_ID/);
  const loaded = loadPluginEnv({
    PARILKA_TELEGRAM_CHAT_ID: "-1003179772905",
    PARILKA_BOT_MEMORY_WRITE_SENDER_IDS: "tg:111, 222",
  });
  assert.equal(loaded.chatId, "-1003179772905");
  assert.equal(normalizeChatId("telegram:-1003179772905"), "-1003179772905");
  assert.equal(loaded.agentId, "parilka");
  assert.deepEqual([...loaded.writeSenderIds], ["111", "222"]);
});

test("loopback MCP URL parser rejects remote and credentialed values", () => {
  assert.equal(
    parseLoopbackMcpUrl("http://127.0.0.1:8766/mcp").href,
    "http://127.0.0.1:8766/mcp",
  );
  for (const value of [
    "https://127.0.0.1:8766/mcp",
    "http://localhost:8766/mcp",
    "http://user:secret@127.0.0.1:8766/mcp",
    "http://127.0.0.1:8766/other",
    "http://127.0.0.1:8766/mcp?token=x",
  ]) {
    assert.throws(() => parseLoopbackMcpUrl(value), /PARILKA_MCP_HTTP_URL/, value);
  }
});

test("dispatch injects source_message_id and rejects forged extra keys", async () => {
  const seen: Record<string, unknown>[] = [];
  const ledger = seededLedger(99);
  const ok = await dispatchCacheTool({
    name: "rag_bm25_search",
    args: { query: "hello" },
    env,
    ledger,
    sessionKey: "s1",
    runId: "r1",
    mcp: {
      async callTool(_name, args) {
        seen.push(args);
        return { ok: true, tool: "rag_bm25_search", evidence: [] };
      },
    },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen[0], { query: "hello", source_message_id: 99 });

  const forged = await dispatchCacheTool({
    name: "rag_bm25_search",
    args: { query: "hello", source_message_id: 1 },
    env,
    ledger,
    sessionKey: "s1",
    runId: "r1",
    mcp: {
      async callTool() {
        throw new Error("should not dispatch");
      },
    },
  });
  assert.equal(forged.ok, false);
  assert.equal(JSON.parse(forged.text).error, INVALID_ARGS);
});

test("dispatch rejects unknown session, extra chat arg, and MCP failures", async () => {
  const ledger = seededLedger();
  const missing = await dispatchCacheTool({
    name: "rag_bm25_search",
    args: { query: "x" },
    env,
    ledger: new SourceMessageLedger(),
    sessionKey: "other",
    mcp: { async callTool() { return {}; } },
  });
  assert.equal(JSON.parse(missing.text).error, SESSION_REJECTED);

  const chatArg = await dispatchCacheTool({
    name: "keyword_search",
    args: { query: "x", chat: "-1003179772905" },
    env,
    ledger,
    sessionKey: "s1",
    runId: "r1",
    mcp: { async callTool() { return {}; } },
  });
  assert.equal(JSON.parse(chatArg.text).error, INVALID_ARGS);

  const protocol = await dispatchCacheTool({
    name: "day_digest",
    args: { day_from: "2026-08-01" },
    env,
    ledger,
    sessionKey: "s1",
    runId: "r1",
    mcp: { async callTool() { throw new Error("boom"); } },
  });
  assert.match(String(JSON.parse(protocol.text).error), new RegExp(PROTOCOL_ERROR));
});

test("write gate blocks strangers and managed targets", () => {
  assert.equal(
    gateWriteTool({ name: "memory", params: { text: "note" }, env, senderId: "999" }).block,
    true,
  );
  assert.equal(
    gateWriteTool({
      name: "memory",
      params: { text: "[parilka:managed:v1:semantic] x" },
      env,
      senderId: "111",
    }).block,
    true,
  );
  assert.equal(
    gateWriteTool({ name: "memory", params: { text: "note" }, env, senderId: "111" }).block,
    false,
  );
  assert.equal(
    gateWriteTool({ name: "web_search", params: {}, env, senderId: "999" }).block,
    false,
  );
});

test("literal @mention is required; reply-only is not enough", () => {
  assert.equal(hasLiteralBotMention("@parilka_bot ping", "parilka_bot"), true);
  assert.equal(hasLiteralBotMention("слушай @parilka_bot скажи", "parilka_bot"), true);
  assert.equal(hasLiteralBotMention("hey parilka_bot ping", "parilka_bot"), false);
  assert.equal(hasLiteralBotMention("", "parilka_bot"), false);
});

test("footer matches the compact occupancy format", () => {
  assert.equal(compactTokens(38100), "38.1k");
  assert.equal(formatElapsed(63), "1м 3с");
  assert.equal(
    renderFooter({
      model: "openai/gpt-5.6-luna",
      usedTokens: 15200,
      maxTokens: 272000,
      toolCalls: 2,
      elapsedSeconds: 63,
    }),
    "gpt-5.6-luna 🧠 · 15.2k/272.0k · 2 tool calls · 1м 3с",
  );
  assert.match(appendFooter("hi", {
    toolCalls: 0,
    elapsedSeconds: 1,
  }), /hi\n\n\? 🧠 ·/);
});

test("telegram message ids are bounded safe integers", () => {
  assert.equal(parseTelegramMessageId("12"), 12);
  assert.equal(parseTelegramMessageId(0), undefined);
  assert.equal(parseTelegramMessageId(true), undefined);
});

test("ledger can be remembered by sessionKey after capture with runId", () => {
  const ledger = new SourceMessageLedger();
  ledger.capture({
    agentId: "parilka",
    channel: "telegram",
    chatId: "-1003179772905",
    messageId: 77,
    sessionKey: "agent:parilka:telegram:group:-1003179772905",
    runId: "run-abc",
  });
  assert.equal(ledger.remember("agent:parilka:telegram:group:-1003179772905", undefined)?.messageId, 77);
  assert.equal(ledger.remember(undefined, "run-abc")?.messageId, 77);
  assert.equal(
    chatIdFromSessionKey("agent:parilka:telegram:group:-1003179772905"),
    "-1003179772905",
  );
});

test("ledger falls back to the latest captured turn when keys are missing", () => {
  const ledger = new SourceMessageLedger();
  ledger.capture({
    agentId: "parilka",
    channel: "telegram",
    chatId: "-1003179772905",
    messageId: 88,
    sessionKey: "s-live",
    runId: "r-live",
  });
  assert.equal(ledger.remember(undefined, undefined)?.messageId, 88);
});

test("ledger resets toolCalls on a new inbound messageId, not same-message recapture", () => {
  const ledger = new SourceMessageLedger();
  const base = {
    agentId: "parilka",
    channel: "telegram",
    chatId: "-1003179772905",
    sessionKey: "s1",
  } as const;
  ledger.capture({ ...base, messageId: 10, runId: "r1" });
  assert.equal(ledger.recordToolCall("s1", "r1"), 1);
  assert.equal(ledger.recordToolCall("s1", "r1"), 2);
  ledger.capture({ ...base, messageId: 10, runId: "r1" });
  assert.equal(ledger.toolCalls("s1", "r1"), 2);
  ledger.capture({ ...base, messageId: 11, runId: "r2" });
  assert.equal(ledger.toolCalls("s1", "r2"), 0);
  assert.equal(ledger.recordToolCall("s1", "r2"), 1);
  assert.equal(ledger.toolCalls(undefined, "r1"), 2);
});
