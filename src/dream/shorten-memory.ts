import { generateText } from "ai";
import type { DigestModelRouter } from "../digests.js";
import {
  ModelContentFilterError,
  type ResolvedModelCandidate,
} from "../providers/model-router.js";
import { dreamModelOutputError } from "./review.js";

const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CANDIDATE_ATTEMPTS = 2;
/**
 * Conservative target below the hard maximum: a model aiming at the target
 * keeps a safety margin instead of grazing the hard limit on every attempt.
 */
const SHORTEN_TARGET_RATIO = 0.85;

export interface ShortenMemoryBlockOptions {
  router: DigestModelRouter;
  block: string;
  maxChars: number;
  maxOutputTokens: number;
  candidateTimeoutMs: number;
  /** One shared deadline for the whole shortening call across candidates. */
  totalTimeoutMs?: number;
  /** Internal re-ask budget per router candidate (review retry discipline). */
  maxCandidateAttempts?: number;
  /** Optional test seam; defaults to the production AI SDK generateText. */
  generate?: DreamShortenGenerate;
}

/**
 * Narrow generateText seam for tests. Production uses the AI SDK; the seam
 * must not alter default production behavior when omitted.
 */
export type DreamShortenGenerateResult = {
  text: string;
  finishReason: string;
};

export type DreamShortenGenerate = (
  params: Parameters<typeof generateText>[0],
) => Promise<DreamShortenGenerateResult>;

/**
 * Tool-free shortening of an oversized Dream final with bounded retries
 * inside each router candidate, mirroring runDreamReview's retry discipline:
 * one shared total deadline for the whole call, exactly one fresh candidate
 * deadline per internal attempt, no tools, SDK retries disabled, stopWhen
 * false. Empty output, incomplete finish and oversized output are invalid
 * model output and re-ask the original block while attempts remain; after
 * the last attempt the machine code is thrown unchanged so the router keeps
 * its classification. Content-filter stays terminal and is never retried
 * internally. String truncation of model output is forbidden.
 */
export async function shortenDreamMemoryBlock(
  options: ShortenMemoryBlockOptions,
): Promise<{
  text: string;
  model: string;
  providerId: string;
  fallbackCount: number;
}> {
  const { router, block } = options;
  const maxChars = boundedInteger(options.maxChars, 500, 4_000, "maxChars");
  const maxOutputTokens = boundedInteger(
    options.maxOutputTokens,
    64,
    32_768,
    "maxOutputTokens",
  );
  const totalTimeoutMs = boundedInteger(
    options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    1_000,
    15 * 60_000,
    "totalTimeoutMs",
  );
  const candidateTimeoutMs = boundedInteger(
    options.candidateTimeoutMs,
    500,
    totalTimeoutMs,
    "candidateTimeoutMs",
  );
  const maxCandidateAttempts = boundedInteger(
    options.maxCandidateAttempts ?? DEFAULT_MAX_CANDIDATE_ATTEMPTS,
    1,
    3,
    "maxCandidateAttempts",
  );
  const generate: DreamShortenGenerate =
    options.generate ?? defaultDreamShortenGenerate;
  const signal = AbortSignal.timeout(totalTimeoutMs);

  const routed = await router.executeWithFallback(
    "summary",
    async (candidate) => {
      throwIfTotalDeadlineExpired(signal);
      return generateShortenedBlock(
        candidate,
        block,
        maxChars,
        maxOutputTokens,
        candidateTimeoutMs,
        maxCandidateAttempts,
        signal,
        generate,
      );
    },
  );

  return {
    text: routed.value.text,
    model: routed.candidate.reference,
    providerId: routed.candidate.providerId,
    fallbackCount: routed.failures.length,
  };
}

