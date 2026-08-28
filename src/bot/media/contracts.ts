/** A media kind that can safely be downloaded from a Bot API message. */
export type TelegramMediaKind = "photo" | "voice" | "video_note" | "audio";

/**
 * A deliberately small, transport-specific reference. It is internal-only:
 * never put a file id or a Bot API download path into a model prompt, log, or
 * user-visible error.
 */
export interface TelegramMediaReference {
  kind: TelegramMediaKind;
  fileId: string;
  /** MIME hint from Bot API, or a conservative kind-derived fallback. */
  mediaType: string;
  fileSize?: number;
  durationSeconds?: number;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface TelegramMediaTarget extends TelegramMediaReference {
  source: TelegramMediaSource;
  message: import("../../store.js").StoredMessage;
}

export type TelegramMediaSource = "trigger" | "reply";

export interface SelectedTelegramMedia {
  source: TelegramMediaSource;
  messageId: number;
  media: TelegramMediaReference;
}

export type MediaFailureCode =
  | "invalid_media"
  | "file_too_large"
  | "download_failed"
  | "download_timeout"
  | "aborted"
  | "conversion_failed"
  | "conversion_timeout"
  | "no_audio"
  | "transcription_failed"
  | "transcription_timeout"
  | "transcription_rejected"
  | "transcription_unavailable"
  | "invalid_transcription";

/** Safe, intentionally non-diagnostic failure for media operations. */
export class BotMediaError extends Error {
  readonly code: MediaFailureCode;

  constructor(code: MediaFailureCode, message: string) {
    super(message);
    this.name = "BotMediaError";
    this.code = code;
  }
}
