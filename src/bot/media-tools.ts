import type { StoredMessage } from "../store.js";
import type {
  ReadToolEvidence,
} from "./read-tools.js";
import {
  BotMediaError,
  type TelegramMediaTarget,
} from "./media/contracts.js";
import {
  FlovAudioTranscriber,
  FlovHttpError,
  type FlovRejectionReason,
  type FlovSourceContainer,
} from "./media/flov-transcriber.js";
import {
  TelegramMediaDownloader,
  type DownloadedTelegramMedia,
} from "./media/telegram-downloader.js";
import { selectTelegramMediaTarget } from "./media/telegram-media.js";

const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 600;
const MAX_MODEL_TRANSCRIPT_CHARS = 3_200;

export interface VisionAttachment {
  readonly data: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
  readonly source: "trigger" | "reply";
  readonly messageId: number;
}

export interface AudioTranscribeToolSuccess {
  readonly ok: true;
  readonly tool: "audio_transcribe";
  readonly status: "done";
  readonly result: {
    readonly source: "trigger" | "reply";
    readonly durationSeconds?: number;
    readonly transcript: string;
    readonly truncated: boolean;
  };
  readonly evidence: readonly ReadToolEvidence[];
}

export interface AudioTranscribeToolFailure {
  readonly ok: false;
  readonly tool: "audio_transcribe";
  readonly error: AudioTranscribeToolError;
  readonly evidence: readonly [];
}

export interface AudioTranscribeToolError {
  readonly code:
    | "aborted"
    | "file_too_large"
    | "invalid_media"
    | "no_audio"
    | "timeout"
    | "transcription_rejected"
    | "transcription_failed"
    | "transcription_unavailable";
  readonly retryable: boolean;
  readonly message: string;
}

export interface FlovRejectionDiagnostic {
  readonly flovStatus: number;
  readonly flovReason: FlovRejectionReason;
  readonly flovSourceContainer: FlovSourceContainer;
}

export type AudioTranscribeToolResult =
  | AudioTranscribeToolSuccess
  | AudioTranscribeToolFailure;

/**
 * Private application result for an explicit "расшифруй" request. Unlike the
 * model-facing tool result it keeps the complete locally-produced transcript
 * so the worker can publish it as chunked plain Telegram text without sending
 * private speech to a remote language model.
 */
export type DirectAudioTranscriptionResult =
  | {
      readonly ok: true;
      readonly source: "trigger" | "reply";
      readonly durationSeconds?: number;
      readonly transcript: string;
    }
  | AudioTranscribeToolFailure;

// Diagnostics stay out of model-facing tool data. The execution layer extracts
// these two coarse fields solely for the structured bot log.
const flovRejections = new WeakMap<AudioTranscribeToolFailure, FlovRejectionDiagnostic>();

export function flovRejectionDiagnostic(
  result: AudioTranscribeToolResult | DirectAudioTranscriptionResult,
): FlovRejectionDiagnostic | undefined {
  return result.ok ? undefined : flovRejections.get(result);
}

export interface BotMediaToolsPort {
  findPhoto(
    trigger: StoredMessage,
    replyTarget?: StoredMessage,
  ): TelegramMediaTarget | undefined;
  findAudio(
    trigger: StoredMessage,
    replyTarget?: StoredMessage,
  ): TelegramMediaTarget | undefined;
  resolveVision(
    target: TelegramMediaTarget,
    signal: AbortSignal,
  ): Promise<VisionAttachment>;
  transcribeAudio(
    target: TelegramMediaTarget,
    signal: AbortSignal,
  ): Promise<AudioTranscribeToolResult>;
  transcribeAudioDirect(
    target: TelegramMediaTarget,
    signal: AbortSignal,
  ): Promise<DirectAudioTranscriptionResult>;
}

/**
 * Per-turn media boundary. It can use only a direct trigger or direct reply
 * target selected by application code; neither a model nor a chat participant
 * can supply a file ID, path, URL, or unrelated message ID.
 */
export class BotMediaTools implements BotMediaToolsPort {
  readonly #downloader: TelegramMediaDownloader;
  readonly #transcriber: FlovAudioTranscriber;

  constructor(options: {
    downloader: TelegramMediaDownloader;
    transcriber: FlovAudioTranscriber;
  }) {
    this.#downloader = options.downloader;
    this.#transcriber = options.transcriber;
  }

  findPhoto(
    trigger: StoredMessage,
    replyTarget?: StoredMessage,
  ): TelegramMediaTarget | undefined {
    return selectTelegramMediaTarget(trigger, replyTarget, ["photo"]);
  }

  findAudio(
    trigger: StoredMessage,
    replyTarget?: StoredMessage,
  ): TelegramMediaTarget | undefined {
    return selectTelegramMediaTarget(
      trigger,
      replyTarget,
      ["voice", "video_note", "audio"],
    );
  }

