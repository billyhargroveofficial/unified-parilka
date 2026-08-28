import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredMessage } from "../src/store.js";
import { BotMediaError } from "../src/bot/media/contracts.js";
import {
  parseStoredTelegramMedia,
  selectTelegramMediaTarget,
} from "../src/bot/media/telegram-media.js";
import { TelegramMediaDownloader } from "../src/bot/media/telegram-downloader.js";

function stored(rawJson: unknown, messageId = 10): StoredMessage {
  return { chatId: "-100", messageId, text: "", rawJson: JSON.stringify(rawJson) };
}

test("media parser selects the largest valid Bot API photo only", () => {
  const result = parseStoredTelegramMedia(stored({
    photo: [
      { file_id: "small_1", width: 50, height: 50, file_size: 80 },
      { file_id: "invalid/identifier", width: 5_000, height: 5_000 },
      { file_id: "large_2", width: 800, height: 600, file_size: 1234 },
    ],
  }));

  assert.deepEqual(result, {
    kind: "photo",
    fileId: "large_2",
    mediaType: "image/jpeg",
    fileSize: 1234,
    width: 800,
    height: 600,
  });
});

test("media target permits trigger or its direct reply, never malformed raw JSON", () => {
  const trigger = stored({ text: "@bot расшифруй" }, 20);
  const reply = stored({ voice: { file_id: "voice_1", duration: 4, mime_type: "audio/ogg" } }, 19);
  assert.deepEqual(selectTelegramMediaTarget(trigger, reply), {
    kind: "voice",
    fileId: "voice_1",
    mediaType: "audio/ogg",
    mimeType: "audio/ogg",
    durationSeconds: 4,
    source: "reply",
    message: reply,
  });
  assert.equal(parseStoredTelegramMedia({ rawJson: "{" }), undefined);
  assert.equal(parseStoredTelegramMedia({ rawJson: "x".repeat(2_000_001) }), undefined);
});

test("media parser accepts the full durable Bot API update limit", () => {
  const result = parseStoredTelegramMedia(stored({
    padding: "x".repeat(1_200_000),
    voice: { file_id: "voice_large_raw", duration: 600, mime_type: "audio/ogg" },
  }));
  assert.deepEqual(result, {
    kind: "voice",
    fileId: "voice_large_raw",
    mediaType: "audio/ogg",
    mimeType: "audio/ogg",
    durationSeconds: 600,
  });
});

test("media target recovers the one embedded same-chat reply for privacy-mode delivery", () => {
  const trigger = stored({
    text: "@bot расшифруй",
    reply_to_message: {
      message_id: 19,
      date: 1_780_000_000,
      chat: { id: -100 },
      from: { id: 42, username: "kolya" },
      voice: {
        file_id: "voice_inline_1",
        duration: 4,
        mime_type: "audio/ogg",
      },
    },
  }, 20);

  const target = selectTelegramMediaTarget(trigger);
  assert.equal(target?.source, "reply");
  assert.equal(target?.kind, "voice");
  assert.equal(target?.fileId, "voice_inline_1");
  assert.equal(target?.message.messageId, 19);
  assert.equal(target?.message.chatId, "-100");
  assert.equal(target?.message.senderName, "kolya");

  const otherChat = stored({
    reply_to_message: {
      message_id: 19,
      chat: { id: -101 },
      voice: { file_id: "cross_chat", duration: 4 },
    },
  }, 21);
  assert.equal(selectTelegramMediaTarget(otherChat), undefined);
});

test("downloader validates metadata and bounds streamed Telegram media", async () => {
  let observedPath = "";
  const downloader = new TelegramMediaDownloader({
    async getFile(_fileId, signal) {
      assert.equal(signal.aborted, false);
      return { filePath: "voice/file.oga", fileSize: 3 };
    },
    fileUrl(path) {
      observedPath = path;
      return `https://telegram.invalid/${path}`;
    },
    async fetch(_url, init) {
      assert.equal(init?.redirect, "error");
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/ogg" },
      });
    },
  });

  const result = await downloader.download({
    kind: "voice", fileId: "voice_1", mediaType: "audio/ogg", fileSize: 3,
  }, new AbortController().signal);
  assert.equal(observedPath, "voice/file.oga");
  assert.deepEqual([...result.data], [1, 2, 3]);
  assert.equal(result.mediaType, "audio/ogg");

  const tooSmall = new TelegramMediaDownloader({
    async getFile() { return { filePath: "voice/file.oga" }; },
    fileUrl() { return "https://telegram.invalid/file"; },
    async fetch() { return new Response(new Uint8Array(1_025)); },
    maxBytes: 1_024,
  });
  await assert.rejects(
    () => tooSmall.download({ kind: "voice", fileId: "voice_2", mediaType: "audio/ogg" }, new AbortController().signal),
    (error: unknown) => error instanceof BotMediaError && error.code === "file_too_large" && !error.message.includes("voice_2"),
  );
});

test("downloader never sends unsafe Bot API paths to its URL factory", async () => {
  let built = false;
  const downloader = new TelegramMediaDownloader({
    async getFile() { return { filePath: "../private" }; },
    fileUrl() { built = true; return "https://telegram.invalid/file"; },
    async fetch() { return new Response(); },
  });
  await assert.rejects(
    () => downloader.download({ kind: "audio", fileId: "audio_1", mediaType: "audio/mpeg" }, new AbortController().signal),
    (error: unknown) => error instanceof BotMediaError && error.code === "invalid_media",
  );
  assert.equal(built, false);
});

test("downloader rejects a silently truncated Bot API file before conversion", async () => {
  const downloader = new TelegramMediaDownloader({
    async getFile() { return { filePath: "video/file.mp4", fileSize: 8 }; },
    fileUrl() { return "https://telegram.invalid/file"; },
    async fetch() { return new Response(new Uint8Array([0, 1, 2, 3])); },
  });

  await assert.rejects(
    () => downloader.download(
      { kind: "video_note", fileId: "video_1", mediaType: "video/mp4", fileSize: 8 },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof BotMediaError && error.code === "download_failed",
  );
});

test("downloader preserves the stored Bot API file size when getFile omits it", async () => {
  const downloader = new TelegramMediaDownloader({
    async getFile() { return { filePath: "video/file.mp4" }; },
    fileUrl() { return "https://telegram.invalid/file"; },
    async fetch() { return new Response(new Uint8Array([0, 1, 2, 3])); },
  });

  await assert.rejects(
    () => downloader.download(
      { kind: "video_note", fileId: "video_1", mediaType: "video/mp4", fileSize: 8 },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof BotMediaError && error.code === "download_failed" &&
      !error.message.includes("video_1"),
  );
});

test("downloader rejects Bot API metadata that points at a different-size file", async () => {
  let fetched = false;
  const downloader = new TelegramMediaDownloader({
    async getFile() { return { filePath: "video/file.mp4", fileSize: 7 }; },
    fileUrl() { return "https://telegram.invalid/file"; },
    async fetch() { fetched = true; return new Response(new Uint8Array(7)); },
  });

  await assert.rejects(
    () => downloader.download(
      { kind: "video_note", fileId: "video_1", mediaType: "video/mp4", fileSize: 8 },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof BotMediaError && error.code === "download_failed" &&
      !error.message.includes("video_1"),
  );
  assert.equal(fetched, false);
});
