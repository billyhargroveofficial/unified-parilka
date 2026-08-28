import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AudioTranscribeToolResult,
  BotMediaToolsPort,
  DirectAudioTranscriptionResult,
} from "../src/bot/media-tools.js";
import type { TelegramMediaTarget } from "../src/bot/media/contracts.js";
import type { StoredMessage } from "../src/store.js";
import {
  candidate,
  makeAgent,
  mockModel,
  request,
  response,
  storedMessage,
  toolCall,
  toolResponse,
} from "./support/ai-agent.js";

function mediaTarget(
  kind: TelegramMediaTarget["kind"],
  source: "trigger" | "reply" = "trigger",
): TelegramMediaTarget {
  const message: StoredMessage = {
    ...storedMessage(source === "reply" ? 99 : 100, "[медиа]", "42", "Коля"),
    rawJson: JSON.stringify({ [kind]: { file_id: "never-model-visible" } }),
  };
  return {
    kind,
    fileId: "never-model-visible",
    mediaType: kind === "photo" ? "image/jpeg" : "audio/ogg",
    source,
    message,
  };
}

function successToolResult(): AudioTranscribeToolResult {
  return {
    ok: true,
    tool: "audio_transcribe",
    status: "done",
    result: {
      source: "reply",
      transcript: "короткая расшифровка для модели",
      truncated: false,
    },
    evidence: [{
      source: "chat_message",
      chat: { id: "-1004242" },
      message: { id: 99 },
      speaker: { id: "42", name: "Коля" },
      date: null,
      text: "короткая расшифровка для модели",
    }],
  };
}

function mediaPort(options: {
  photo?: TelegramMediaTarget;
  audio?: TelegramMediaTarget;
  direct?: DirectAudioTranscriptionResult;
  tool?: AudioTranscribeToolResult;
}): BotMediaToolsPort & {
  resolveVisionCalls: number;
  directCalls: number;
  toolCalls: number;
} {
  let resolveVisionCalls = 0;
  let directCalls = 0;
  let toolCalls = 0;
  return {
    findPhoto: () => options.photo,
    findAudio: () => options.audio,
    async resolveVision() {
      resolveVisionCalls += 1;
      return {
        data: new Uint8Array([1, 2, 3]),
        mediaType: "image/jpeg",
        source: "trigger",
        messageId: 100,
      };
    },
    async transcribeAudio() {
      toolCalls += 1;
      return options.tool ?? successToolResult();
    },
    async transcribeAudioDirect() {
      directCalls += 1;
      return options.direct ?? {
        ok: true,
        source: "reply",
        transcript: "полная локальная расшифровка без облака",
      };
    },
    get resolveVisionCalls() {
      return resolveVisionCalls;
    },
    get directCalls() {
      return directCalls;
    },
    get toolCalls() {
      return toolCalls;
    },
  };
}

function fileParts(call: ReturnType<typeof mockModel>["doGenerateCalls"][number]): Array<{
  type: "file";
  data: Uint8Array;
  mediaType: string;
}> {
  const parts: Array<{ type: string; data?: unknown; mediaType?: unknown }> = [];
  if (!call) {
    return parts as Array<{ type: "file"; data: Uint8Array; mediaType: string }>;
  }
  for (const message of call.prompt) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      parts.push(part as { type: string; data?: unknown; mediaType?: unknown });
    }
  }
  return parts.flatMap((part) => {
    if (part.type !== "file") {
      return [];
    }
    const data = part.data as { type?: unknown; data?: unknown } | undefined;
    return data?.type === "data" && data.data instanceof Uint8Array &&
        typeof part.mediaType === "string"
      ? [{
          type: "file" as const,
          data: data.data,
          mediaType: part.mediaType,
        }]
      : [];
  });
}

