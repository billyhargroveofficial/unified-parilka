import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTelegramUpdate } from "../src/bot/telegram-update.js";

const CHAT_ID = -100_123_456_789;
const BOT_ID = 7_700_011;
const OPTIONS = {
  allowedChatId: String(CHAT_ID),
  botId: String(BOT_ID),
  botUsername: "@ParilkaBot",
} as const;

test("UTF-16 mention parsing survives deterministic emoji fuzz cases", () => {
  const random = mulberry32(0xc0d_ea5);
  const fragments = ["a", "я", "😀", "🔥", "🧑‍💻", " "];

  for (let sample = 0; sample < 200; sample += 1) {
    let prefix = "😀";
    const fragmentCount = 1 + Math.floor(random() * 20);
    for (let index = 0; index < fragmentCount; index += 1) {
      prefix += fragments[Math.floor(random() * fragments.length)];
    }
    prefix += " ";

    const text = `${prefix}@ParilkaBot хвост`;
    const utf16Offset = prefix.length;
    const codePointOffset = [...prefix].length;
    assert.notEqual(codePointOffset, utf16Offset);

    const valid = normalizeTelegramUpdate(botUpdate({
      message_id: 1_000 + sample,
      text,
      entities: [{ type: "mention", offset: utf16Offset, length: "@ParilkaBot".length }],
    }), OPTIONS);
    assert.equal(valid.addressed, true, `valid sample ${sample}`);

    const malformed = normalizeTelegramUpdate(botUpdate({
      message_id: 2_000 + sample,
      text,
      entities: [{ type: "mention", offset: codePointOffset, length: "@ParilkaBot".length }],
    }), OPTIONS);
    assert.equal(malformed.addressed, false, `malformed sample ${sample}`);
  }
});

test("reply to bot message sets replyToBot true", () => {
  const result = normalizeTelegramUpdate(botUpdate({
    text: "спасибо за ответ",
    reply_to_message: { message_id: 10, from: { id: BOT_ID, is_bot: true, username: "ParilkaBot" } },
  }), OPTIONS);

  assert.equal(result.replyToBot, true);
  assert.equal(result.reason, "not_addressed");
  assert.equal(result.ingest, true);
});

test("reply to another user does not set replyToBot", () => {
  const result = normalizeTelegramUpdate(botUpdate({
    text: "согласен с тобой",
    reply_to_message: { message_id: 10, from: { id: 999_999, is_bot: false, username: "charlie" } },
  }), OPTIONS);

  assert.equal(result.replyToBot, undefined);
  assert.equal(result.ingest, true);
});

test("message without reply_to_message has no replyToBot", () => {
  const result = normalizeTelegramUpdate(botUpdate({ text: "обычное сообщение" }), OPTIONS);

  assert.equal(result.replyToBot, undefined);
  assert.equal(result.ingest, true);
});

test("reply_to_message without from field is safe", () => {
  const result = normalizeTelegramUpdate(botUpdate({
    text: "ответ",
    // `from` deliberately absent — channel-forward edge case.
    reply_to_message: { message_id: 10 },
  }), OPTIONS);

  assert.equal(result.replyToBot, undefined);
  assert.equal(result.ingest, true);
});

test("reply_to_message with sender_chat is ignored for replyToBot", () => {
  const result = normalizeTelegramUpdate(botUpdate({
    text: "ответ на пост канала",
    reply_to_message: { message_id: 10, sender_chat: { id: BOT_ID, title: "BotChannel" } },
  }), OPTIONS);

  assert.equal(result.replyToBot, undefined);
  assert.equal(result.ingest, true);
});

test("replyToBot is absent for own message even when replying to self", () => {
  const result = normalizeTelegramUpdate(botUpdate({
    from: { id: BOT_ID, is_bot: true, username: "ParilkaBot" },
    text: "бот ответил",
    reply_to_message: { message_id: 5, from: { id: BOT_ID, is_bot: true, username: "ParilkaBot" } },
  }), OPTIONS);

  assert.equal(result.replyToBot, undefined);
  assert.equal(result.reason, "own_message");
});

function botUpdate(overrides: Record<string, unknown> = {}): { update_id: number; message: Record<string, unknown> } {
  return {
    update_id: 91,
    message: {
      message_id: 17,
      date: 1_700_000_000,
      chat: { id: CHAT_ID, type: "supergroup", title: "Парилка" },
      from: { id: 123_456, is_bot: false, username: "billy", first_name: "Billy" },
      text: "обычное сообщение",
      ...overrides,
    },
  };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = value + Math.imul(value ^ (value >>> 7), 61 | value) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
