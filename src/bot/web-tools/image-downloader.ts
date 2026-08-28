import {
  isPublicAddress,
  lookupPublicAddresses,
  requestPinnedHttps,
  validatePublicHttpsUrl,
  PublicAddressError,
  PinnedHttpsError,
  type PinnedHttpsRequest,
  type PinnedHttpsResponse,
  type ResolvedAddress,
} from "../read-tools/public-address.js";
import {
  MAX_IMAGES_PER_TURN,
  MAX_IMAGE_BYTES_PER_TURN,
  type DownloadedImage,
  type ImageMediaType,
  type TurnImageTracker,
} from "../agent/web-images.js";
import { composeAbortSignals } from "./loopback-json.js";

const PER_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DOWNLOAD_TIMEOUT_MS = 30_000;
const IMAGE_ACCEPT = "image/jpeg, image/png, image/webp, image/*";

export interface DownloadImagesResult {
  images: DownloadedImage[];
  skipped: number;
  remaining: number;
  errors: Array<{ code: string; message: string }>;
}

export interface ImageDownloaderOptions {
  tracker: TurnImageTracker;
  signal: AbortSignal;
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  transport?: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;
}

/**
 * Downloads public HTTPS images with a DNS-pinned connection, magic-byte
 * validation, and turn-level cumulative caps enforced through the tracker's
 * atomic count and byte reservations. Bytes actually received count toward
 * the turn budget even when a payload later fails validation. Downloads are
 * in-memory only, never durable.
 */
export async function downloadImages(
  urls: readonly string[],
  options: ImageDownloaderOptions,
): Promise<DownloadImagesResult> {
  const granted = options.tracker.reserveCount(urls.length);
  const attempted = urls.slice(0, granted);
  const skipped = urls.length - granted;
  const errors: Array<{ code: string; message: string }> = [];

  const successes: DownloadedImage[] = [];
  for (const rawUrl of attempted) {
    if (options.signal.aborted) {
      errors.push({ code: "aborted", message: "Operation aborted." });
      continue;
    }
    try {
      const image = await downloadOneImage(rawUrl, options);
      successes.push(image);
    } catch (error) {
      errors.push({
        code: errorCodeOf(error),
        message: errorMessageOf(error),
      });
    }
  }

  options.tracker.settleCount(successes, granted);
  return {
    images: successes,
    skipped,
    remaining: Math.max(0, MAX_IMAGES_PER_TURN - options.tracker.occupiedCount),
    errors,
  };
}

