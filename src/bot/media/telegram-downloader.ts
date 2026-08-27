import sharp from "sharp";
import type { TelegramImageReference } from "./contracts.js";
import { BotImageMediaError } from "./contracts.js";

export const MAX_TELEGRAM_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TELEGRAM_IMAGE_TURN_BYTES = 20 * 1024 * 1024;

export interface TelegramFileDescriptor {
  readonly filePath: string;
  readonly fileSize?: number;
}

/** Narrow image-only surface of the native Bot API owner. */
export interface TelegramImageDownloadApi {
  getFile(fileId: string, signal: AbortSignal): Promise<TelegramFileDescriptor>;
  downloadFile(filePath: string, signal: AbortSignal): Promise<Response>;
}

export interface DownloadedTelegramImage {
  readonly dataUrl: string;
  readonly mimeType: TelegramImageReference["mediaType"];
  readonly byteLength: number;
}

/**
 * Downloads one Bot API image with bounded memory and validates the actual
 * decoded raster before producing a Responses-compatible data URL.
 */
export class TelegramImageDownloader {
  readonly #api: TelegramImageDownloadApi;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;

  constructor(options: {
    api: TelegramImageDownloadApi;
    maxBytes?: number;
    timeoutMs?: number;
  }) {
    this.#api = options.api;
    this.#maxBytes = boundedInteger(options.maxBytes, MAX_TELEGRAM_IMAGE_BYTES, 1_024, MAX_TELEGRAM_IMAGE_BYTES);
    this.#timeoutMs = boundedInteger(options.timeoutMs, 30_000, 1_000, 120_000);
  }

  async download(
    image: TelegramImageReference,
    externalSignal: AbortSignal,
  ): Promise<DownloadedTelegramImage> {
    if (!validFileId(image.fileId) || !validImageMime(image.mediaType)) throw new BotImageMediaError("invalid_media");
    if (image.fileSize !== undefined && (!validByteCount(image.fileSize) || image.fileSize > this.#maxBytes)) {
      throw new BotImageMediaError(image.fileSize !== undefined && image.fileSize > this.#maxBytes ? "file_too_large" : "invalid_media");
    }
    if (externalSignal.aborted) throw new BotImageMediaError("aborted");

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([externalSignal, timeout]);
    try {
      const descriptor = await this.#api.getFile(image.fileId, signal);
      if (!validFilePath(descriptor.filePath)) throw new BotImageMediaError("invalid_media");
      if (descriptor.fileSize !== undefined && (!validByteCount(descriptor.fileSize) || descriptor.fileSize > this.#maxBytes)) {
        throw new BotImageMediaError(descriptor.fileSize !== undefined && descriptor.fileSize > this.#maxBytes ? "file_too_large" : "invalid_media");
      }
      if (image.fileSize !== undefined && descriptor.fileSize !== undefined && image.fileSize !== descriptor.fileSize) {
        throw new BotImageMediaError("download_failed");
      }
      const response = await this.#api.downloadFile(descriptor.filePath, signal);
      if (!response.ok || !response.body) throw new BotImageMediaError("download_failed");
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > this.#maxBytes)) {
        throw new BotImageMediaError("file_too_large");
      }
      const bytes = await readBoundedBody(response.body, this.#maxBytes, signal);
      const expectedSize = descriptor.fileSize ?? image.fileSize;
      if (expectedSize !== undefined && bytes.byteLength !== expectedSize) throw new BotImageMediaError("download_failed");
      const mimeType = await validateImage(bytes, image.mediaType, response.headers.get("content-type"));
      return {
        dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
        mimeType,
        byteLength: bytes.byteLength,
      };
    } catch (error) {
      if (externalSignal.aborted) throw new BotImageMediaError("aborted");
      if (timeout.aborted) throw new BotImageMediaError("download_timeout");
      if (error instanceof BotImageMediaError) throw error;
      // Decoder/fetch errors can carry a request URL or untrusted file detail.
      throw new BotImageMediaError("download_failed");
    }
  }
}

async function validateImage(
  bytes: Uint8Array,
  expectedMime: TelegramImageReference["mediaType"],
  header: string | null,
): Promise<TelegramImageReference["mediaType"]> {
  const claimed = normalizedImageMime(header);
  if (claimed !== undefined && claimed !== expectedMime) throw new BotImageMediaError("invalid_media");
  const image = sharp(bytes, {
    animated: true,
    // Keep compressed image input from turning into an unbounded raster.
    limitInputPixels: 40_000_000,
    failOn: "error",
  });
  const metadata = await image.metadata();
  const actual = mimeForSharpFormat(metadata.format);
  if (
    actual === undefined || actual !== expectedMime ||
    !positiveInteger(metadata.width) || !positiveInteger(metadata.height) ||
    (metadata.pages !== undefined && metadata.pages > 1)
  ) {
    throw new BotImageMediaError("invalid_media");
  }
  return actual;
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new BotImageMediaError("aborted");
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new BotImageMediaError("file_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validFileId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_-]+$/u.test(value);
}

/** Telegram getFile paths are a relative, slash-delimited private namespace. */
export function validFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    /^[A-Za-z0-9._/-]+$/u.test(value) && !value.startsWith("/") && !value.includes("//") && !value.split("/").includes("..");
}

function validByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new TypeError("Telegram image limit is out of range.");
  return result;
}

function normalizedImageMime(value: string | null): TelegramImageReference["mediaType"] | undefined {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return validImageMime(mime) ? mime : undefined;
}

function validImageMime(value: unknown): value is TelegramImageReference["mediaType"] {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp" || value === "image/gif";
}

function mimeForSharpFormat(format: string | undefined): TelegramImageReference["mediaType"] | undefined {
  switch (format) {
    case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    default: return undefined;
  }
}

function positiveInteger(value: number | undefined): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
