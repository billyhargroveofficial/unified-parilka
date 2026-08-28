import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBotTurn } from "../src/bot/worker/turn-context.js";
import { parseStoredTelegramMedia } from "../src/bot/media/telegram-media.js";
import { MessageStore } from "../src/store.js";
import type { StoredBotTurn, StoredMessage } from "../src/store.js";

const CHAT_ID = "-1003179772905";

function fixtureStore() {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-memory-"));
  const dbPath = join(directory, "shared.sqlite");
  const store = new MessageStore(dbPath);
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "Memory Test",
    kind: "channel",
    isForum: false,
  });
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Memory Test",
      kind: "channel",
      isForum: false,
    },
    [
      {
        chatId: CHAT_ID,
        messageId: 1,
        date: "2026-07-29T12:00:00Z",
        senderId: "user",
        senderName: "Alice",
        text: "hello",
      },
      {
        chatId: CHAT_ID,
        messageId: 2,
        date: "2026-07-29T12:01:00Z",
        senderId: "user",
        senderName: "Bob",
        text: "hi",
      },
    ] as StoredMessage[],
  );
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function makeTurn(triggerMessageId: number): StoredBotTurn {
  return {
    id: 1,
    updateId: 1,
    chatId: CHAT_ID,
    triggerMessageId,
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
}

test("loadBotTurn includes chat memory when present", () => {
  const { store, cleanup } = fixtureStore();
  try {
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "Alice says hello.",
      lastConsolidatedMessageId: 1,
    });
    store.upsertFastChatMemory({
      chatId: CHAT_ID,
      title: "Release",
      note: "Run the full gates.",
      sourceMessageId: 2,
    });
    store.upsertChatLesson({
      chatId: CHAT_ID,
      title: "Timeout",
      problem: "A provider step timed out.",
      solution: "Use a full-turn deadline.",
      whenToApply: "When a slow provider needs tool results.",
      sourceMessageId: 2,
    });
    store.upsertChatSkill({
      chatId: CHAT_ID,
      name: "Release",
      description: "Safe release playbook.",
      instructions: "Run the gates before restart.",
      sourceMessageId: 2,
    });
    const loaded = loadBotTurn(store, makeTurn(2));
    assert.ok(loaded);
    assert.equal(loaded?.memory?.memoryText, "Alice says hello.");
    assert.equal(loaded?.memory?.lastConsolidatedMessageId, 1);
    assert.equal(loaded?.fastMemory[0]?.title, "Release");
    assert.equal(loaded?.longTermLessons[0]?.title, "Timeout");
    assert.equal(loaded?.chatSkills[0]?.name, "Release");
  } finally {
    cleanup();
  }
});

test("loadBotTurn returns undefined memory when absent", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const loaded = loadBotTurn(store, makeTurn(2));
    assert.ok(loaded);
    assert.equal(loaded?.memory, undefined);
    assert.deepEqual(loaded?.fastMemory, []);
    assert.deepEqual(loaded?.longTermLessons, []);
    assert.deepEqual(loaded?.chatSkills, []);
  } finally {
    cleanup();
  }
});

test("loadBotTurn returns undefined when trigger is missing", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const loaded = loadBotTurn(store, makeTurn(999));
    assert.equal(loaded, undefined);
  } finally {
    cleanup();
  }
});

test("loadBotTurn restores Bot API media from its durable update after sync metadata overwrites rawJson", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const chat = {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Memory Test",
      kind: "channel",
      isForum: false,
    } as const;
    const message = {
      message_id: 3,
      chat: { id: CHAT_ID },
      from: { id: 42, username: "kolya" },
      text: "@bot расшифруй",
      // Above the legacy 1 MiB parser ceiling, but below the accepted Bot API
      // durable-update limit. Hydration must retain the actual attachment.
      padding: "x".repeat(1_200_000),
      voice: { file_id: "voice_from_update", duration: 3 },
    };
    const ingested = store.ingestBotUpdate({
      updateId: 55,
      rawJson: JSON.stringify({ update_id: 55, message }),
      chat,
      message: {
        chatId: CHAT_ID,
        messageId: 3,
        senderId: "42",
        senderName: "kolya",
        text: "@bot расшифруй",
        rawJson: JSON.stringify(message),
      },
      addressed: true,
      nowMs: 1,
    });
    assert.ok(ingested.turn);

    // The sync path only has transport-neutral metadata and must not make an
    // already-reserved Bot API media turn lose its file reference.
    store.upsertMessages(chat, [{
      chatId: CHAT_ID,
      messageId: 3,
      text: "@bot расшифруй",
      rawJson: JSON.stringify({ groupedId: "sync-only" }),
    }]);

    const loaded = loadBotTurn(store, ingested.turn!);
    assert.ok(loaded);
    assert.deepEqual(parseStoredTelegramMedia(loaded!.trigger), {
      kind: "voice",
      fileId: "voice_from_update",
      mediaType: "audio/ogg",
      durationSeconds: 3,
    });
  } finally {
    cleanup();
  }
});
