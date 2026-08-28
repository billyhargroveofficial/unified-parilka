import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeTelegramUpdate,
  type NormalizedTelegramUpdate,
} from "../src/bot/telegram-update.js";

const CHAT_ID = -100_123_456_789;
const BOT_ID = 7_700_011;
const OPTIONS = {
  allowedChatId: String(CHAT_ID),
  botId: String(BOT_ID),
  botUsername: "@ParilkaBot",
} as const;

test("username mentions use Telegram's UTF-16 offsets after emoji", () => {
  const text = "эй 😀🚀 @pArIlKaBoT, сделай сводку";
  const offset = text.indexOf("@");
  const update = botUpdate({
    text,
    entities: [
      {
        type: "mention",
        offset,
        length: "@pArIlKaBoT".length,
      },
    ],
  });

  const result = normalizeTelegramUpdate(update, OPTIONS);
  const message = stored(result);

  assert.equal(offset, 8);
  assert.equal([...text.slice(0, offset)].length, 6);
  assert.equal(result.addressed, true);
  assert.equal(result.reason, "username_mention");
  assert.equal(result.updateKind, "message");
  assert.deepEqual(result.chat, {
    chatId: String(CHAT_ID),
    requested: String(CHAT_ID),
    title: "Парилка",
    kind: "supergroup",
  });
  assert.equal(message.text, text);
  assert.equal(message.date, "2023-11-14T22:13:20.000Z");
  assert.deepEqual(JSON.parse(message.rawJson ?? ""), update.message);
});

test("a code-point offset is not mistaken for Telegram's UTF-16 offset", () => {
  const text = "😀🚀 @ParilkaBot";
  const utf16Offset = text.indexOf("@");
  const codePointOffset = [...text.slice(0, utf16Offset)].length;
  const result = normalizeTelegramUpdate(
    botUpdate({
      text,
      entities: [
        {
          type: "mention",
          offset: codePointOffset,
          length: "@ParilkaBot".length,
        },
      ],
    }),
    OPTIONS,
  );

  assert.notEqual(codePointOffset, utf16Offset);
  assert.equal(result.ingest, true);
  assert.equal(result.addressed, false);
  assert.equal(result.reason, "not_addressed");
});

test("caption entities address the bot while preserving the caption", () => {
  const caption = "🔥 @ParilkaBot посмотри фото";
  const result = normalizeTelegramUpdate(
    botUpdate({
      text: undefined,
      photo: [{ file_id: "photo-id" }],
      caption,
      caption_entities: [
        {
          type: "mention",
          offset: caption.indexOf("@"),
          length: "@ParilkaBot".length,
        },
      ],
    }),
    OPTIONS,
  );

  assert.equal(result.addressed, true);
  assert.equal(result.reason, "username_mention");
  assert.equal(stored(result).text, caption);
});

test("text_mention addresses the configured bot id without a username", () => {
  const result = normalizeTelegramUpdate(
    botUpdate({
      text: "позови бота",
      entities: [
        {
          type: "text_mention",
          offset: 7,
          length: 4,
          user: {
            id: BOT_ID,
            is_bot: true,
            first_name: "Parilka",
          },
        },
      ],
    }),
    OPTIONS,
  );

  assert.equal(result.addressed, true);
  assert.equal(result.reason, "text_mention");
});

test("edits are ingested but cannot start a turn", () => {
  const message = baseMessage({
    text: "@ParilkaBot теперь исправлено",
    entities: [
      {
        type: "mention",
        offset: 0,
        length: "@ParilkaBot".length,
      },
    ],
    edit_date: 1_700_000_100,
  });
  const result = normalizeTelegramUpdate(
    { update_id: 92, edited_message: message },
    OPTIONS,
  );

  assert.equal(result.ingest, true);
  assert.equal(result.addressed, false);
  assert.equal(result.reason, "edited_message");
  assert.equal(result.updateKind, "edited_message");
  assert.equal(stored(result).text, "@ParilkaBot теперь исправлено");
});

test("a deleted or inaccessible reply is retained by id but is not a trigger", () => {
  const result = normalizeTelegramUpdate(
    botUpdate({
      text: "продолжаю мысль",
      message_thread_id: 55,
      reply_to_message: {
        message_id: 41,
        date: 0,
        chat: { id: CHAT_ID, type: "supergroup" },
      },
    }),
    OPTIONS,
  );

  assert.equal(result.addressed, false);
  assert.equal(result.reason, "not_addressed");
  assert.equal(stored(result).replyToMessageId, 41);
  assert.equal(stored(result).topicId, 55);
});

