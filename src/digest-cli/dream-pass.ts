import type { DigestModelRouter } from "../digests.js";
import { DreamConsolidator } from "../dream/consolidator.js";
import type { JsonEventLogger } from "../observability/contracts.js";
import type { MessageStore } from "../store.js";
import type { CliOptions } from "./options.js";

export type DreamPassResult =
  | {
      status: "skipped";
      reason: "dry_run" | "no_model_config";
    }
  | {
      status: "no_jobs";
      reason: "already_caught_up";
    }
  | {
      status: "failed";
      error: string;
      days?: unknown[];
    }
  | {
      status: "success";
      days: unknown[];
      reviewedDays: number;
      totalInteractions: number;
      newWatermark?: number;
      model: string;
      providerId: string;
      fallbackCount: number;
    };

export interface DreamPassOptions
  extends Pick<
    CliOptions,
    | "chatId"
    | "apply"
    | "botId"
    | "modelConfigPath"
    | "modelTotalTimeoutMs"
    | "modelCandidateTimeoutMs"
    | "memoryMaxChars"
  > {
  /** Optional test seam; defaults to the production wall clock. */
  now?: () => Date;
}

export async function runDreamPass(
  store: MessageStore,
  options: DreamPassOptions,
  router: DigestModelRouter | undefined,
  logger?: JsonEventLogger,
): Promise<DreamPassResult> {
  if (!options.apply || router === undefined) {
    return {
      status: "skipped",
      reason: options.apply ? "no_model_config" : "dry_run",
    };
  }

  const consolidator = new DreamConsolidator({
    router,
    botSenderId: options.botId,
    maxMemoryChars: options.memoryMaxChars,
    totalTimeoutMs: options.modelTotalTimeoutMs,
    candidateTimeoutMs: options.modelCandidateTimeoutMs,
    logger,
    now: options.now,
  });

  const result = await consolidator.run(store, {
    chatId: options.chatId,
  });

  if (result.status === "no_jobs") {
    return { status: "no_jobs", reason: result.reason };
  }

  if (result.status === "failed") {
    return {
      status: "failed",
      error: result.error,
      days: result.days,
    };
  }

  return {
    status: "success",
    days: result.days,
    reviewedDays: result.reviewedDays,
    totalInteractions: result.totalInteractions,
    newWatermark: result.newWatermark,
    model: result.model,
    providerId: result.providerId,
    fallbackCount: result.fallbackCount,
  };
}
