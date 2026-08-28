import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotMediaError } from "./contracts.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:17432/v1/audio/transcriptions";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_NORMALIZED_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_REJECTION_BODY_BYTES = 512;

/** A deliberately coarse, non-user-controlled classification of a Flov 4xx. */
export type FlovRejectionReason =
  | "audio_decode"
  | "audio_container"
  | "audio_no_samples"
  | "audio_too_short"
  | "audio_duration"
  | "audio_packet"
  | "multipart"
  | "invalid_option"
  | "request_invalid"
  | "other_4xx";

/** Coarse magic-only label for operational debugging; never a file id or URL. */
export type FlovSourceContainer = "mp4" | "ogg" | "riff" | "jpeg" | "png" | "other";

/**
 * Safe diagnostic metadata for an explicitly rejected local request. Its
 * body is discarded after classification and must never reach a model or log.
 */
export class FlovHttpError extends BotMediaError {
  readonly status: number;
  readonly reason: FlovRejectionReason;
  readonly sourceContainer: FlovSourceContainer;

  constructor(status: number, reason: FlovRejectionReason, sourceContainer: FlovSourceContainer) {
    super("transcription_rejected", "Audio transcription request was rejected.");
    this.name = "FlovHttpError";
    this.status = status;
    this.reason = reason;
    this.sourceContainer = sourceContainer;
  }
}

/** Produces a seekable, lossless FLAC container for Flov's decoder. */
export interface AudioFlacConverter {
  convert(request: { bytes: Uint8Array; signal: AbortSignal }): Promise<Uint8Array>;
}

/** A compatibility output for Flov builds whose FLAC probe rejects an input. */
export interface AudioWavConverter {
  convert(request: { bytes: Uint8Array; signal: AbortSignal }): Promise<Uint8Array>;
}

export interface FlovAudioTranscriberOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  converter?: AudioFlacConverter;
  fallbackConverter?: AudioWavConverter;
  timeoutMs?: number;
  language?: string;
  bearerToken?: string;
}

/**
 * Local-only Flov client. It normalizes Telegram payloads to one complete,
 * lossless FLAC buffer and sends it as Flov's documented raw-audio request
 * body. A local PCM/WAV retry is used only if Flov explicitly rejects the
 * FLAC container. Conversion uses a private, bounded, seekable temporary
 * input because Telegram MP4 files can put their index at the end; ffmpeg's
 * non-seekable stdin path may then silently emit a truncated stream despite a
 * successful exit status. The private directory is removed before this method
 * returns and no source recording is persisted by the application.
 */
export class FlovAudioTranscriber {
  readonly #endpoint: URL;
  readonly #fetch: typeof fetch;
  readonly #converter: AudioFlacConverter;
  readonly #fallbackConverter: AudioWavConverter;
  readonly #timeoutMs: number;
  readonly #language: string | undefined;
  readonly #bearerToken: string | undefined;
  readonly #gate = new AsyncExclusiveGate();

  constructor(options: FlovAudioTranscriberOptions = {}) {
    this.#endpoint = localEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.#fetch = options.fetch ?? fetch;
    this.#converter = options.converter ?? new FfmpegFlacConverter();
    this.#fallbackConverter = options.fallbackConverter ?? new FfmpegWavConverter();
    this.#timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#language = validLanguage(options.language);
    this.#bearerToken = validBearerToken(options.bearerToken);
  }

