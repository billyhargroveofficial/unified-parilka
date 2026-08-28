import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_CONTEXT_MESSAGES,
  BOT_REPLAY_MESSAGES,
  type BotAgentRequest,
} from "../src/bot/worker.js";
import { isAgentFinal } from "../src/bot/worker/helpers.js";
import {
  CHAT,
  TRIGGER_ID,
  deferredFinal,
  final,
  makeFixture,
  message,
  range,
  stubTelemetry,
  waitUntil,
} from "./support/bot-worker.js";
import type { TelegramPublication } from "../src/bot/telegram-publication.js";
import type { ToolProgressBotApiPort } from "../src/bot/tool-progress.js";

test("agent final guard rejects missing or malformed telemetry", () => {
  const telemetry = stubTelemetry();
  const valid = {
    kind: "final" as const,
    text: "answer",
    telemetry,
  };

  assert.equal(isAgentFinal(valid), true);
  assert.equal(
    isAgentFinal({
      ...valid,
      telemetry: { ...telemetry, toolCalls: Number.NaN },
    }),
    false,
  );
  assert.equal(
    isAgentFinal({
      ...valid,
      telemetry: { ...telemetry, steps: [null] },
    }),
    false,
  );
  assert.equal(
    isAgentFinal({
      ...valid,
      telemetry: { ...telemetry, contextUsedTokens: -1 },
    }),
    false,
  );
  assert.equal(
    isAgentFinal({
      ...valid,
      telemetry: { ...telemetry, contextWindowTokens: 0 },
    }),
    false,
  );
  assert.equal(
    isAgentFinal({
      ...valid,
      telemetry: {
        ...telemetry,
        contextUsedTokens: undefined,
        contextWindowTokens: undefined,
      },
    }),
    true,
  );
  assert.equal(
    isAgentFinal({ ...valid, responseOrigin: "remote" }),
    false,
  );
  assert.equal(
    isAgentFinal({ kind: "final", text: "answer" }),
    false,
  );
});

test("live success uses bounded context/replay, exact draft, and no raw streaming", async (t) => {
  const fixture = makeFixture(t);
  const before = range(TRIGGER_ID - 65, TRIGGER_ID - 1).map((id) =>
    message(id, `context-${id}`, "context-user"),
  );
  const after = range(TRIGGER_ID + 1, TRIGGER_ID + 105).map((id) =>
    message(id, `replay-${id}`, id % 2 ? "owner" : "ambient"),
  );
  fixture.store.upsertMessages(CHAT, [...before, ...after]);
  const finalText = "Готовый безопасный ответ UNIQUE_FINAL_TEXT";
  let agentRequest: BotAgentRequest | undefined;
  let replayed = 0;
  const publisherCalls: Array<{
    chatId: string;
    replyToMessageId: number;
    publication: TelegramPublication;
  }> = [];
  const worker = fixture.worker({
    agent: async (request) => {
      agentRequest = request;
      for (let index = 0; index < 5; index += 1) {
        replayed += request.drainFold("tool").messages.length;
      }
      return final(finalText);
    },
    publisher: async (request) => {
      assert.equal(
        fixture.scheduler.intervalCount,
        0,
        "lease heartbeat must stop before publisher",
      );
      assert.equal(
        fixture.scheduler.timeoutCount,
        1,
        "only the publisher deadline may remain active",
      );
      assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "sending");
      assert.match(
        fixture.store.getBotTurn(fixture.turnId)?.draftText ?? "",
        new RegExp(`^${finalText}\\n\\ntest-model 🧠 · 10/1\\.0m · 0 tool calls · 0с$`, "u"),
      );
      publisherCalls.push(request);
      return {
        ok: true,
        chunksSent: 1,
        telegramMessageId: 9_001,
      };
    },
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    status: "sent",
    turnId: fixture.turnId,
    telegramMessageId: 9_001,
  });
  assert.equal(agentRequest?.signal instanceof AbortSignal, true);
  assert.equal(agentRequest?.context.length, BOT_CONTEXT_MESSAGES + 1);
  assert.equal(agentRequest?.context[0]?.messageId, TRIGGER_ID - 60);
  assert.equal(agentRequest?.context.at(-1)?.messageId, TRIGGER_ID);
  assert.equal(replayed, BOT_REPLAY_MESSAGES);
  assert.equal(publisherCalls.length, 1);
  assert.equal(publisherCalls[0]?.replyToMessageId, TRIGGER_ID);
  assert.equal(publisherCalls[0]?.publication.mode, "rich");
  assert.match(
    publisherCalls[0]?.publication.markdown ?? "",
    new RegExp(`^${finalText}\\n\\ntest-model 🧠 · 10/1\\.0m · 0 tool calls · 0с$`, "u"),
  );
  assert.equal(
    publisherCalls[0]?.publication.plainText,
    fixture.store.getBotTurn(fixture.turnId)?.draftText,
  );
  assert.match(
    fixture.store.getBotTurn(fixture.turnId)?.draftText ?? "",
    new RegExp(`^${finalText}\\n\\ntest-model 🧠 · 10/1\\.0m · 0 tool calls · 0с$`, "u"),
  );
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "sent");
  const serializedLogs = JSON.stringify(fixture.logs);
  assert.doesNotMatch(serializedLogs, /UNIQUE_FINAL_TEXT|trigger secret/);
});

