/**
 * A Bot API file reference is host-private. It must never cross into the
 * model input, a user-visible error, or a structured log.
 */
export interface TelegramImageReference {
  readonly kind: "photo" | "document";
  readonly fileId: string;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  readonly fileSize?: number;
  readonly width?: number;
  readonly height?: number;
}

export type TelegramImageSource = "trigger" | "reply";

export interface TelegramImageTarget extends TelegramImageReference {
  readonly source: TelegramImageSource;
  readonly message: import("../../store.js").StoredMessage;
}

export interface TelegramImageDataUrl {
  /** Ready for direct Responses `input_image`. */
  readonly dataUrl: string;
  readonly mimeType: TelegramImageReference["mediaType"];
  readonly source: TelegramImageSource;
  readonly messageId: number;
}

export type ImageMediaFailureCode =
  | "invalid_media"
  | "file_too_large"
  | "download_failed"
  | "download_timeout"
  | "aborted";

/** Deliberately content-free media failure; never include Telegram identifiers. */
export class BotImageMediaError extends Error {
  readonly code: ImageMediaFailureCode;

  constructor(code: ImageMediaFailureCode) {
    super(code);
    this.name = "BotImageMediaError";
    this.code = code;
  }
}
