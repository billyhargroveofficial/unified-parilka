import assert from "node:assert/strict";
import { test } from "node:test";
import { BotMediaTools, flovRejectionDiagnostic } from "../src/bot/media-tools.js";
import type { AudioFlacConverter } from "../src/bot/media/flov-transcriber.js";
import { FlovAudioTranscriber } from "../src/bot/media/flov-transcriber.js";
import { TelegramMediaDownloader } from "../src/bot/media/telegram-downloader.js";
import type { StoredMessage } from "../src/store.js";

function stored(rawJson: unknown, messageId = 10): StoredMessage {
  return {
    chatId: "-100",
    messageId,
    text: "",
    rawJson: JSON.stringify(rawJson),
  };
}

function makeTools(options: {
  bytes: Uint8Array;
  response?: unknown;
  responseStatus?: number;
  responseBody?: string;
  onDownload?: () => void;
}): BotMediaTools {
  const downloader = new TelegramMediaDownloader({
    async getFile() {
      options.onDownload?.();
      return { filePath: "voice/file.oga", fileSize: options.bytes.byteLength };
    },
    fileUrl: (path) => `https://telegram.invalid/${path}`,
    async fetch() {
      return new Response(options.bytes as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "audio/ogg" },
      });
    },
  });
  const converter: AudioFlacConverter = {
    async convert({ bytes }) {
      assert.deepEqual([...bytes], [...options.bytes]);
      return new Uint8Array([82, 73, 70, 70]);
    },
  };
  const transcriber = new FlovAudioTranscriber({
    converter,
    async fetch() {
      return new Response(options.responseBody ?? JSON.stringify(options.response ?? { text: "готовый текст" }), {
        status: options.responseStatus,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return new BotMediaTools({ downloader, transcriber });
}

test("Vision resolves only the selected Telegram photo into in-memory image bytes", async () => {
  const tools = makeTools({ bytes: new Uint8Array([1, 2, 3]) });
  const trigger = stored({
    photo: [{
      file_id: "photo_secret_reference",
      width: 100,
      height: 80,
      file_size: 3,
    }],
  });
  const target = tools.findPhoto(trigger);
  assert.ok(target);

  const image = await tools.resolveVision(target, new AbortController().signal);
  assert.deepEqual([...image.data], [1, 2, 3]);
  assert.equal(image.mediaType, "image/jpeg");
  assert.equal(image.source, "trigger");
  assert.equal(image.messageId, 10);
  assert.doesNotMatch(JSON.stringify(image), /photo_secret_reference/u);
});

test("Flov 4xx becomes a nonretryable local failure without serializing its body", async () => {
  const hidden = "НЕ_ПОКАЗЫВАТЬ_АУДИО_ТЕКСТ";
  const tools = makeTools({
    bytes: new Uint8Array([7, 8]),
    responseStatus: 400,
    responseBody: `audio decode failed: ${hidden}`,
  });
  const target = tools.findAudio(stored({
    video_note: { file_id: "video_note_reference", duration: 3 },
  }));
  assert.ok(target);

  const result = await tools.transcribeAudio(target, new AbortController().signal);
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected local rejection");
  }
  assert.equal(result.error.code, "transcription_rejected");
  assert.equal(result.error.retryable, false);
  assert.deepEqual(flovRejectionDiagnostic(result), {
    flovStatus: 400,
    flovReason: "audio_decode",
    flovSourceContainer: "other",
  });
  assert.doesNotMatch(JSON.stringify(result), /НЕ_ПОКАЗЫВАТЬ|video_note_reference/u);
});

test("audio transcription uses only a direct inline reply and returns attributable bounded text", async () => {
  const tools = makeTools({ bytes: new Uint8Array([7, 8]) });
  const trigger = stored({
    text: "@bot расшифруй",
    reply_to_message: {
      message_id: 9,
      chat: { id: -100 },
      from: { id: 42, username: "kolya" },
      voice: {
        file_id: "voice_secret_reference",
        duration: 3,
        mime_type: "audio/ogg",
      },
    },
  });
  const target = tools.findAudio(trigger);
  assert.ok(target);
  assert.equal(target.source, "reply");

  const result = await tools.transcribeAudio(target, new AbortController().signal);
  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected transcription success");
  }
  assert.equal(result.result.transcript, "готовый текст");
  assert.equal(result.result.source, "reply");
  assert.deepEqual(result.evidence, [{
    source: "chat_message",
    chat: { id: "-100" },
    message: { id: 9 },
    speaker: { id: "42", name: "kolya" },
    date: null,
    text: "готовый текст",
  }]);
  assert.doesNotMatch(JSON.stringify(result), /voice_secret_reference/u);
});

test("audio with unknown or over-limit duration is rejected before Telegram download", async () => {
  let downloads = 0;
  const tools = makeTools({
    bytes: new Uint8Array([7, 8]),
    onDownload: () => { downloads += 1; },
  });
  const trigger = stored({
    voice: {
      file_id: "voice_over_limit",
      duration: 601,
      mime_type: "audio/ogg",
    },
  });
  const target = tools.findAudio(trigger);
  assert.ok(target);

  const result = await tools.transcribeAudio(target, new AbortController().signal);
  assert.deepEqual(result, {
    ok: false,
    tool: "audio_transcribe",
    error: {
      code: "invalid_media",
      retryable: false,
      message: "Не удалось расшифровать адресное аудио локально.",
    },
    evidence: [],
  });
  assert.equal(downloads, 0);

  const missingDuration = tools.findAudio(stored({
    audio: { file_id: "audio_unknown_duration", mime_type: "audio/mpeg" },
  }));
  assert.ok(missingDuration);
  const unknownResult = await tools.transcribeAudio(
    missingDuration,
    new AbortController().signal,
  );
  assert.equal(unknownResult.ok, false);
  assert.equal(downloads, 0);
});
