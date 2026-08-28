import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotMediaError } from "../src/bot/media/contracts.js";
import {
  FfmpegFlacConverter,
  FlovAudioTranscriber,
  FlovHttpError,
  type AudioFlacConverter,
  type AudioWavConverter,
} from "../src/bot/media/flov-transcriber.js";

const converter: AudioFlacConverter = {
  async convert({ bytes }) {
    assert.deepEqual([...bytes], [7, 8]);
    return new Uint8Array([102, 76, 97, 67]);
  },
};

test("ffmpeg converts a tail-indexed MP4 through a bounded seekable input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-flov-tail-mp4-"));
  try {
    const source = join(directory, "tail-index.mp4");
    const fixture = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=160x160:r=25:d=4",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-c:a", "aac", "-shortest", source,
    ], { encoding: "utf8" });
    assert.equal(fixture.status, 0, fixture.stderr);

    const normalized = await new FfmpegFlacConverter().convert({
      bytes: readFileSync(source),
      signal: new AbortController().signal,
    });
    const decoded = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", "pipe:0", "-map", "0:a:0", "-f", "s16le", "pipe:1",
    ], { input: normalized, encoding: "buffer" });
    assert.equal(decoded.status, 0, decoded.stderr.toString("utf8"));
    // Four seconds of 16 kHz mono 16-bit PCM is 128 kB. A short lower bound
    // proves we did not accept ffmpeg's successful-but-truncated pipe output.
    assert.ok(decoded.stdout.byteLength > 100_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Flov client posts a complete in-memory FLAC as Flov's raw audio body", async () => {
  let body: Uint8Array | undefined;
  let contentType: string | undefined;
  let filename: string | undefined;
  let authorization: string | undefined;
  const transcriber = new FlovAudioTranscriber({
    converter,
    language: "ru",
    bearerToken: "local-test-token",
    async fetch(url, init) {
      assert.equal(
        String(url),
        "http://127.0.0.1:17432/v1/audio/transcriptions?response_format=json&postprocess=false&language=ru",
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      body = init?.body as Uint8Array;
      const headers = new Headers(init?.headers);
      contentType = headers.get("content-type") ?? undefined;
      filename = headers.get("x-filename") ?? undefined;
      authorization = headers.get("authorization") ?? undefined;
      return new Response(JSON.stringify({ text: "  готовый текст  " }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const text = await transcriber.transcribe(
    { data: new Uint8Array([7, 8]), mediaType: "audio/ogg", durationSeconds: 600 },
    new AbortController().signal,
  );
  assert.equal(text, "готовый текст");
  assert.deepEqual([...(body ?? [])], [102, 76, 97, 67]);
  assert.equal(contentType, "audio/flac");
  assert.equal(filename, "audio.flac");
  assert.equal(authorization, "Bearer local-test-token");
});

test("Flov rejects non-local endpoints and hides invalid service payload", async () => {
  assert.throws(
    () => new FlovAudioTranscriber({ endpoint: "http://example.test/v1/audio/transcriptions" }),
    /local/u,
  );
  const transcriber = new FlovAudioTranscriber({
    converter,
    async fetch() { return new Response(JSON.stringify({ text: 42 })); },
  });
  await assert.rejects(
    () => transcriber.transcribe({ data: new Uint8Array([7, 8]), mediaType: "audio/ogg", durationSeconds: 2 }, new AbortController().signal),
    (error: unknown) => error instanceof BotMediaError && error.code === "invalid_transcription",
  );
});

test("Flov classifies a bounded 4xx rejection without retaining its body", async () => {
  const fakeTranscript = `НЕ_ЛОГИРОВАТЬ_РАСШИФРОВКУ_${"x".repeat(2_000)}`;
  const transcriber = new FlovAudioTranscriber({
    converter,
    async fetch() {
      return new Response(JSON.stringify({
        error: { message: `audio decode failed: ${fakeTranscript}` },
      }), { status: 400 });
    },
  });

  await assert.rejects(
    () => transcriber.transcribe(
      { data: new Uint8Array([7, 8]), mediaType: "audio/ogg", durationSeconds: 2 },
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof FlovHttpError);
      assert.equal(error.code, "transcription_rejected");
      assert.equal(error.status, 400);
      assert.equal(error.reason, "audio_decode");
      assert.equal(error.sourceContainer, "other");
      assert.doesNotMatch(JSON.stringify(error), /НЕ_ЛОГИРОВАТЬ|x{40}/u);
      return true;
    },
  );
});

test("Flov retries only a rejected FLAC container with local PCM/WAV", async () => {
  const fallback: AudioWavConverter = {
    async convert({ bytes }) {
      assert.deepEqual([...bytes], [7, 8]);
      return new Uint8Array([82, 73, 70, 70]);
    },
  };
  const uploads: Array<{ type: string | null; filename: string | null; body: number[] }> = [];
  const transcriber = new FlovAudioTranscriber({
    converter,
    fallbackConverter: fallback,
    async fetch(_url, init) {
      const headers = new Headers(init?.headers);
      uploads.push({
        type: headers.get("content-type"),
        filename: headers.get("x-filename"),
        body: [...(init?.body as Uint8Array)],
      });
      if (uploads.length === 1) {
        return new Response(JSON.stringify({
          error: { message: "audio decode failed: unsupported or malformed audio container" },
        }), { status: 400 });
      }
      return new Response(JSON.stringify({ text: "готово" }));
    },
  });

  const text = await transcriber.transcribe(
    { data: new Uint8Array([7, 8]), mediaType: "video/mp4", durationSeconds: 2 },
    new AbortController().signal,
  );

  assert.equal(text, "готово");
  assert.deepEqual(uploads, [
    { type: "audio/flac", filename: "audio.flac", body: [102, 76, 97, 67] },
    { type: "audio/wav", filename: "audio.wav", body: [82, 73, 70, 70] },
  ]);
});

test("Flov keeps a no-samples decoder rejection without claiming the source was silent", async () => {
  const transcriber = new FlovAudioTranscriber({
    converter,
    fallbackConverter: {
      async convert() { return new Uint8Array([82, 73, 70, 70]); },
    },
    async fetch() {
      return new Response(JSON.stringify({
        error: { message: "audio decode failed: audio decoder produced no samples" },
      }), { status: 400 });
    },
  });

  await assert.rejects(
    () => transcriber.transcribe(
      { data: new Uint8Array([7, 8]), mediaType: "video/mp4", durationSeconds: 2 },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof FlovHttpError &&
      error.code === "transcription_rejected" &&
      error.reason === "audio_no_samples" &&
      !JSON.stringify(error).includes("produced no samples"),
  );
});

test("Flov keeps a no-samples WAV compatibility retry as a local rejection", async () => {
  const fallback: AudioWavConverter = {
    async convert() { return new Uint8Array([82, 73, 70, 70]); },
  };
  let calls = 0;
  const transcriber = new FlovAudioTranscriber({
    converter,
    fallbackConverter: fallback,
    async fetch() {
      calls += 1;
      return new Response(JSON.stringify({
        error: {
          message: calls === 1
            ? "audio decode failed: unsupported or malformed audio container"
            : "audio decode failed: audio decoder produced no samples",
        },
      }), { status: 400 });
    },
  });

  await assert.rejects(
    () => transcriber.transcribe(
      { data: new Uint8Array([7, 8]), mediaType: "video/mp4", durationSeconds: 2 },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof FlovHttpError &&
      error.code === "transcription_rejected" && error.reason === "audio_no_samples",
  );
});

test("Flov retries FLAC's no-samples decoder rejection as WAV before accepting a transcript", async () => {
  const fallback: AudioWavConverter = {
    async convert({ bytes }) {
      assert.deepEqual([...bytes], [7, 8]);
      return new Uint8Array([82, 73, 70, 70]);
    },
  };
  const contentTypes: string[] = [];
  const transcriber = new FlovAudioTranscriber({
    converter,
    fallbackConverter: fallback,
    async fetch(_url, init) {
      contentTypes.push(new Headers(init?.headers).get("content-type") ?? "");
      if (contentTypes.length === 1) {
        return new Response(JSON.stringify({
          error: { message: "audio decode failed: audio decoder produced no samples" },
        }), { status: 400 });
      }
      return new Response(JSON.stringify({ text: "готово" }));
    },
  });

  const text = await transcriber.transcribe(
    { data: new Uint8Array([7, 8]), mediaType: "video/mp4", durationSeconds: 2 },
    new AbortController().signal,
  );

  assert.equal(text, "готово");
  assert.deepEqual(contentTypes, ["audio/flac", "audio/wav"]);
});

test("Flov keeps 5xx as unavailable without reading a diagnostic body", async () => {
  const transcriber = new FlovAudioTranscriber({
    converter,
    async fetch() {
      return new Response("НЕ_ЛОГИРОВАТЬ_СЕРВИСНЫЙ_ТЕКСТ", { status: 503 });
    },
  });
  await assert.rejects(
    () => transcriber.transcribe(
      { data: new Uint8Array([7, 8]), mediaType: "audio/ogg", durationSeconds: 2 },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof BotMediaError && error.code === "transcription_unavailable",
  );
});

test("Flov rejects an unknown or over-limit duration before conversion", async () => {
  let conversions = 0;
  const transcriber = new FlovAudioTranscriber({
    converter: {
      async convert() {
        conversions += 1;
        return new Uint8Array([102, 76, 97, 67]);
      },
    },
    async fetch() {
      return new Response(JSON.stringify({ text: "never" }));
    },
  });
  const signal = new AbortController().signal;

  await assert.rejects(
    () => transcriber.transcribe({ data: new Uint8Array([7, 8]), mediaType: "audio/ogg" }, signal),
    (error: unknown) => error instanceof BotMediaError && error.code === "invalid_media",
  );
  await assert.rejects(
    () => transcriber.transcribe({ data: new Uint8Array([7, 8]), mediaType: "audio/ogg", durationSeconds: 601 }, signal),
    (error: unknown) => error instanceof BotMediaError && error.code === "invalid_media",
  );
  assert.equal(conversions, 0);
});

test("Flov accepts the same localhost aliases as runtime config and serializes local work", async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let maximumActive = 0;
  const transcriber = new FlovAudioTranscriber({
    endpoint: "http://flov.localhost:17432/v1/audio/transcriptions",
    converter,
    async fetch() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return new Response(JSON.stringify({ text: "готово" }));
    },
  });
  const first = transcriber.transcribe(
    { data: new Uint8Array([7, 8]), mediaType: "audio/ogg", durationSeconds: 2 },
    new AbortController().signal,
  );
  await waitFor(() => releases.length === 1);
  const second = transcriber.transcribe(
    { data: new Uint8Array([7, 8]), mediaType: "audio/ogg", durationSeconds: 2 },
    new AbortController().signal,
  );
  assert.equal(maximumActive, 1);
  assert.equal(releases.length, 1);
  releases.shift()?.();
  await waitFor(() => releases.length === 1);
  assert.equal(releases.length, 1);
  releases.shift()?.();
  await assert.doesNotReject(Promise.all([first, second]));
  assert.equal(maximumActive, 1);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for asynchronous Flov test state");
}
