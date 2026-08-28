import type { ToolProgressPort } from "../tool-progress.js";
import type {
  AudioTranscribeToolResult,
  BotMediaToolsPort,
  DirectAudioTranscriptionResult,
} from "../media-tools.js";
import { flovRejectionDiagnostic } from "../media-tools.js";
import type { ResolvedModelCandidate } from "../../providers/model-router.js";
import {
  boundedSerialize,
  type CarriedToolResult,
} from "./evidence.js";
import { ThinkingProgressTracker } from "./thinking-progress.js";
import type { BotToolTraceContext } from "./tool-observer.js";

export interface AudioTranscriptionExecutionOptions {
  readonly mediaTools?: BotMediaToolsPort;
  readonly target: ReturnType<BotMediaToolsPort["findAudio"]>;
  readonly thinkingProgress: ThinkingProgressTracker;
  readonly toolProgressPort?: ToolProgressPort;
  readonly carriedTools: CarriedToolResult[];
  readonly onStarted: () => void;
  readonly onCompleted: () => void;
  readonly getSequence: (callId: string) => number;
  readonly log: (
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
  readonly traceContext: BotToolTraceContext;
}

/**
 * Per-turn local audio executor. It keeps the model-facing transcription
 * promise so retried tool calls cannot download or transcribe the same media
 * more than once; the direct path deliberately stays separate and never
 * carries a private transcript into a provider context.
 */
export class AudioTranscriptionExecution {
  readonly #options: AudioTranscriptionExecutionOptions;
  #modelTranscription:
    | Promise<AudioTranscribeToolResult>
    | undefined;

  constructor(options: AudioTranscriptionExecutionOptions) {
    this.#options = options;
  }

  get available(): boolean {
    return this.#options.mediaTools !== undefined && this.#options.target !== undefined;
  }

  get hasModelTranscription(): boolean {
    return this.#modelTranscription !== undefined;
  }

  async runForModel(input: {
    callId: string;
    signal: AbortSignal;
    candidate?: ResolvedModelCandidate;
    attempt?: number;
  }): Promise<AudioTranscribeToolResult> {
    const { mediaTools, target } = this.#options;
    if (!mediaTools || !target) {
      throw new Error("audio_transcribe is unavailable for this turn.");
    }
    if (this.#modelTranscription) {
      return this.#modelTranscription;
    }
    const started = this.#start({
      callId: input.callId,
      candidate: input.candidate?.reference ?? "local",
      attempt: input.attempt ?? 1,
    });
    const output = mediaTools.transcribeAudio(target, input.signal);
    this.#modelTranscription = output
      .then((output) => {
        this.#options.onCompleted();
        this.#options.toolProgressPort?.onToolCompleted(
          { toolName: "audio_transcribe", callId: input.callId },
          output.ok,
        );
        this.#options.carriedTools.push({
          sequence: started.sequence,
          name: "audio_transcribe",
          serialized: boundedSerialize(output),
        });
        this.#options.log("info", "bot.agent.tool", {
          ...this.#options.traceContext,
          candidate: input.candidate?.reference ?? "local",
          attempt: input.attempt ?? 1,
          tool: "audio_transcribe",
          kind: "audio",
          sequence: started.sequence,
          durationMs: Math.max(0, Date.now() - started.startedAt),
          ok: output.ok,
          ...(output.ok
            ? { status: output.status }
            : { errorCode: output.error.code }),
          ...(flovRejectionDiagnostic(output) ?? {}),
        });
        return output;
      });
    return this.#modelTranscription;
  }

  async runDirect(input: {
    callId: string;
    signal: AbortSignal;
  }): Promise<DirectAudioTranscriptionResult> {
    const { mediaTools, target } = this.#options;
    if (!mediaTools || !target) {
      return noEligibleAudioResult();
    }
    const started = this.#start({
      callId: input.callId,
      candidate: "local:flov",
      attempt: 1,
    });
    const output = await mediaTools.transcribeAudioDirect(target, input.signal);
    this.#options.onCompleted();
    this.#options.toolProgressPort?.onToolCompleted(
      { toolName: "audio_transcribe", callId: input.callId },
      output.ok,
    );
    this.#options.log("info", "bot.agent.tool", {
      ...this.#options.traceContext,
      candidate: "local:flov",
      attempt: 1,
      tool: "audio_transcribe",
      kind: "audio",
      sequence: started.sequence,
      durationMs: Math.max(0, Date.now() - started.startedAt),
      ok: output.ok,
      ...(output.ok ? { status: "done" } : { errorCode: output.error.code }),
      ...(flovRejectionDiagnostic(output) ?? {}),
    });
    return output;
  }

  #start(input: {
    callId: string;
    candidate: string;
    attempt: number;
  }): { startedAt: number; sequence: number } {
    const target = this.#options.target;
    if (!target) {
      throw new Error("audio_transcribe is unavailable for this turn.");
    }
    const startedAt = Date.now();
    const sequence = boundedSequence(this.#options.getSequence(input.callId));
    this.#options.onStarted();
    this.#options.thinkingProgress.finish();
    this.#options.toolProgressPort?.onToolStarted({
      toolName: "audio_transcribe",
      callId: input.callId,
      input: { source: target.source },
    });
    this.#options.log("info", "bot.agent.tool_started", {
      ...this.#options.traceContext,
      candidate: input.candidate,
      attempt: input.attempt,
      tool: "audio_transcribe",
      kind: "audio",
      sequence,
    });
    return { startedAt, sequence };
  }

}