test("vision-capable candidate receives only in-memory image bytes", async () => {
  const model = mockModel([response([{ type: "text", text: "вижу картинку" }], "stop")]);
  const media = mediaPort({ photo: mediaTarget("photo") });
  const fixture = makeAgent(
    [candidate("primary:vision", model, undefined, { vision: true })],
    { mediaTools: media },
  );

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "вижу картинку");
  assert.equal(media.resolveVisionCalls, 1);
  assert.deepEqual(fileParts(model.doGenerateCalls[0]), [{
    type: "file",
    data: new Uint8Array([1, 2, 3]),
    mediaType: "image/jpeg",
  }]);
  assert.doesNotMatch(JSON.stringify(model.doGenerateCalls[0]?.prompt), /never-model-visible/u);
});

test("text-only candidate neither downloads nor receives an image", async () => {
  const model = mockModel([response([{ type: "text", text: "не вижу" }], "stop")]);
  const media = mediaPort({ photo: mediaTarget("photo") });
  const fixture = makeAgent([candidate("primary:text", model)], { mediaTools: media });

  await fixture.agent.run(request());

  assert.equal(media.resolveVisionCalls, 0);
  assert.deepEqual(fileParts(model.doGenerateCalls[0]), []);
  assert.match(
    JSON.stringify(model.doGenerateCalls[0]?.prompt),
    /не поддерживает Vision/u,
  );
});

test("fallback to a text-only candidate drops a previously resolved image", async () => {
  const first = mockModel([Object.assign(new Error("network"), { code: "ECONNRESET" })]);
  const second = mockModel([response([{ type: "text", text: "текстовый fallback" }], "stop")]);
  const media = mediaPort({ photo: mediaTarget("photo") });
  const fixture = makeAgent([
    candidate("primary:vision", first, undefined, { vision: true }),
    candidate("backup:text", second, undefined, { vision: false }),
  ], { mediaTools: media });

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "текстовый fallback");
  assert.equal(media.resolveVisionCalls, 1);
  assert.deepEqual(fileParts(second.doGenerateCalls[0]), []);
});

test("explicit audio transcription stays local, returns the full text, and reports progress", async () => {
  const model = mockModel([response([{ type: "text", text: "не должен вызываться" }], "stop")]);
  const fullTranscript = `полная локальная расшифровка без облака ${"x".repeat(5_000)}`;
  const media = mediaPort({
    audio: mediaTarget("voice", "reply"),
    direct: {
      ok: true,
      source: "reply",
      transcript: fullTranscript,
    },
  });
  const fixture = makeAgent([candidate("primary:any", model)], { mediaTools: media });
  const events: string[] = [];

  const result = await fixture.agent.run(request({
    trigger: storedMessage(100, "@bot расшифруй", "42", "Коля"),
    toolProgressPort: {
      onToolStarted: (event) => { events.push(`start:${event.toolName}:${event.input?.source}`); },
      onToolCompleted: (event, ok) => { events.push(`end:${event.toolName}:${ok}`); },
    },
  }));

  assert.equal(result.responseOrigin, "local_audio");
  assert.match(result.text, /полная локальная расшифровка/u);
  assert.ok(result.text.endsWith(fullTranscript));
  assert.equal(model.doGenerateCalls.length, 0);
  assert.equal(media.directCalls, 1);
  assert.equal(media.toolCalls, 0);
  assert.deepEqual(events, [
    "start:audio_transcribe:reply",
    "end:audio_transcribe:true",
  ]);
  assert.equal(result.telemetry.finalProviderId, "local");
  assert.doesNotMatch(JSON.stringify(fixture.logs), /полная локальная|never-model-visible/u);
});

