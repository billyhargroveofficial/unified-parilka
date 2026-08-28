import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageStore } from "../../src/store.js";
import type {
  StoredChatMemory,
  StoredFastChatMemory,
  StoredChatLesson,
  StoredChatSkill,
} from "../../src/storage/types.js";

export const CHAT_ID = "-1003179772905";

export function tmpDb(): { store: MessageStore; dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hermes-proj-"));
  const dbPath = join(dir, "messages.sqlite");
  const store = new MessageStore(dbPath);
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "Test Chat",
    kind: "channel",
    isForum: false,
  });
  return {
    store,
    dbPath,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed by the test
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function seedMemory(
  store: MessageStore,
  chatId: string,
  text: string,
  revision: number = 1,
  lastConsolidatedMessageId?: number,
): StoredChatMemory {
  return store.upsertChatMemory({
    chatId,
    memoryText: text,
    lastConsolidatedMessageId,
    updatedAtMs: revision * 1000,
  });
}

export function seedFastMemory(
  store: MessageStore,
  chatId: string,
  title: string,
  note: string,
  updatedAtMs: number = 1000,
): StoredFastChatMemory {
  return store.upsertFastChatMemory({
    chatId,
    title,
    note,
    sourceMessageId: Math.max(1, Math.floor(updatedAtMs)),
    updatedAtMs,
  });
}

export function seedLesson(
  store: MessageStore,
  chatId: string,
  title: string,
  problem: string,
  solution: string,
  whenToApply: string = "Always",
  updatedAtMs: number = 1000,
): StoredChatLesson {
  return store.upsertChatLesson({
    chatId,
    title,
    problem,
    solution,
    whenToApply,
    sourceMessageId: Math.max(1, Math.floor(updatedAtMs)),
    updatedAtMs,
  });
}

export function seedSkill(
  store: MessageStore,
  chatId: string,
  name: string,
  description: string,
  instructions: string,
  updatedAtMs: number = 1000,
): StoredChatSkill {
  return store.upsertChatSkill({
    chatId,
    name,
    description,
    instructions,
    sourceMessageId: Math.max(1, Math.floor(updatedAtMs)),
    updatedAtMs,
  });
}
