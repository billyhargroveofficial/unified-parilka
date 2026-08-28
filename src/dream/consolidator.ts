import type { DigestModelRouter } from "../digests.js";
import type {
  StoredChatMemory,
  StoredDreamDay,
  UpsertDreamDayInput,
} from "../store.js";
import type { CommitDreamDayInput } from "../storage/dream-commit.js";
import type { JsonEventLogger } from "../observability/contracts.js";
import { safeDreamErrorCode } from "./diagnostics.js";
import {
  planDreamDayJobs,
  seedDreamDaysIfEmpty,
  type DreamPlannerStore,
} from "./planner.js";
import { projectDreamDay } from "./projection.js";
import { runDreamReview } from "./review.js";
import { selectDreamInteractions, type DreamSelectorStore } from "./selector.js";
import { shortenDreamMemoryBlock } from "./shorten-memory.js";
import type { DreamKnowledgeStore } from "./skill-manager.js";
import { StagedKnowledgeOverlay } from "./staged-knowledge.js";

const DEFAULT_MAX_INPUT_CHARS = 120_000;
const DEFAULT_MAX_MEMORY_CHARS = 2_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_CANDIDATE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CANDIDATE_ATTEMPTS = 2;

export interface DreamConsolidatorStore
  extends DreamPlannerStore,
    DreamSelectorStore,
    DreamKnowledgeStore {
  getDreamDay(params: { chatId: string; day: string }): StoredDreamDay | undefined;
  getChatMemory(chatId: string): StoredChatMemory | undefined;
  upsertChatMemory(input: {
    chatId: string;
    memoryText: string;
    lastConsolidatedMessageId?: number;
    updatedAtMs?: number;
  }): StoredChatMemory;
  commitDreamDay(input: CommitDreamDayInput): StoredDreamDay;
}

export interface DreamConsolidatorOptions {
  router: DigestModelRouter;
  botSenderId: string;
  maxInputChars?: number;
  maxMemoryChars?: number;
  maxOutputTokens?: number;
  totalTimeoutMs?: number;
  candidateTimeoutMs?: number;
  maxCandidateAttempts?: number;
  logger?: JsonEventLogger;
  now?: () => Date;
  /** Optional test seam; defaults to the production runDreamReview. */
  runReview?: typeof runDreamReview;
  /** Optional test seam; defaults to the production shortenDreamMemoryBlock. */
  shortenMemory?: typeof shortenDreamMemoryBlock;
}

export interface DreamRunOptions {
  chatId: string;
}

export type DreamDayRunStatus =
  | "completed_no_interactions"
  | "completed_reviewed"
  | "failed";

export type DreamDayRunReport = {
  day: string;
  status: DreamDayRunStatus;
  interactionCount: number;
  batchCount: number;
  model?: string;
  providerId?: string;
  error?: string;
};

export type DreamResult =
  | {
      status: "no_jobs";
      chatId: string;
      reason: "already_caught_up";
    }
  | {
      status: "failed";
      chatId: string;
      error: string;
      days: DreamDayRunReport[];
    }
  | {
      status: "success";
      chatId: string;
      days: DreamDayRunReport[];
      reviewedDays: number;
      totalInteractions: number;
      newWatermark?: number;
      model: string;
      providerId: string;
      fallbackCount: number;
    };

export class DreamConsolidator {
  readonly #router: DigestModelRouter;
  readonly #botSenderId: string;
  readonly #maxInputChars: number;
  readonly #maxMemoryChars: number;
  readonly #maxOutputTokens: number;
  readonly #totalTimeoutMs: number;
  readonly #candidateTimeoutMs: number;
  readonly #maxCandidateAttempts: number;
  readonly #logger: JsonEventLogger | undefined;
  readonly #now: () => Date;
  readonly #runReview: typeof runDreamReview;
  readonly #shortenMemory: typeof shortenDreamMemoryBlock;