async function generateShortenedBlock(
  candidate: ResolvedModelCandidate,
  block: string,
  maxChars: number,
  maxOutputTokens: number,
  candidateTimeoutMs: number,
  maxCandidateAttempts: number,
  signal: AbortSignal,
  generate: DreamShortenGenerate,
): Promise<{ text: string; finishReason: string }> {
  let previousOversizedChars: number | undefined;
  for (let attempt = 1; attempt <= maxCandidateAttempts; attempt += 1) {
    throwIfTotalDeadlineExpired(signal);
    const prompt = buildShortenPrompt(block, maxChars, previousOversizedChars);
    // Fresh controller+timer per attempt. A second same-length timer started
    // earlier would race this one and surface a configured deadline as an
    // operator abort (ABORT_ERR) instead of a retryable transport timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), candidateTimeoutMs);
    timer.unref?.();
    try {
      const result = await generate({
        model: candidate.model,
        providerOptions: candidate.providerOptions,
        prompt,
        maxOutputTokens,
        maxRetries: 0,
        stopWhen: () => false,
        abortSignal: AbortSignal.any([signal, controller.signal]),
        include: {
          requestBody: false,
          requestMessages: false,
          responseBody: false,
        },
      });
      // Content-filter is a policy decision: terminal, not retried here.
      if (result.finishReason === "content-filter") {
        throw new ModelContentFilterError(
          "Provider blocked the memory shortening response.",
        );
      }
      const shortened = (result.text ?? "").trim();
      const invalidCode = invalidShorteningCode(
        result.finishReason,
        shortened.length,
        maxChars,
      );
      if (invalidCode === undefined) {
        return { text: shortened, finishReason: result.finishReason };
      }
      if (attempt < maxCandidateAttempts) {
        // Safe feedback carries only the failed length, never its text, and
        // the next attempt always re-compresses the original block.
        previousOversizedChars =
          invalidCode === "shortening_output_too_large"
            ? shortened.length
            : undefined;
        continue;
      }
      throw dreamModelOutputError(invalidCode);
    } catch (error) {
      if (signal.aborted) {
        throw totalDeadlineError(error);
      }
      if (controller.signal.aborted) {
        if (attempt < maxCandidateAttempts) {
          continue;
        }
        throw Object.assign(
          new Error("Memory shortening candidate timed out.", {
            cause: error,
          }),
          { code: "ETIMEDOUT" },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Memory shortening candidate loop ended unexpectedly.");
}

function invalidShorteningCode(
  finishReason: string,
  trimmedChars: number,
  maxChars: number,
): string | undefined {
  if (finishReason !== "stop") {
    return `incomplete_shortening:${finishReason}`;
  }
  if (trimmedChars === 0) {
    return "empty_shortening";
  }
  if (trimmedChars > maxChars) {
    return "shortening_output_too_large";
  }
  return undefined;
}

function buildShortenPrompt(
  block: string,
  maxChars: number,
  previousOversizedChars: number | undefined,
): string {
  const targetChars = Math.max(1, Math.floor(maxChars * SHORTEN_TARGET_RATIO));
  const lines = [
    "Сократи следующий блок долговременной памяти чата, сохранив ключевые факты.",
    `Жёсткий максимум: ${maxChars} символов. Ответ длиннее этого лимита будет отклонён.`,
    `Целевая длина: не больше ${targetChars} символов (безопасный запас под жёсткий максимум).`,
    "Верни только сокращённый plain-text блок: ключевые факты, без заголовков, комментариев и пояснений.",
  ];
  if (previousOversizedChars !== undefined) {
    lines.push(
      `Предыдущий ответ занял ${previousOversizedChars} символов и превысил жёсткий максимум ${maxChars}.`,
      "Сожми исходный блок заново так, чтобы результат уложился в целевую длину.",
    );
  }
  lines.push("", "<memory_block>", block, "</memory_block>");
  return lines.join("\n");
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

function throwIfTotalDeadlineExpired(signal: AbortSignal): void {
  if (signal.aborted) {
    throw totalDeadlineError(signal.reason);
  }
}

/**
 * The total timeout is an internally configured deadline, not an operator
 * cancellation. Keep the original abort error in cause and report an explicit
 * ETIMEDOUT machine code so the router classifies it as a retryable transport
 * timeout instead of a terminal abort (including numeric DOM code 20).
 */
function totalDeadlineError(cause: unknown): Error {
  return Object.assign(
    new Error(
      "Memory shortening total deadline expired.",
      cause === undefined ? undefined : { cause },
    ),
    { code: "ETIMEDOUT" },
  );
}

async function defaultDreamShortenGenerate(
  params: Parameters<typeof generateText>[0],
): Promise<DreamShortenGenerateResult> {
  const result = await generateText(params);
  return {
    text: result.text ?? "",
    finishReason: result.finishReason,
  };
}
