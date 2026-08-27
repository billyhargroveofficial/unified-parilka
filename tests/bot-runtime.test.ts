import assert from "node:assert/strict";
import { test } from "node:test";
import { BotUpdateProcessor, createToolProgressTelegramBotApiPort } from "../src/bot/runtime.js";
import { TelegramBotApiRejectedError } from "../src/bot/telegram-bot-api.js";
import { TurnCoordinator } from "../src/bot/turn-coordinator.js";
import { TELEGRAM_OPTIONS, addressedUpdate, makeStore, messageUpdate } from "./support/bot-runtime.js";

test("processor commits the trigger before ack and never reserves ambient messages", (t) => {
  const store = makeStore(t); let notices = 0;
  const processor = new BotUpdateProcessor({ store, coordinator: new TurnCoordinator({ maxActiveTurns: 2 }), workNotifier: { notify() { notices += 1; } }, telegram: TELEGRAM_OPTIONS, now: () => 1_000 });
  const addressed = processor.process(addressedUpdate(100, 500));
  const ambient = processor.process(messageUpdate(101, 501, { text: "контекст" }));
  assert.equal(addressed.acknowledged && addressed.turnReserved, true);
  assert.equal(ambient.acknowledged && ambient.turnReserved, false);
  assert.equal(store.queryBotTurns().length, 1);
  assert.equal(notices, 1);
});

test("duplicate committed update is acknowledged without another turn", (t) => {
  const store = makeStore(t); const processor = new BotUpdateProcessor({ store, coordinator: new TurnCoordinator({ maxActiveTurns: 1 }), workNotifier: { notify() {} }, telegram: TELEGRAM_OPTIONS, now: () => 1_000 });
  processor.process(addressedUpdate(150, 550));
  const duplicate = processor.process(addressedUpdate(150, 550));
  assert.equal(duplicate.disposition, "duplicate");
  assert.equal(store.queryBotTurns().length, 1);
});

test("progress cleanup treats Telegram already-absent as idempotent success", async () => {
  const api = {
    async sendTransientMessage() { return { message_id: 1 }; },
    async sendChatAction() {},
    async editMessageText() { return true; },
    async deleteMessage() {
      throw new TelegramBotApiRejectedError(400, "Bad Request: message to delete not found");
    },
  };
  const progress = createToolProgressTelegramBotApiPort(api);
  assert.deepEqual(await progress.deleteMessage("-1001", 7, new AbortController().signal), { ok: true });

  api.deleteMessage = async () => {
    throw new TelegramBotApiRejectedError(400, "Bad Request: message can't be deleted");
  };
  assert.deepEqual(await progress.deleteMessage("-1001", 7, new AbortController().signal), { ok: false, terminal: true });
});

test("progress create and edit re-pulse native typing without delaying or failing presentation", async () => {
  const calls: string[] = [];
  const api = {
    async sendTransientMessage() { calls.push("send"); return { message_id: 7 }; },
    async sendChatAction() { calls.push("typing"); throw new Error("presentation-only"); },
    async editMessageText() { calls.push("edit"); return true; },
    async deleteMessage() { return true; },
  };
  const progress = createToolProgressTelegramBotApiPort(api);
  const signal = new AbortController().signal;

  assert.deepEqual(await progress.sendMessage("-1001", "thinking", signal), { ok: true, messageId: 7 });
  assert.deepEqual(await progress.editMessageText("-1001", 7, "done", signal), { ok: true });
  assert.deepEqual(calls, ["send", "typing", "edit", "typing"]);
});