  constructor(options: DreamConsolidatorOptions) {
    this.#router = options.router;
    this.#botSenderId = options.botSenderId;
    this.#runReview = options.runReview ?? runDreamReview;
    this.#shortenMemory = options.shortenMemory ?? shortenDreamMemoryBlock;
    this.#maxInputChars = boundedInteger(
      options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
      1_000,
      1_000_000,
      "maxInputChars",
    );
    this.#maxMemoryChars = boundedInteger(
      options.maxMemoryChars ?? DEFAULT_MAX_MEMORY_CHARS,
      500,
      4_000,
      "maxMemoryChars",
    );
    this.#maxOutputTokens = boundedInteger(
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      64,
      32_768,
      "maxOutputTokens",
    );
    this.#totalTimeoutMs = boundedInteger(
      options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      1_000,
      15 * 60_000,
      "totalTimeoutMs",
    );
    this.#candidateTimeoutMs = boundedInteger(
      options.candidateTimeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS,
      500,
      this.#totalTimeoutMs,
      "candidateTimeoutMs",
    );
    this.#maxCandidateAttempts = boundedInteger(
      options.maxCandidateAttempts ?? DEFAULT_MAX_CANDIDATE_ATTEMPTS,
      1,
      3,
      "maxCandidateAttempts",
    );
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  async run(
    store: DreamConsolidatorStore,
    options: DreamRunOptions,
  ): Promise<DreamResult> {
    const { chatId } = options;
    const now = this.#now();

    // Bootstrap on first encounter; never creates jobs before today-7.
    seedDreamDaysIfEmpty(store, chatId, { now: () => now });

    const jobs = planDreamDayJobs(store, chatId, { now: () => now });
    if (jobs.length === 0) {
      return { status: "no_jobs", chatId, reason: "already_caught_up" };
    }

    const days: DreamDayRunReport[] = [];
    let reviewedDays = 0;
    let totalInteractions = 0;
    let globalModel = "";
    let globalProviderId = "";
    let globalFallbackCount = 0;
    let maxProcessedMessageId: number | undefined;

    try {
      for (const job of jobs) {
        const dayResult = await this.#runDay(store, chatId, job.day);
        const { report } = dayResult;
        days.push(report);
        if (report.status === "failed") {
          // Previous days may already be committed; preserve them and stop.
          return {
            status: "failed",
            chatId,
            error: report.error ?? "unknown",
            days,
          };
        }
        if (report.status === "completed_reviewed") {
          reviewedDays += 1;
        }
        totalInteractions += report.interactionCount;
        globalFallbackCount += dayResult.fallbackCount;
        if (dayResult.lastMessageId != null) {
          maxProcessedMessageId = Math.max(
            maxProcessedMessageId ?? 0,
            dayResult.lastMessageId,
          );
        }
        if (report.model) {
          globalModel = report.model;
        }
        if (report.providerId) {
          globalProviderId = report.providerId;
        }
      }

      return {
        status: "success",
        chatId,
        days,
        reviewedDays,
        totalInteractions,
        newWatermark: maxProcessedMessageId,
        model: globalModel,
        providerId: globalProviderId,
        fallbackCount: globalFallbackCount,
      };
    } catch (error) {
      const code = safeDreamErrorCode(error);
      this.#log("warn", "bot.dream.run_failed", { chatId, errorCode: code });
      return {
        status: "failed",
        chatId,
        error: code,
        days,
      };
    }
  }

  async #runDay(
    store: DreamConsolidatorStore,
    chatId: string,
    day: string,
  ): Promise<{ report: DreamDayRunReport; lastMessageId?: number; fallbackCount: number }> {
    const now = this.#now();
    const nowMs = now.getTime();

    const running = this.#markDayRunning(store, chatId, day, nowMs);

    const { interactions, incomplete } = selectDreamInteractions(
      store,
      chatId,
      day,
      this.#botSenderId,
    );

    if (interactions.length === 0) {
      this.#log("info", "bot.dream.day_started", {
        chatId,
        day,
        interactionCount: 0,
        batchCount: 0,
        incompleteCount: incomplete.length,
      });
      // Always use commitDreamDay for completed days so audit is produced.
      store.commitDreamDay({
        day: {
          chatId,
          day,
          status: "completed",
          interactionCount: 0,
          attempts: running.attempts,
          sourceHash: "",
          updatedAtMs: nowMs,
          completedAtMs: nowMs,
        },
        fast: [],
        lessons: [],
        skills: [],
      });
      if (incomplete.length > 0) {
        this.#log("info", "bot.dream.day_incomplete_interactions", {
          chatId,
          day,
          incompleteCount: incomplete.length,
        });
      }
      this.#log("info", "bot.dream.day_completed", {
        chatId,
        day,
        interactionCount: 0,
        batchCount: 0,
      });
      return {
        report: {
          day,
          status: "completed_no_interactions",
          interactionCount: 0,
          batchCount: 0,
        },
        fallbackCount: 0,
      };
    }

    const projection = projectDreamDay(interactions, {
      botSenderId: this.#botSenderId,
      maxInputChars: this.#maxInputChars,
    });
    const batchCount = projection.batches.length;
    this.#log("info", "bot.dream.day_started", {
      chatId,
      day,
      interactionCount: projection.interactionCount,
      batchCount,
      incompleteCount: incomplete.length,
    });

    let dayModel = "";
    let dayProviderId = "";
    let dayFallbackCount = 0;
    const originalMemory = store.getChatMemory(chatId);
    // Day-stage overlay: knowledge tools never touch SQLite until full-day
    // commit. Reads see committed + staged (successful earlier batches).
    const dayStage = new StagedKnowledgeOverlay(store, { now: () => nowMs });
    let stagedMemory = originalMemory?.memoryText ?? "";

    for (let batchOffset = 0; batchOffset < batchCount; batchOffset += 1) {
      const batch = projection.batches[batchOffset]!;
      const batchIndex = batchOffset + 1;
      const inputChars = batch.sourceText.length;
      this.#log("info", "bot.dream.batch_started", {
        chatId,
        day,
        batchIndex,
        batchCount,
        inputChars,
        interactionCount: batch.interactionCount,
      });
      try {
        const review = await this.#runReview({
          router: this.#router,
          store: dayStage,
          chatId,
          sourceMessageId: batch.sourceMessageId,
          sourceText: batch.sourceText,
          currentMemory: stagedMemory,
          maxMemoryChars: this.#maxMemoryChars,
          maxOutputTokens: this.#maxOutputTokens,
          candidateTimeoutMs: this.#candidateTimeoutMs,
          totalTimeoutMs: this.#totalTimeoutMs,
          maxCandidateAttempts: this.#maxCandidateAttempts,
        });
        dayModel = review.model;
        dayProviderId = review.providerId;
        dayFallbackCount += review.fallbackCount;

        if (review.finishReason !== "stop") {
          throw Object.assign(
            new Error(
              `Dream review finished abnormally: ${review.finishReason}`,
            ),
            { code: `incomplete_review:${review.finishReason}` },
          );
        }

        let final = (review.final ?? "").trim();
        if (final.length === 0) {
          throw Object.assign(
            new Error("Dream review produced an empty final."),
            { code: "empty_review" },
          );
        }
        let shortened = false;
        if (final.length > this.#maxMemoryChars) {
          const shortenedResult = await this.#shortenMemory({
            router: this.#router,
            block: final,
            maxChars: this.#maxMemoryChars,
            maxOutputTokens: this.#maxOutputTokens,
            candidateTimeoutMs: this.#candidateTimeoutMs,
            totalTimeoutMs: this.#totalTimeoutMs,
            maxCandidateAttempts: this.#maxCandidateAttempts,
          });
          dayModel = shortenedResult.model;
          dayProviderId = shortenedResult.providerId;
          dayFallbackCount += shortenedResult.fallbackCount;
          final = shortenedResult.text;
          shortened = true;
        }
        stagedMemory = final;
        dayStage.setStagedSemanticMemory({
          chatId,
          memoryText: final,
          lastConsolidatedMessageId:
            projection.lastMessageId != null
              ? Math.max(
                  originalMemory?.lastConsolidatedMessageId ?? 0,
                  projection.lastMessageId,
                )
              : originalMemory?.lastConsolidatedMessageId,
          updatedAtMs: nowMs,
        });
        this.#log("info", "bot.dream.batch_completed", {
          chatId,
          day,
          batchIndex,
          batchCount,
          inputChars,
          interactionCount: batch.interactionCount,
          toolCalls: review.toolCalls,
          finalChars: final.length,
          shortened,
          model: dayModel || undefined,
          providerId: dayProviderId || undefined,
        });
      } catch (error) {
        // Any batch or shortening failure discards the entire day stage.
        // Only the failed dream-day job state is persisted.
        const lastError = safeDreamErrorCode(error);
        this.#log("warn", "bot.dream.batch_failed", {
          chatId,
          day,
          batchIndex,
          batchCount,
          inputChars,
          errorCode: lastError,
        });
        store.upsertDreamDay({
          chatId,
          day,
          status: "failed",
          interactionCount: projection.interactionCount,
          firstMessageId: projection.firstMessageId,
          lastMessageId: projection.lastMessageId,
          sourceHash: projection.sourceHash,
          attempts: running.attempts,
          error: lastError,
          model: dayModel || undefined,
          provider: dayProviderId || undefined,
          updatedAtMs: nowMs,
        });
        return {
          report: {
            day,
            status: "failed",
            interactionCount: projection.interactionCount,
            batchCount,
            model: dayModel || undefined,
            providerId: dayProviderId || undefined,
            error: lastError,
          },
          lastMessageId: projection.lastMessageId,
          fallbackCount: dayFallbackCount,
        };
      }
    }

    // Full day success: one short SQLite transaction after all model work.
    const staged = dayStage.exportStagedWrites(chatId);
    const dayInput: UpsertDreamDayInput = {
      chatId,
      day,
      status: "completed",
      interactionCount: projection.interactionCount,
      firstMessageId: projection.firstMessageId,
      lastMessageId: projection.lastMessageId,
      sourceHash: projection.sourceHash,
      attempts: running.attempts,
      model: dayModel || undefined,
      provider: dayProviderId || undefined,
      updatedAtMs: nowMs,
      completedAtMs: nowMs,
    };
    const memoryChanged =
      stagedMemory !== (originalMemory?.memoryText ?? "") ||
      (projection.lastMessageId != null &&
        projection.lastMessageId !==
          (originalMemory?.lastConsolidatedMessageId ?? undefined));
    // Always commit through commitDreamDay so audit is produced for every
    // completed day, including no-op and zero-interaction.
    const commitInput: CommitDreamDayInput = {
      day: dayInput,
      fast: staged.fast,
      lessons: staged.lessons,
      skills: staged.skills,
      deletedFastKeys:
        staged.deletedFastKeys.length > 0
          ? staged.deletedFastKeys
          : undefined,
      deletedLessonKeys:
        staged.deletedLessonKeys.length > 0
          ? staged.deletedLessonKeys
          : undefined,
      deletedSkillKeys:
        staged.deletedSkillKeys.length > 0
          ? staged.deletedSkillKeys
          : undefined,
      ...(memoryChanged || staged.memory !== undefined
        ? {
            memory: {
              chatId,
              memoryText: stagedMemory,
              lastConsolidatedMessageId:
                projection.lastMessageId != null
                  ? Math.max(
                      originalMemory?.lastConsolidatedMessageId ?? 0,
                      projection.lastMessageId,
                    )
                  : originalMemory?.lastConsolidatedMessageId,
              updatedAtMs: nowMs,
            },
          }
        : {}),
    };
    try {
      store.commitDreamDay(commitInput);
    } catch (error) {
      const lastError = safeDreamErrorCode(error);
      this.#log("warn", "bot.dream.commit_failed", {
        chatId,
        day,
        errorCode: lastError,
      });
      try {
        store.upsertDreamDay({
          chatId,
          day,
          status: "failed",
          interactionCount: projection.interactionCount,
          firstMessageId: projection.firstMessageId,
          lastMessageId: projection.lastMessageId,
          sourceHash: projection.sourceHash,
          attempts: running.attempts,
          error: lastError,
          model: dayModel || undefined,
          provider: dayProviderId || undefined,
          updatedAtMs: nowMs,
        });
      } catch {
        // Failed-row persist itself failed: outer run() fail-closed path.
        throw error;
      }
      return {
        report: {
          day,
          status: "failed",
          interactionCount: projection.interactionCount,
          batchCount,
          model: dayModel || undefined,
          providerId: dayProviderId || undefined,
          error: lastError,
        },
        lastMessageId: projection.lastMessageId,
        fallbackCount: dayFallbackCount,
      };
    }

    this.#log("info", "bot.dream.day_completed", {
      chatId,
      day,
      interactionCount: projection.interactionCount,
      batchCount,
      model: dayModel || undefined,
      providerId: dayProviderId || undefined,
    });
    return {
      report: {
        day,
        status: "completed_reviewed",
        interactionCount: projection.interactionCount,
        batchCount,
        model: dayModel,
        providerId: dayProviderId,
      },
      lastMessageId: projection.lastMessageId,
      fallbackCount: dayFallbackCount,
    };
  }

  #markDayRunning(
    store: DreamConsolidatorStore,
    chatId: string,
    day: string,
    nowMs: number,
  ): StoredDreamDay {
    const existing = store.getDreamDay({ chatId, day });
    return store.upsertDreamDay({
      chatId,
      day,
      status: "running",
      interactionCount: existing?.interactionCount ?? 0,
      firstMessageId: existing?.firstMessageId,
      lastMessageId: existing?.lastMessageId,
      sourceHash: existing?.sourceHash,
      attempts: (existing?.attempts ?? 0) + 1,
      model: existing?.model,
      provider: existing?.provider,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    });
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...fields });
    } catch {
      // Observability is best-effort.
    }
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