test("replying to the bot without a mention does not address it", () => {
  const result = normalizeTelegramUpdate(
    botUpdate({
      text: "да, продолжай",
      reply_to_message: {
        message_id: 42,
        date: 1_700_000_000,
        chat: { id: CHAT_ID, type: "supergroup" },
        from: {
          id: BOT_ID,
          is_bot: true,
          first_name: "Parilka",
          username: "ParilkaBot",
        },
        text: "старый ответ",
        entities: [
          {
            type: "mention",
            offset: 0,
            length: "@ParilkaBot".length,
          },
        ],
      },
    }),
    OPTIONS,
  );

  assert.equal(result.ingest, true);
  assert.equal(result.addressed, false);
  assert.equal(result.reason, "not_addressed");
  assert.equal(stored(result).replyToMessageId, 42);
});

test("non-text Telegram messages get stable placeholders", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ photo: [] }, "[фото]"],
    [{ sticker: { emoji: "🤝" } }, "[стикер 🤝]"],
    [{ sticker: {} }, "[стикер]"],
    [{ voice: { duration: 13 } }, "[голосовое 13с]"],
    [{ voice: {} }, "[голосовое]"],
    [{ video_note: {} }, "[кружок]"],
    [{ video: {} }, "[видео]"],
    [{ animation: {} }, "[гифка]"],
    [{ document: {} }, "[файл]"],
    [{ audio: {} }, "[аудио]"],
    [{ poll: {} }, "[опрос]"],
    [{ location: {} }, "[геопозиция]"],
    [{ contact: {} }, "[контакт]"],
    [{ new_chat_members: [] }, "[зашёл в чат]"],
    [{ left_chat_member: {} }, "[вышел из чата]"],
    [{ pinned_message: {} }, "[закрепил сообщение]"],
  ];

  for (const [payload, expected] of cases) {
    const result = normalizeTelegramUpdate(
      botUpdate({ text: undefined, ...payload }),
      OPTIONS,
    );
    assert.equal(result.ingest, true, expected);
    assert.equal(result.addressed, false, expected);
    assert.equal(stored(result).text, expected);
  }
});

test("own and other bot messages are stored but never trigger", () => {
  const mention = {
    type: "mention",
    offset: 0,
    length: "@ParilkaBot".length,
  };
  const own = normalizeTelegramUpdate(
    botUpdate({
      from: {
        id: BOT_ID,
        is_bot: false,
        first_name: "mislabelled self",
      },
      text: "@ParilkaBot self",
      entities: [mention],
    }),
    OPTIONS,
  );
  const otherBot = normalizeTelegramUpdate(
    botUpdate({
      from: {
        id: 9_999,
        is_bot: true,
        username: "OtherBot",
      },
      text: "@ParilkaBot relay",
      entities: [mention],
    }),
    OPTIONS,
  );

  assert.equal(own.ingest, true);
  assert.equal(own.addressed, false);
  assert.equal(own.reason, "own_message");
  assert.equal(otherBot.ingest, true);
  assert.equal(otherBot.addressed, false);
  assert.equal(otherBot.reason, "bot_message");
});

test("sender_chat wins over Telegram's placeholder bot sender", () => {
  const text = "@ParilkaBot пост из канала";
  const result = normalizeTelegramUpdate(
    botUpdate({
      sender_chat: {
        id: -100_777,
        title: "Новости парилки",
        username: "parilka_news",
      },
      from: {
        id: 777_000,
        is_bot: true,
        first_name: "Telegram",
      },
      text,
      entities: [
        {
          type: "mention",
          offset: 0,
          length: "@ParilkaBot".length,
        },
      ],
    }),
    OPTIONS,
  );

  assert.equal(result.addressed, true);
  assert.equal(result.reason, "username_mention");
  assert.equal(stored(result).senderId, "-100777");
  assert.equal(stored(result).senderName, "Новости парилки");
});

