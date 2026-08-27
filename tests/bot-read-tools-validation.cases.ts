import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_BOT_READ_TOOL_OUTPUT_CHARS,
  BotReadTools,
} from "../src/bot/read-tools.js";
import {
  asFailure,
  CHAT,
  emptyCache,
  message,
} from "./support/bot-read-tools.js";

test("strict schemas reject malformed, coerced, and extra arguments as data", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
  });
  const cases: Array<[string, unknown, string]> = [
    ["rag_bm25_search", { query: "" }, "query"],
    ["rag_bm25_search", { query: "x", limit: "5" }, "limit"],
    ["rag_bm25_search", { query: "x", surprise: true }, "surprise"],
    ["day_digest", { day_from: "2026-02-30" }, "day_from"],
    ["day_digest", { day_from: "вчера" }, "day_from"],
    ["thread_context", { message_id: 0 }, "message_id"],
    [
      "thread_context",
      { message_id: 1, before: -1, after: 31 },
      "before",
    ],
  ];

  for (const [name, args, field] of cases) {
    const result = asFailure(await tools.callTool(name, args));
    assert.equal(result.error.code, "invalid_arguments", name);
    assert.equal(result.error.retryable, false, name);
    assert.ok(
      result.error.fields?.some(({ path }) => path === field),
      `${name} must identify ${field}`,
    );
  }

  const unknown = asFailure(await tools.callTool("shell", {}));
  assert.equal(unknown.error.code, "unknown_tool");
});

test("cache exceptions are returned as typed error data", async () => {
  const cacheTools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache({
      search() {
        throw new Error("SQLITE_IOERR");
      },
    }),
  });
  const cacheFailure = asFailure(
    await cacheTools.callTool("rag_bm25_search", { query: "x" }),
  );
  assert.equal(cacheFailure.error.code, "cache_error");
  assert.equal(cacheFailure.error.retryable, false);
  assert.equal(cacheFailure.error.message, "Chat search failed.");
  assert.doesNotMatch(cacheFailure.error.message, /SQLITE_IOERR/);
});

test("tool payloads are projected once and stay inside the hard character budget", async () => {
  const huge = "x".repeat(20_000);
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache({
      search() {
        return [message(999, huge, "alice")];
      },
      getDigests() {
        return {
          digests: [
            {
              kind: "day",
              period: "2026-07-30",
              dayFrom: "2026-07-30",
              dayTo: "2026-07-30",
              text: huge,
            },
          ],
        };
      },
    }),
  });

  for (const result of [
    await tools.callTool("rag_bm25_search", { query: "huge" }),
    await tools.callTool("day_digest", { day_from: "2026-07-30" }),
  ]) {
    assert.equal(result.ok, true);
    assert.ok(JSON.stringify(result).length <= MAX_BOT_READ_TOOL_OUTPUT_CHARS);
    if (result.ok) {
      assert.deepEqual(result.result.projection, {
        truncated: true,
        omittedEvidence: 0,
        maxCharacters: MAX_BOT_READ_TOOL_OUTPUT_CHARS,
      });
    }
  }
});