test("durable replay is seeded even when live dedupe saw the message first", async (t) => {
  const fixture = makeFixture(t);
  const followUp = message(
    TRIGGER_ID + 1,
    "важное уточнение из durable replay",
    "owner",
  );
  fixture.store.upsertMessages(CHAT, [followUp]);
  fixture.coordinator.routeMessage({
    messageId: `${CHAT.chatId}:${followUp.messageId}`,
    senderId: followUp.senderId!,
    senderName: followUp.senderName,
    text: followUp.text,
  });
  let foldedIds: string[] = [];
  const worker = fixture.worker({
    agent: async (request) => {
      foldedIds = request
        .drainFold("model")
        .messages.map(({ messageId }) => messageId);
      return final("Учёл уточнение");
    },
    publisher: async () => ({
      ok: true,
      chunksSent: 1,
    }),
  });

  assert.equal((await worker.runOnce()).status, "sent");
  assert.deepEqual(foldedIds, [`${CHAT.chatId}:${followUp.messageId}`]);
});

test("worker gives the generic coordinator the canonical durable turn ID", async (t) => {
  const fixture = makeFixture(t);
  const pendingFinal = deferredFinal();
  const worker = fixture.worker({
    agent: async () => pendingFinal.promise,
    publisher: async () => ({ ok: true, chunksSent: 1 }),
  });

  const running = worker.runOnce();
  await waitUntil(
    () => fixture.coordinator.getTurn(String(fixture.turnId)) !== undefined,
  );

  assert.equal(
    fixture.coordinator.getTurn(String(fixture.turnId))?.turnId,
    String(fixture.turnId),
  );
  assert.equal(
    fixture.coordinator.getTurn(`bot:${CHAT.chatId}:${fixture.turnId}`),
    undefined,
  );

  pendingFinal.resolve(final("готово"));
  assert.equal((await running).status, "sent");
});