function boundedSequence(value: number): number {
  if (!Number.isSafeInteger(value)) {
    return 1;
  }
  return Math.max(1, value);
}

/** Direct wording must not depend on a provider honouring an optional tool hint. */
export function isDirectAudioTranscriptionRequest(text: string): boolean {
  return /(?:расшифр|транскриб|транскрипц|текстом\s+(?:это|голос|аудио)|что\s+(?:там\s+)?(?:сказал|говорит|сказано))/iu.test(
    text,
  );
}

export function renderDirectAudioTranscription(
  result: DirectAudioTranscriptionResult,
): string {
  if (!result.ok) {
    switch (result.error.code) {
      case "invalid_media":
        return "⚠️ Не смог расшифровать: нужен голосовой, кружок или аудиофайл не длиннее 10 минут.";
      case "file_too_large":
        return "⚠️ Не смог расшифровать: файл превышает допустимый для Telegram размер.";
      case "no_audio":
        return "⚠️ Не удалось извлечь аудиодорожку для расшифровки.";
      case "timeout":
        return "⚠️ Локальный распознаватель не уложился в лимит времени. Попробуй прислать кусок покороче.";
      case "transcription_unavailable":
        return "⚠️ Локальный распознаватель сейчас недоступен; голосовое в облако не отправлял.";
      case "transcription_rejected":
        return "⚠️ Локальный распознаватель отклонил аудио после локальной конвертации; голосовое в облако не отправлял.";
      case "aborted":
        return "⚠️ Расшифровка была отменена до завершения.";
      default:
        return "⚠️ Не смог расшифровать это аудио локально. Попробуй прислать его ещё раз или более короткий кусок.";
    }
  }
  const transcript = result.transcript
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .trim();
  if (!transcript) {
    return "Расшифровка: речи не распознал.";
  }
  return `Расшифровка${result.durationSeconds === undefined ? "" : ` (${result.durationSeconds}с)`}:\n${transcript}`;
}

function noEligibleAudioResult(): DirectAudioTranscriptionResult {
  return {
    ok: false,
    tool: "audio_transcribe",
    error: {
      code: "invalid_media",
      retryable: false,
      message: "No eligible direct audio was attached to this request.",
    },
    evidence: [],
  };
}