  async transcribe(
    request: { data: Uint8Array; mediaType: string; durationSeconds?: number },
    externalSignal: AbortSignal,
  ): Promise<string> {
    if (request.data.byteLength === 0 || request.data.byteLength > MAX_SOURCE_BYTES) {
      throw new BotMediaError("invalid_media", "The supplied audio is invalid.");
    }
    if (!validMediaType(request.mediaType)) {
      throw new BotMediaError("invalid_media", "The supplied audio is invalid.");
    }
    if (!validDuration(request.durationSeconds)) {
      throw new BotMediaError("invalid_media", "The supplied audio duration is invalid.");
    }
    if (externalSignal.aborted) {
      throw abortedError();
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([externalSignal, timeout]);
    const sourceContainer = classifySourceContainer(request.data);
    try {
      return await this.#gate.run(signal, async () => {
        const flac = await this.#converter.convert({ bytes: request.data, signal });
        assertNormalizedAudio(flac);
        try {
          return await this.#requestTranscription(flac, "audio/flac", "audio.flac", sourceContainer, signal);
        } catch (error) {
          if (
            !(error instanceof FlovHttpError) ||
            (error.reason !== "audio_container" && error.reason !== "audio_no_samples")
          ) {
            throw error;
          }
          // Flov explicitly documents PCM/WAV alongside FLAC. Its FLAC
          // decoder can also reject a stream before yielding its first
          // sample. That is a decoder result, not evidence that the original
          // Telegram recording was silent, so retry locally as WAV and retain
          // an explicit local rejection if it fails again.
          const wav = await this.#fallbackConverter.convert({ bytes: request.data, signal });
          assertNormalizedAudio(wav);
          return await this.#requestTranscription(wav, "audio/wav", "audio.wav", sourceContainer, signal);
        }
      });
    } catch (error) {
      if (externalSignal.aborted) {
        throw abortedError();
      }
      if (timeout.aborted) {
        throw new BotMediaError("transcription_timeout", "Audio transcription timed out.");
      }
      if (error instanceof BotMediaError) {
        throw error;
      }
      throw new BotMediaError("transcription_failed", "Audio transcription failed.");
    }
  }

  async #requestTranscription(
    audio: Uint8Array,
    contentType: "audio/flac" | "audio/wav",
    filename: "audio.flac" | "audio.wav",
    sourceContainer: FlovSourceContainer,
    signal: AbortSignal,
  ): Promise<string> {
    const endpoint = new URL(this.#endpoint);
    endpoint.searchParams.set("response_format", "json");
    endpoint.searchParams.set("postprocess", "false");
    if (this.#language) {
      endpoint.searchParams.set("language", this.#language);
    }
    const response = await this.#fetch(endpoint, {
      method: "POST",
      body: audio,
      signal,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": contentType,
        "X-Filename": filename,
        ...(this.#bearerToken === undefined
          ? {}
          : { Authorization: `Bearer ${this.#bearerToken}` }),
      },
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status <= 499) {
        const reason = response.body === null
          ? "other_4xx"
          : classifyFlovRejection(await readBodyPrefix(response.body, MAX_REJECTION_BODY_BYTES, signal));
        throw new FlovHttpError(response.status, reason, sourceContainer);
      }
      throw new BotMediaError("transcription_unavailable", "Audio transcription is unavailable.");
    }
    if (!response.body) {
      throw new BotMediaError("transcription_unavailable", "Audio transcription is unavailable.");
    }
    const payload = await readJsonBounded(response.body, signal);
    const text = transcriptText(payload);
    if (text === undefined) {
      throw new BotMediaError("invalid_transcription", "Audio transcription returned an invalid result.");
    }
    return text;
  }
}

function assertNormalizedAudio(audio: Uint8Array): void {
  if (audio.byteLength === 0 || audio.byteLength > MAX_NORMALIZED_BYTES) {
    throw new BotMediaError("conversion_failed", "Audio conversion failed.");
  }
}

function classifySourceContainer(bytes: Uint8Array): FlovSourceContainer {
  if (bytes.byteLength >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "mp4";
  }
  if (hasBytes(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return "ogg";
  }
  if (hasBytes(bytes, [0x52, 0x49, 0x46, 0x46])) {
    return "riff";
  }
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return "png";
  }
  return "other";
}

function hasBytes(value: Uint8Array, expected: readonly number[]): boolean {
  return value.byteLength >= expected.length && expected.every((byte, index) => value[index] === byte);
}

function validMediaType(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value);
}

function validDuration(value: number | undefined): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 600;
}

export class FfmpegFlacConverter implements AudioFlacConverter {
  async convert(request: { bytes: Uint8Array; signal: AbortSignal }): Promise<Uint8Array> {
    return ffmpegConvert(request, ["-c:a", "flac", "-f", "flac", "pipe:1"]);
  }
}