test("exact SKIP is durably drafted and published like every other model reply", async (t) => {
  const fixture = makeFixture(t);
  const publisherCalls: TelegramPublication[] = [];
  const worker = fixture.worker({
    agent: async () => final("SKIP"),
    publisher: async ({ publication }) => {
      publisherCalls.push(publication);
      return { ok: true, chunksSent: 1, telegramMessageId: 9_001 };
    },
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    status: "sent",
    turnId: fixture.turnId,
    telegramMessageId: 9_001,
  });
  assert.deepEqual(publisherCalls, [
    {
      mode: "rich",
      markdown: "SKIP\n\ntest-model 🧠 · 10/1.0m · 0 tool calls · 0с",
      plainText: "SKIP\n\ntest-model 🧠 · 10/1.0m · 0 tool calls · 0с",
      maxChunkUtf16: 4_096,
    },
  ]);
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "sent");
  assert.equal(
    fixture.store.getBotTurn(fixture.turnId)?.draftText,
    "SKIP\n\ntest-model 🧠 · 10/1.0m · 0 tool calls · 0с",
  );
});

test("model text with mentions and think tags is published and drafted unmodified", async (t) => {
  const fixture = makeFixture(t);
  const modelText = "@mallory посмотри сюда\n<think>не прячь этот текст</think>";
  const expected = `${modelText}\n\ntest-model 🧠 · 10/1.0m · 0 tool calls · 0с`;
  const publisherCalls: TelegramPublication[] = [];
  const worker = fixture.worker({
    agent: async () => final(modelText),
    publisher: async ({ publication }) => {
      publisherCalls.push(publication);
      return { ok: true, chunksSent: 1, telegramMessageId: 9_002 };
    },
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    status: "sent",
    turnId: fixture.turnId,
    telegramMessageId: 9_002,
  });
  assert.equal(publisherCalls.length, 1);
  assert.deepEqual(publisherCalls[0], {
    mode: "rich",
    markdown: expected,
    plainText: expected,
    maxChunkUtf16: 4_096,
  });
  const stored = fixture.store.getBotTurn(fixture.turnId);
  assert.equal(stored?.status, "sent");
  assert.equal(stored?.draftText, expected);
  assert.doesNotMatch(JSON.stringify(fixture.logs), /guard_rejected/u);
});

test("a local audio transcript remains a plain publication without neutralization", async (t) => {
  const fixture = makeFixture(t);
  const transcript = `Коля: «дословный текст из голосового, а не модельная цитата»\n@someone ${"x".repeat(4_500)}`;
  const expected = `${transcript}\n\ntest-model 🧠 · 10/1.0m · 0 tool calls · 0с`;
  let observed: TelegramPublication | undefined;
  const worker = fixture.worker({
    agent: async () => ({
      kind: "final",
      text: transcript,
      telemetry: stubTelemetry(),
      responseOrigin: "local_audio",
    }),
    publisher: async ({ publication }) => {
      observed = publication;
      return { ok: true, chunksSent: 2, telegramMessageId: 9_100 };
    },
  });

  const result = await worker.runOnce();

  assert.equal(result.status, "sent");
  assert.equal(observed?.mode, "plain");
  assert.equal(observed?.plainText, expected);
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.draftText, expected);
});

test("a final with a mention clears the tool-progress message before publication", async (t) => {
  const fixture = makeFixture(t);
  const calls: string[] = [];
  const port: ToolProgressBotApiPort = {
    async sendMessage() {
      calls.push("send");
      return { ok: true, messageId: 42 };
    },
    async editMessageText() {
      calls.push("edit");
      return { ok: true };
    },
    async deleteMessage() {
      calls.push("delete");
      return { ok: true };
    },
  };
  const worker = fixture.worker({
    agent: async (request) => {
      request.toolProgressPort?.onToolStarted({
        toolName: "static_page_fetch",
        callId: "guard-progress",
        input: { url: "https://example.com" },
      });
      return final("@mallory unsafe final");
    },
    publisher: async ({ publication }) => {
      assert.equal(
        publication.plainText,
        "@mallory unsafe final\n\ntest-model 🧠 · 10/1.0m · 0 tool calls · 0с",
      );
      return { ok: true, chunksSent: 1 };
    },
    toolProgressBotApiPort: port,
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    status: "sent",
    turnId: fixture.turnId,
  });
  assert.deepEqual(calls, ["send", "delete"]);
});

