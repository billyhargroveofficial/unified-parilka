import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PROGRESS_SNAPSHOTS_PER_TURN,
  ToolProgressPublisher,
  type ToolProgressBotApiPort,
} from "../src/bot/tool-progress.js";

test("hard-caps Telegram progress snapshots while keeping terminal cleanup", async () => {
  const calls: string[] = [];
  const port: ToolProgressBotApiPort = {
    async sendMessage() { calls.push("send"); return { ok: true, messageId: 1 }; },
    async editMessageText() { calls.push("edit"); return { ok: true }; },
    async deleteMessage() { calls.push("delete"); return { ok: true }; },
  };
  const publisher = new ToolProgressPublisher({
    turnId: 7,
    workerId: "worker",
    chatId: "-10042",
    signal: new AbortController().signal,
    botApi: port,
    store: {
      saveBotTurnProgress() { return true; },
      clearBotTurnProgress() { return true; },
    },
    minVisibleMs: 0,
  });

  publisher.onThinkingStarted({ callId: "thinking" });
  publisher.onThinkingCompleted({ callId: "thinking" }, true);
  for (let index = 0; index < MAX_PROGRESS_SNAPSHOTS_PER_TURN + 8; index += 1) {
    const callId = `tool-${index}`;
    publisher.onToolStarted({ toolName: `tool ${index}`, callId });
    publisher.onToolCompleted({ toolName: `tool ${index}`, callId }, true);
  }
  await publisher.finish(new AbortController().signal);

  assert.equal(
    calls.filter((kind) => kind === "send" || kind === "edit").length,
    MAX_PROGRESS_SNAPSHOTS_PER_TURN,
  );
  assert.equal(calls.at(-1), "delete");
  assert.equal(publisher.state, "none");
});
