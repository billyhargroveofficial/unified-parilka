import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  BotUpdateProcessor,
  type TelegramLongPollingApiPort,
} from "../../src/bot/runtime.js";
import { TurnCoordinator } from "../../src/bot/turn-coordinator.js";
import { MessageStore } from "../../src/store.js";

export const CHAT_ID = "-1003179772905";
export const BOT_ID = "700011";
export const BOT_USERNAME = "ParilkaBot";
export const TELEGRAM_OPTIONS = {
  allowedChatId: CHAT_ID,
  botId: BOT_ID,
  botUsername: BOT_USERNAME,
} as const;

export function makeStore(t: TestContext): MessageStore {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-runtime-"));
  const store = new MessageStore(join(directory, "cache.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

export function processorFor(store: MessageStore, now: () => number = () => 1_000): BotUpdateProcessor {
  return new BotUpdateProcessor({
    store,
    coordinator: new TurnCoordinator({ maxActiveTurns: 3 }),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
    triggerCooldownMs: 5_000,
    updateMaxAttempts: 3,
    now,
  });
}

export function pollingApi(getUpdates: TelegramLongPollingApiPort["getUpdates"]): TelegramLongPollingApiPort {
  return {
    async getMe() { return { id: Number(BOT_ID), is_bot: true, username: BOT_USERNAME }; },
    async deleteWebhook() { return true; },
    getUpdates,
  };
}

export function addressedUpdate(updateId: number, messageId: number): Record<string, unknown> {
  return messageUpdate(updateId, messageId, {
    text: "@ParilkaBot вопрос",
    entities: [{ type: "mention", offset: 0, length: "@ParilkaBot".length }],
  });
}

export function messageUpdate(updateId: number, messageId: number, overrides: Record<string, unknown>): Record<string, unknown> {
  return { update_id: updateId, message: message(messageId, overrides) };
}

export function message(messageId: number, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    message_id: messageId,
    date: 1_700_000_000,
    chat: { id: Number(CHAT_ID), type: "supergroup", title: "Парилка" },
    from: { id: 42, is_bot: false, username: "alice" },
    text: "сообщение",
    ...overrides,
  };
}