  async resolveVision(
    target: TelegramMediaTarget,
    signal: AbortSignal,
  ): Promise<VisionAttachment> {
    if (target.kind !== "photo") {
      throw new BotMediaError("invalid_media", "The selected image is invalid.");
    }
    if (
      target.fileSize !== undefined &&
      target.fileSize > MAX_VISION_IMAGE_BYTES
    ) {
      throw new BotMediaError("file_too_large", "The selected image is too large.");
    }
    const downloaded = await this.#downloader.download(target, signal);
    if (downloaded.data.byteLength > MAX_VISION_IMAGE_BYTES) {
      throw new BotMediaError("file_too_large", "The selected image is too large.");
    }
    return {
      data: downloaded.data,
      mediaType: imageMediaType(downloaded),
      source: target.source,
      messageId: target.message.messageId,
    };
  }

  async transcribeAudio(
    target: TelegramMediaTarget,
    signal: AbortSignal,
  ): Promise<AudioTranscribeToolResult> {
    const direct = await this.transcribeAudioDirect(target, signal);
    if (!direct.ok) {
      return direct;
    }
    return asModelAudioResult(target, direct);
  }

  async transcribeAudioDirect(
    target: TelegramMediaTarget,
    signal: AbortSignal,
  ): Promise<DirectAudioTranscriptionResult> {
    if (
      (target.kind !== "voice" &&
        target.kind !== "video_note" &&
        target.kind !== "audio") ||
      target.durationSeconds === undefined ||
      target.durationSeconds > MAX_AUDIO_DURATION_SECONDS
    ) {
      return audioFailure("invalid_media", false);
    }
    try {
      const downloaded = await this.#downloader.download(target, signal);
      const transcript = await this.#transcriber.transcribe(
        {
          data: downloaded.data,
          mediaType: downloaded.mediaType,
          ...(target.durationSeconds === undefined
            ? {}
            : { durationSeconds: target.durationSeconds }),
        },
        signal,
      );
      return {
        ok: true,
        source: target.source,
        ...(target.durationSeconds === undefined
          ? {}
          : { durationSeconds: target.durationSeconds }),
        transcript,
      };
    } catch (error) {
      return audioFailureFrom(error);
    }
  }
}

function asModelAudioResult(
  target: TelegramMediaTarget,
  direct: Extract<DirectAudioTranscriptionResult, { ok: true }>,
): AudioTranscribeToolSuccess {
  const projection = boundedTranscript(direct.transcript);
  return {
    ok: true,
    tool: "audio_transcribe",
    status: "done",
    result: {
      source: direct.source,
      ...(direct.durationSeconds === undefined
        ? {}
        : { durationSeconds: direct.durationSeconds }),
      transcript: projection.text,
      truncated: projection.truncated,
    },
    evidence: [
      {
        source: "chat_message",
        chat: { id: target.message.chatId },
        message: { id: target.message.messageId },
        speaker: {
          id: target.message.senderId ?? null,
          name: target.message.senderName ?? null,
        },
        date: target.message.date ?? null,
        text: projection.text,
      },
    ],
  };
}

function imageMediaType(
  downloaded: DownloadedTelegramMedia,
): VisionAttachment["mediaType"] {
  switch (downloaded.mediaType.toLowerCase()) {
    case "image/png":
      return "image/png";
    case "image/webp":
      return "image/webp";
    // Telegram's `photo` variant is a server-side JPEG conversion. A missing
    // or generic HTTP content type must not change that trusted transport fact.
    default:
      return "image/jpeg";
  }
}

function boundedTranscript(value: string): {
  text: string;
  truncated: boolean;
} {
  const normalized = value.trim();
  if (normalized.length <= MAX_MODEL_TRANSCRIPT_CHARS) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${normalized.slice(0, MAX_MODEL_TRANSCRIPT_CHARS - 1)}…`,
    truncated: true,
  };
}

function audioFailureFrom(error: unknown): AudioTranscribeToolFailure {
  if (!(error instanceof BotMediaError)) {
    return audioFailure("transcription_failed", true);
  }
  if (error instanceof FlovHttpError) {
    const failure = audioFailure("transcription_rejected", false);
    flovRejections.set(failure, {
      flovStatus: error.status,
      flovReason: error.reason,
      flovSourceContainer: error.sourceContainer,
    });
    return failure;
  }
  switch (error.code) {
    case "aborted":
      return audioFailure("aborted", false);
    case "file_too_large":
      return audioFailure("file_too_large", false);
    case "invalid_media":
      return audioFailure("invalid_media", false);
    case "no_audio":
      return audioFailure("no_audio", false);
    case "download_timeout":
    case "conversion_timeout":
    case "transcription_timeout":
      return audioFailure("timeout", true);
    case "transcription_unavailable":
      return audioFailure("transcription_unavailable", true);
    default:
      return audioFailure("transcription_failed", true);
  }
}

function audioFailure(
  code: AudioTranscribeToolError["code"],
  retryable: boolean,
): AudioTranscribeToolFailure {
  return {
    ok: false,
    tool: "audio_transcribe",
    error: {
      code,
      retryable,
      message: "Не удалось расшифровать адресное аудио локально.",
    },
    evidence: [],
  };
}
