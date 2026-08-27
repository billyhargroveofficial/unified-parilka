import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import type { StoredMessage } from "../src/store.js";
import {
  BotImageMediaError,
  TelegramImageDownloader,
  parseStoredTelegramImage,
  selectTelegramImageTarget,
} from "../src/bot/media/index.js";
import { BotMediaTools } from "../src/bot/media-tools.js";

function stored(rawJson: unknown, messageId = 10): StoredMessage {
  return { chatId: "-100", messageId, text: "", rawJson: JSON.stringify(rawJson) };
}

async function png(): Promise<Buffer> {
  return await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#ff00ff" },
  }).png().toBuffer();
}

test("image parser chooses the largest photo and accepts only declared image documents", () => {
  assert.deepEqual(parseStoredTelegramImage(stored({
    photo: [
      { file_id: "small", width: 2, height: 2, file_size: 10 },
      { file_id: "large", width: 5, height: 4, file_size: 20 },
      { file_id: "unsafe/path", width: 100, height: 100 },
    ],
  })), {
    kind: "photo", fileId: "large", mediaType: "image/jpeg", fileSize: 20, width: 5, height: 4,
  });
  assert.deepEqual(parseStoredTelegramImage(stored({
    document: { file_id: "document_1", mime_type: "image/webp", file_size: 42 },
  })), {
    kind: "document", fileId: "document_1", mediaType: "image/webp", fileSize: 42,
  });
  assert.equal(parseStoredTelegramImage(stored({
    document: { file_id: "not_an_image", mime_type: "application/pdf" },
  })), undefined);
});

test("image selection is limited to trigger or one embedded same-chat reply", () => {
  const trigger = stored({
    text: "@bot что тут?",
    reply_to_message: {
      message_id: 9,
      chat: { id: -100 },
      from: { id: 42, username: "kolya" },
      document: { file_id: "reply_image", mime_type: "image/png", file_size: 3 },
    },
  }, 10);
  const selected = selectTelegramImageTarget(trigger);
  assert.equal(selected?.source, "reply");
  assert.equal(selected?.message.messageId, 9);
  assert.equal(selected?.fileId, "reply_image");
  assert.equal(selectTelegramImageTarget(stored({
    reply_to_message: {
      message_id: 9, chat: { id: -101 },
      photo: [{ file_id: "other_chat_photo" }],
    },
  })), undefined);
});

test("downloader produces a bounded Responses data URL after decoded MIME validation", async () => {
  const bytes = await png();
  let observedFileId = "";
  let observedPath = "";
  const downloader = new TelegramImageDownloader({
    api: {
      async getFile(fileId) {
        observedFileId = fileId;
        return { filePath: "documents/image.png", fileSize: bytes.byteLength };
      },
      async downloadFile(filePath) {
        observedPath = filePath;
        return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });
      },
    },
  });
  const result = await downloader.download({
    kind: "document", fileId: "private_file_id", mediaType: "image/png", fileSize: bytes.byteLength,
  }, new AbortController().signal);
  assert.equal(observedFileId, "private_file_id");
  assert.equal(observedPath, "documents/image.png");
  assert.match(result.dataUrl, /^data:image\/png;base64,/u);
  assert.equal(JSON.stringify(result).includes("private_file_id"), false);
  assert.equal(JSON.stringify(result).includes("documents/image.png"), false);
});

test("downloader rejects an unsafe path, declared MIME mismatch, and a pixel bomb without revealing identifiers", async () => {
  const image = await png();
  const cases = [
    {
      getFile: async () => ({ filePath: "../secret", fileSize: image.byteLength }),
      downloadFile: async () => new Response(new Uint8Array(image)),
      media: { kind: "document" as const, fileId: "hidden_a", mediaType: "image/png" as const, fileSize: image.byteLength },
    },
    {
      getFile: async () => ({ filePath: "safe/image", fileSize: image.byteLength }),
      downloadFile: async () => new Response(new Uint8Array(image), { headers: { "content-type": "image/jpeg" } }),
      media: { kind: "document" as const, fileId: "hidden_b", mediaType: "image/png" as const, fileSize: image.byteLength },
    },
  ];
  for (const item of cases) {
    const downloader = new TelegramImageDownloader({ api: item });
    await assert.rejects(
      () => downloader.download(item.media, new AbortController().signal),
      (error: unknown) => error instanceof BotImageMediaError &&
        error.code === "invalid_media" && !error.message.includes(item.media.fileId),
    );
  }
  const bomb = await sharp({
    create: { width: 8_000, height: 8_000, channels: 3, background: "#000000" },
  }).png().toBuffer();
  const downloader = new TelegramImageDownloader({
    api: {
      async getFile() { return { filePath: "safe/bomb.png", fileSize: bomb.byteLength }; },
      async downloadFile() { return new Response(new Uint8Array(bomb)); },
    },
  });
  await assert.rejects(
    () => downloader.download({ kind: "document", fileId: "hidden_bomb", mediaType: "image/png", fileSize: bomb.byteLength }, new AbortController().signal),
    (error: unknown) => error instanceof BotImageMediaError && error.code === "download_failed",
  );
});

test("host media tool returns in-memory data URLs and brackets progress safely", async () => {
  const bytes = await png();
  const tools = new BotMediaTools({
    async getFile() { return { filePath: "safe/image.png", fileSize: bytes.byteLength }; },
    async downloadFile() { return new Response(new Uint8Array(bytes)); },
  });
  const progress: string[] = [];
  const images = await tools.resolveImages({
    trigger: stored({ document: { file_id: "never_visible", mime_type: "image/png", file_size: bytes.byteLength } }),
    signal: new AbortController().signal,
    toolProgressPort: {
      onToolStarted: (event) => { progress.push(`start:${event.toolName}`); },
      onToolCompleted: (event, ok) => { progress.push(`end:${event.toolName}:${String(ok)}`); },
    },
  });
  assert.equal(images.length, 1);
  assert.match(images[0]!.dataUrl, /^data:image\/png;base64,/u);
  assert.deepEqual(progress, ["start:загрузка изображения", "end:загрузка изображения:true"]);
  assert.equal(JSON.stringify(images).includes("never_visible"), false);
  const target = tools.findImage(stored({
    document: { file_id: "another_private_id", mime_type: "image/png", file_size: bytes.byteLength },
  }));
  assert.ok(target);
  await assert.rejects(
    () => tools.resolveImageTargets({
      targets: [target, target, target, target, target],
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof BotImageMediaError && error.code === "file_too_large",
  );
});