test("wrong chats and non-message updates are not ingestible", () => {
  const wrongChat = normalizeTelegramUpdate(
    botUpdate({
      chat: { id: -100_999, type: "supergroup" },
      text: "@ParilkaBot привет",
      entities: [
        {
          type: "mention",
          offset: 0,
          length: "@ParilkaBot".length,
        },
      ],
    }),
    OPTIONS,
  );
  const unsupported = normalizeTelegramUpdate(
    {
      update_id: 94,
      my_chat_member: {
        chat: { id: CHAT_ID, type: "supergroup" },
      },
    },
    OPTIONS,
  );

  assert.equal(wrongChat.ingest, false);
  assert.equal(wrongChat.addressed, false);
  assert.equal(wrongChat.reason, "chat_not_allowed");
  assert.equal(wrongChat.message, undefined);
  assert.equal(unsupported.ingest, false);
  assert.equal(unsupported.reason, "unsupported_update");
});

test("malformed messages and entities fail closed without throwing", () => {
  const missingUpdateId = normalizeTelegramUpdate(
    { message: baseMessage() },
    OPTIONS,
  );
  assert.equal(missingUpdateId.ingest, false);
  assert.equal(missingUpdateId.reason, "malformed_update");

  const negativeUpdateId = normalizeTelegramUpdate(
    { update_id: -1, message: baseMessage() },
    OPTIONS,
  );
  assert.equal(negativeUpdateId.ingest, false);
  assert.equal(negativeUpdateId.reason, "malformed_update");

  const malformedMessage = normalizeTelegramUpdate(
    { update_id: 95, message: { chat: { id: CHAT_ID } } },
    OPTIONS,
  );
  assert.equal(malformedMessage.ingest, false);
  assert.equal(malformedMessage.reason, "malformed_message");

  const text = "😀@ParilkaBot";
  const malformedEntities: unknown[] = [
    null,
    [],
    { type: "mention", offset: -1, length: 11 },
    { type: "mention", offset: 1.5, length: 11 },
    { type: "mention", offset: "2", length: 11 },
    { type: "mention", offset: 2, length: 0 },
    { type: "mention", offset: 2, length: 99 },
    { type: "mention", offset: 1, length: 11 },
    { type: "mention", offset: 0, length: 1 },
    {
      type: "text_mention",
      offset: 99,
      length: 1,
      user: { id: BOT_ID },
    },
  ];

  for (const entity of malformedEntities) {
    let result: NormalizedTelegramUpdate | undefined;
    assert.doesNotThrow(() => {
      result = normalizeTelegramUpdate(
        botUpdate({ text, entities: [entity] }),
        OPTIONS,
      );
    });
    assert.equal(result?.addressed, false);
    assert.equal(result?.reason, "not_addressed");
  }

  const validAfterMalformed = normalizeTelegramUpdate(
    botUpdate({
      text,
      entities: [
        { type: "mention", offset: -1, length: 11 },
        { type: "mention", offset: 2, length: 11 },
      ],
    }),
    OPTIONS,
  );
  assert.equal(validAfterMalformed.addressed, true);
});

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

    const valid = normalizeTelegramUpdate(
      botUpdate({
        message_id: 1_000 + sample,
        text,
        entities: [
          {
            type: "mention",
            offset: utf16Offset,
            length: "@ParilkaBot".length,
          },
        ],
      }),
      OPTIONS,
    );
    assert.equal(valid.addressed, true, `valid sample ${sample}`);

    const malformed = normalizeTelegramUpdate(
      botUpdate({
        message_id: 2_000 + sample,
        text,
        entities: [
          {
            type: "mention",
            offset: codePointOffset,
            length: "@ParilkaBot".length,
          },
        ],
      }),
      OPTIONS,
    );
    assert.equal(malformed.addressed, false, `malformed sample ${sample}`);
  }
});

function botUpdate(
  overrides: Record<string, unknown> = {},
): {
  update_id: number;
  message: Record<string, unknown>;
} {
  return {
    update_id: 91,
    message: baseMessage(overrides),
  };
}

function baseMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message_id: 17,
    date: 1_700_000_000,
    chat: {
      id: CHAT_ID,
      type: "supergroup",
      title: "Парилка",
    },
    from: {
      id: 123_456,
      is_bot: false,
      username: "billy",
      first_name: "Billy",
    },
    text: "обычное сообщение",
    ...overrides,
  };
}

function stored(result: NormalizedTelegramUpdate) {
  assert.equal(result.ingest, true);
  assert.ok(result.message);
  return result.message;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value =
      value + Math.imul(value ^ (value >>> 7), 61 | value) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