async function downloadOneImage(
  rawUrl: string,
  options: ImageDownloaderOptions,
): Promise<DownloadedImage> {
  // Sync + DNS-pinned public-address validation.
  let url: URL;
  try {
    url = validatePublicHttpsUrl(rawUrl);
  } catch (error) {
    if (error instanceof PublicAddressError) {
      throw Object.assign(
        new Error(
          "URL must be a public HTTPS address without credentials.",
        ),
        { code: "unsafe_url" },
      );
    }
    throw error;
  }
  const lookup = options.lookup ?? lookupPublicAddresses;
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await lookup(url.hostname);
  } catch {
    throw Object.assign(
      new Error("DNS lookup failed."),
      { code: "unsafe_url" },
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some((item) => !isPublicAddress(item))
  ) {
    throw Object.assign(
      new Error("Hostname resolved to a private or unsupported address."),
      { code: "unsafe_url" },
    );
  }
  const address = addresses.find((item) => item.family === 4) ?? addresses[0]!;

  // Reserve the byte budget before the transfer so in-flight transfers share
  // one bounded turn budget.
  const availableBytes = options.tracker.availableBytes;
  if (availableBytes <= 0) {
    throw Object.assign(
      new Error("Cumulative image byte limit reached."),
      { code: "size_limit" },
    );
  }
  const reserved = options.tracker.reserveBytes(
    Math.min(PER_IMAGE_MAX_BYTES, availableBytes),
  );
  if (reserved <= 0) {
    throw Object.assign(
      new Error("Cumulative image byte limit reached."),
      { code: "size_limit" },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const composed = composeAbortSignals([
    options.signal,
    controller.signal,
  ]);

  let received = 0;
  try {
    const transport = options.transport ?? requestPinnedHttps;
    const response = await transport({
      url,
      address,
      signal: composed.signal,
      maxBytes: reserved,
      accept: IMAGE_ACCEPT,
      userAgent: "ParilkaBot/1.0 image-download",
    });
    received = response.body.length;

    // Any 3xx is a hard failure; redirects are never followed. Status 0 and
    // other invalid statuses are failures too, never success.
    if (response.status >= 300 && response.status < 400) {
      throw Object.assign(new Error("Redirects are not followed."), {
        code: "redirect",
      });
    }
    if (
      !Number.isSafeInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    ) {
      throw Object.assign(
        new Error("Image server returned an invalid HTTP status."),
        { code: "http_error" },
      );
    }
    if (received > reserved) {
      throw Object.assign(new Error("Image exceeds the byte limit."), {
        code: "size_limit",
      });
    }
    if (received === 0) {
      throw Object.assign(new Error("Empty image body."), {
        code: "invalid_image",
      });
    }

    // Content-Length early cap when the header promises more than the budget.
    const contentLength = contentLengthOf(response);
    if (contentLength !== undefined && contentLength > reserved) {
      throw Object.assign(new Error("Image exceeds the byte limit."), {
        code: "size_limit",
      });
    }

    const contentType = contentTypeOf(response);
    const magicType = detectTypeFromMagic(response.body);
    if (magicType === null) {
      throw Object.assign(
        new Error("Image magic bytes do not match JPEG, PNG, or WebP."),
        { code: "invalid_image" },
      );
    }
    if (contentType !== undefined && !isAllowedContentType(contentType)) {
      throw Object.assign(
        new Error(`Unsupported Content-Type: ${contentType}.`),
        { code: "unsupported_type" },
      );
    }
    if (
      contentType !== undefined &&
      mediaTypeForContentType(contentType) !== magicType
    ) {
      throw Object.assign(
        new Error("Content-Type does not match the image magic bytes."),
        { code: "type_mismatch" },
      );
    }

    options.tracker.consumeBytes(received, reserved);
    return {
      data: response.body,
      mediaType: magicType,
      sourceUrl: url.toString(),
    };
  } catch (error) {
    if (error instanceof PinnedHttpsError) {
      if (error.code === "response_too_large") {
        // The pinned transport destroys the stream at the reserved cap; the
        // reservation was fully consumed by the transfer.
        options.tracker.consumeBytes(reserved, reserved);
        throw Object.assign(new Error(error.message), {
          code: "size_limit",
        });
      }
      // Transport-level failure: nothing was received, so only the actual
      // bytes (zero) count against the turn budget, not the reservation.
      options.tracker.consumeBytes(received, reserved);
      throw Object.assign(new Error(error.message), {
        code: "provider_unavailable",
      });
    }
    // Bytes actually received count toward the turn budget even on failure.
    options.tracker.consumeBytes(received, reserved);
    if (options.signal.aborted) {
      throw Object.assign(new Error("Download aborted."), {
        code: "aborted",
      });
    }
    if (controller.signal.aborted) {
      throw Object.assign(new Error("Download timed out."), {
        code: "timeout",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    composed.dispose();
  }
}

function contentLengthOf(response: PinnedHttpsResponse): number | undefined {
  const raw = response.headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function contentTypeOf(response: PinnedHttpsResponse): string | undefined {
  const raw = response.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function isAllowedContentType(value: string): boolean {
  return (
    value === "image/jpeg" ||
    value === "image/jpg" ||
    value === "image/png" ||
    value === "image/webp"
  );
}

function mediaTypeForContentType(value: string): ImageMediaType {
  if (value === "image/png") return "image/png";
  if (value === "image/webp") return "image/webp";
  return "image/jpeg";
}

export function detectTypeFromMagic(
  buffer: Uint8Array,
): ImageMediaType | null {
  if (buffer.length < 12) return null;

  // JPEG: starts with FF D8 FF
  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WebP: "RIFF" + size + "WEBP"
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) {
      return code;
    }
  }
  return "download_error";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Download failed.";
}

export { MAX_IMAGE_BYTES_PER_TURN };