export class FfmpegWavConverter implements AudioWavConverter {
  async convert(request: { bytes: Uint8Array; signal: AbortSignal }): Promise<Uint8Array> {
    return ffmpegConvert(request, ["-c:a", "pcm_s16le", "-f", "wav", "pipe:1"]);
  }
}

async function ffmpegConvert(
  request: { bytes: Uint8Array; signal: AbortSignal },
  outputArguments: readonly string[],
): Promise<Uint8Array> {
  if (
    request.signal.aborted ||
    request.bytes.byteLength === 0 ||
    request.bytes.byteLength > MAX_SOURCE_BYTES
  ) {
    throw request.signal.aborted
      ? abortedError()
      : new BotMediaError("conversion_failed", "Audio conversion failed.");
  }
  const input = await createSeekableInput(request.bytes, request.signal);
  try {
    return await runFfmpegConversion(input.path, request.signal, outputArguments);
  } finally {
    await removeSeekableInput(input.directory);
  }
}

async function createSeekableInput(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<{ directory: string; path: string }> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "parilka-flov-"));
    await chmod(directory, 0o700);
    if (signal.aborted) {
      throw abortedError();
    }
    const path = join(directory, "audio-input");
    await writeFile(path, bytes, { encoding: undefined, mode: 0o600, flag: "wx" });
    if (signal.aborted) {
      throw abortedError();
    }
    return { directory, path };
  } catch (error) {
    if (directory !== undefined) {
      try {
        await removeSeekableInput(directory);
      } catch {
        throw new BotMediaError("conversion_failed", "Audio conversion failed.");
      }
    }
    throw error instanceof BotMediaError
      ? error
      : new BotMediaError("conversion_failed", "Audio conversion failed.");
  }
}

async function removeSeekableInput(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch {
    // Keeping user audio on disk is worse than failing this local tool call.
    throw new BotMediaError("conversion_failed", "Audio conversion failed.");
  }
}

function runFfmpegConversion(
  inputPath: string,
  signal: AbortSignal,
  outputArguments: readonly string[],
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let overflowed = false;
    let child: ReturnType<typeof spawn> | undefined;
    const chunks: Buffer[] = [];
    let length = 0;
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const fail = (error: BotMediaError): void => settle(() => reject(error));
    const onAbort = (): void => {
      child?.kill("SIGKILL");
    };
    try {
      child = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", inputPath, "-map", "0:a:0?", "-vn",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-ac", "1", "-ar", "16000",
        ...outputArguments,
      ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      fail(new BotMediaError("conversion_failed", "Audio conversion failed."));
      return;
    }
    const stdout = child.stdout;
    if (!stdout) {
      child.kill("SIGKILL");
      fail(new BotMediaError("conversion_failed", "Audio conversion failed."));
      return;
    }
    stdout.on("data", (chunk: Buffer | Uint8Array) => {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > MAX_NORMALIZED_BYTES) {
        overflowed = true;
        child?.kill("SIGKILL");
        return;
      }
      chunks.push(buffer);
    });
    child.once("error", () => fail(new BotMediaError("conversion_failed", "Audio conversion failed.")));
    child.once("close", (code) => {
      if (signal.aborted) {
        fail(abortedError());
      } else if (overflowed || code !== 0) {
        fail(new BotMediaError("conversion_failed", "Audio conversion failed."));
      } else {
        settle(() => resolve(new Uint8Array(Buffer.concat(chunks))));
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readJsonBounded(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<unknown> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw abortedError();
      }
      const next = await reader.read();
      if (next.done) {
        break;
      }
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BotMediaError("invalid_transcription", "Audio transcription returned an invalid result.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    throw new BotMediaError("invalid_transcription", "Audio transcription returned an invalid result.");
  }
}

/**
 * Returns at most a tiny prefix for an allowlist classifier. It never retains
 * or exposes a service response body: that body can contain decoder details
 * derived from a user's recording.
 */
async function readBodyPrefix(
  body: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < maximum) {
      if (signal.aborted) {
        throw abortedError();
      }
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const remaining = maximum - length;
      const portion = next.value.byteLength <= remaining
        ? next.value
        : next.value.subarray(0, remaining);
      chunks.push(portion);
      length += portion.byteLength;
      if (portion.byteLength < next.value.byteLength || length === maximum) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  );
}

function classifyFlovRejection(prefix: string): FlovRejectionReason {
  const value = flovErrorMessage(prefix).trimStart().toLowerCase();
  if (value.startsWith("audio decode failed:")) {
    const detail = value.slice("audio decode failed:".length).trimStart();
    if (detail.startsWith("unsupported or malformed audio container")) {
      return "audio_container";
    }
    if (detail.startsWith("audio decoder produced no samples")) {
      return "audio_no_samples";
    }
    if (detail.startsWith("audio is shorter than")) {
      return "audio_too_short";
    }
    if (detail.startsWith("decoded audio exceeds")) {
      return "audio_duration";
    }
    if (detail.startsWith("failed to read audio packet") || detail.startsWith("failed to decode audio packet")) {
      return "audio_packet";
    }
    return "audio_decode";
  }
  if (
    value.startsWith("multipart ") ||
    value.startsWith("malformed multipart") ||
    value.startsWith("uploaded audio file is empty")
  ) {
    return "multipart";
  }
  if (
    value.startsWith("unsupported response_format") ||
    value.startsWith("invalid boolean value") ||
    value.startsWith("language must be")
  ) {
    return "invalid_option";
  }
  if (
    value.startsWith("empty request body") ||
    value.startsWith("request body exceeds") ||
    value.startsWith("server.max_body_mb")
  ) {
    return "request_invalid";
  }
  return "other_4xx";
}

/**
 * Flov's public errors are JSON envelopes. Parse only its short bounded
 * prefix, select the fixed error-message field for allowlist matching, and
 * immediately discard it. In particular, never attach it to an error,
 * telemetry, tool output, or model context.
 */
function flovErrorMessage(prefix: string): string {
  try {
    const parsed: unknown = JSON.parse(prefix);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return prefix;
    }
    const error = (parsed as { error?: unknown }).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) {
      return prefix;
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : prefix;
  } catch {
    // A large decoder diagnostic can make the bounded prefix incomplete JSON.
    // The static beginning of Flov's `error.message` is nevertheless enough
    // for the allowlist below; return only that short value prefix.
    const message = /"message"\s*:\s*"/u.exec(prefix);
    return message === null ? prefix : prefix.slice(message.index + message[0].length);
  }
}