test("a failed unmodified final stays an unknown-delivery fence", async (t) => {
  const fixture = makeFixture(t);
  let publisherCalls = 0;
  const worker = fixture.worker({
    agent: async () => final("@mallory unsafe final"),
    publisher: async ({ publication }) => {
      publisherCalls += 1;
      assert.equal(
        publication.plainText,
        "@mallory unsafe final\n\ntest-model 🧠 · 10/1.0m · 0 tool calls · 0с",
      );
      return {
        ok: false,
        chunksSent: 0,
        error: { kind: "network", code: "ECONNRESET" },
      };
    },
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, { status: "lost_ack", turnId: fixture.turnId });
  assert.equal(publisherCalls, 1);
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "lost_ack");
});

test("shadow mode saves the unmodified draft and terminates without publisher", async (t) => {
  const fixture = makeFixture(t, { mode: "shadow" });
  let publisherCalls = 0;
  const worker = fixture.worker({
    agent: async () =>
      final("<think>private chain</think>\nПубличный ответ"),
    publisher: async () => {
      publisherCalls += 1;
      throw new Error("shadow must not publish");
    },
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    status: "skipped",
    turnId: fixture.turnId,
    reason: "shadow",
  });
  assert.equal(publisherCalls, 0);
  assert.match(
    fixture.store.getBotTurn(fixture.turnId)?.draftText ?? "",
    /^<think>private chain<\/think>\nПубличный ответ\n\ntest-model 🧠 · 10\/1\.0m · 0 tool calls · 0с$/u,
  );
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "skipped");
});

test("provider failure before send is retryable through durable failed state", async (t) => {
  const fixture = makeFixture(t);
  let publisherCalls = 0;
  const worker = fixture.worker({
    agent: async () => {
      const error = new Error("provider response contained SECRET_PROVIDER_TEXT");
      error.name = "ProviderUnavailable";
      throw error;
    },
    publisher: async () => {
      publisherCalls += 1;
      throw new Error("must not publish");
    },
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    status: "failed",
    turnId: fixture.turnId,
    stage: "agent",
  });
  assert.equal(publisherCalls, 0);
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "failed");
  assert.doesNotMatch(JSON.stringify(fixture.logs), /SECRET_PROVIDER_TEXT/);
});

test("worker passes tool progress port and cleans up before durable final", async (t) => {
  const fixture = makeFixture(t);
  const portCalls: Array<
    | { kind: "send"; chatId: string; text: string; signal: AbortSignal }
    | { kind: "edit" }
    | { kind: "delete"; chatId: string; messageId: number; signal: AbortSignal }
  > = [];
  const port: ToolProgressBotApiPort = {
    async sendMessage(chatId, text, signal) {
      portCalls.push({ kind: "send", chatId, text, signal });
      return { ok: true, messageId: 42 };
    },
    async editMessageText() {
      portCalls.push({ kind: "edit" });
      return { ok: true };
    },
    async deleteMessage(chatId, messageId, signal) {
      portCalls.push({ kind: "delete", chatId, messageId, signal });
      return { ok: true };
    },
  };
  let receivedPort: unknown;
  const worker = fixture.worker({
    agent: async (request) => {
      receivedPort = request.toolProgressPort;
      request.toolProgressPort?.onToolStarted({
        toolName: "rag_bm25_search",
        callId: "c1",
      });
      return final("done");
    },
    publisher: async () => ({ ok: true, chunksSent: 1 }),
    toolProgressBotApiPort: port,
  });

  const result = await worker.runOnce();

  assert.equal(result.status, "sent");
  assert.ok(receivedPort, "agent must receive tool progress port");
  assert.equal(portCalls.some((call) => call.kind === "send"), true);
  const deleteCall = portCalls.find((call) => call.kind === "delete");
  assert.ok(deleteCall, "progress message must be deleted before durable final");
});