test("explicit local transcription turns a Flov failure into a user-visible reply without provider call", async () => {
  const model = mockModel([response([{ type: "text", text: "не должен вызываться" }], "stop")]);
  const media = mediaPort({
    audio: mediaTarget("voice", "reply"),
    direct: {
      ok: false,
      tool: "audio_transcribe",
      error: {
        code: "transcription_unavailable",
        retryable: true,
        message: "internal only",
      },
      evidence: [],
    },
  });
  const fixture = makeAgent([candidate("primary:any", model)], { mediaTools: media });

  const result = await fixture.agent.run(request({
    trigger: storedMessage(100, "@bot расшифруй", "42", "Коля"),
  }));

  assert.equal(result.responseOrigin, "local_audio");
  assert.match(result.text, /распознаватель сейчас недоступен/u);
  assert.equal(model.doGenerateCalls.length, 0);
});

test("an unreadable addressed video note gets a precise local error without provider call", async () => {
  const model = mockModel([response([{ type: "text", text: "не должен вызываться" }], "stop")]);
  const media = mediaPort({
    audio: mediaTarget("video_note", "reply"),
    direct: {
      ok: false,
      tool: "audio_transcribe",
      error: {
        code: "no_audio",
        retryable: false,
        message: "internal only",
      },
      evidence: [],
    },
  });
  const fixture = makeAgent([candidate("primary:any", model)], { mediaTools: media });

  const result = await fixture.agent.run(request({
    trigger: storedMessage(100, "@bot расшифруй", "42", "Коля"),
  }));

  assert.equal(result.responseOrigin, "local_audio");
  assert.match(result.text, /Не удалось извлечь аудиодорожку/u);
  assert.equal(model.doGenerateCalls.length, 0);
});

test("explicit transcription without eligible audio returns a local error without provider call", async () => {
  const model = mockModel([response([{ type: "text", text: "не должен вызываться" }], "stop")]);
  const media = mediaPort({});
  const fixture = makeAgent([candidate("primary:any", model)], { mediaTools: media });

  const result = await fixture.agent.run(request({
    trigger: storedMessage(100, "@bot расшифруй", "42", "Коля"),
  }));

  assert.equal(result.responseOrigin, "local_audio");
  assert.match(result.text, /нужен голосовой, кружок или аудиофайл/u);
  assert.equal(model.doGenerateCalls.length, 0);
  assert.equal(media.directCalls, 0);
  assert.equal(media.toolCalls, 0);
  assert.equal(result.telemetry.finalProviderId, "local");
});

test("a broader audio question exposes the zero-argument local tool to the model", async () => {
  const model = mockModel([
    toolResponse([toolCall("audio-1", "audio_transcribe", {})]),
    response([{ type: "text", text: "в голосовом сказали главное" }], "stop"),
  ]);
  const media = mediaPort({ audio: mediaTarget("voice", "reply") });
  const fixture = makeAgent([candidate("primary:any", model)], { mediaTools: media });

  const result = await fixture.agent.run(request({
    trigger: storedMessage(100, "@bot что в этом голосовом важного?", "42", "Коля"),
  }));

  assert.equal(result.text, "в голосовом сказали главное");
  assert.equal(media.directCalls, 0);
  assert.equal(media.toolCalls, 1);
  assert.match(JSON.stringify(model.doGenerateCalls[1]?.prompt), /короткая расшифровка для модели/u);
});

test("model-facing transcription has no whole-turn time reserve", async () => {
  const model = mockModel([
    toolResponse([toolCall("audio-1", "audio_transcribe", {})]),
    response([{ type: "text", text: "времени на расшифровку уже нет" }], "stop"),
  ]);
  const media = mediaPort({ audio: mediaTarget("voice", "reply") });
  const fixture = makeAgent(
    [candidate("primary:any", model)],
    { mediaTools: media },
  );

  const result = await fixture.agent.run(request({
    trigger: storedMessage(100, "@bot что в этом голосовом важного?", "42", "Коля"),
  }));

  assert.equal(result.text, "времени на расшифровку уже нет");
  assert.equal(media.toolCalls, 1);
  assert.equal(model.doGenerateCalls.length, 2);
  assert.doesNotMatch(JSON.stringify(fixture.logs), /"errorCode":"timeout"/u);
});