function transcriptText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" && text.length <= MAX_TRANSCRIPT_CHARS
    ? text.trim()
    : undefined;
}

function localEndpoint(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("Flov endpoint must be a local HTTP URL.");
  }
  if (
    url.protocol !== "http:"
    || !isLoopbackHostname(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/v1/audio/transcriptions"
  ) {
    throw new TypeError("Flov endpoint must be a local transcription URL.");
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost");
}

/**
 * Flov holds a local Whisper model and its conversion buffers are substantial.
 * One shared client therefore serializes work across the bot workers instead
 * of allowing three simultaneous ffmpeg + 20 MiB pipelines to starve the host.
 * Waiting is abortable and counts against the caller's existing timeout.
 */
class AsyncExclusiveGate {
  #held = false;
  #waiters: Array<{
    signal: AbortSignal;
    onAbort: () => void;
    resolve: () => void;
  }> = [];

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.#acquire(signal);
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(abortedError());
    }
    if (!this.#held) {
      this.#held = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) {
            this.#waiters.splice(index, 1);
          }
          reject(abortedError());
        },
        resolve,
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (!next) {
      this.#held = false;
      return;
    }
    next.signal.removeEventListener("abort", next.onAbort);
    next.resolve();
  }
}

function validLanguage(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[a-z]{2,3}$/u.test(value)) {
    throw new TypeError("Flov language must be a two- or three-letter code.");
  }
  return value;
}

function validBearerToken(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const token = value.trim();
  if (
    !token ||
    token.length > 16_384 ||
    !/^[\x21-\x7e]+$/u.test(token)
  ) {
    throw new TypeError("Flov bearer token must be a safe HTTP header value.");
  }
  return token;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 600_000) {
    throw new TypeError("Flov timeout must be an integer between 1000 and 600000.");
  }
  return value;
}

function abortedError(): BotMediaError {
  return new BotMediaError("aborted", "Audio transcription was cancelled.");
}
