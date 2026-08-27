import { runDreamText, type DreamTextRunner } from "./text-runner.js";
import { dreamModelOutputError } from "./review.js";

const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CANDIDATE_ATTEMPTS = 2;
const SHORTEN_TARGET_RATIO = 0.85;

export interface ShortenMemoryBlockOptions {
  textRunner: DreamTextRunner;
  block: string;
  maxChars: number;
  maxOutputTokens: number;
  candidateTimeoutMs: number;
  totalTimeoutMs?: number;
  maxCandidateAttempts?: number;
}

/** Tool-free shortening of an oversized Dream final. */
export async function shortenDreamMemoryBlock(options: ShortenMemoryBlockOptions): Promise<{
  text: string;
  model: string;
  providerId: string;
  fallbackCount: 0;
}> {
  const maxChars = boundedInteger(options.maxChars, 500, 4_000, "maxChars");
  const maxOutputTokens = boundedInteger(options.maxOutputTokens, 64, 32_768, "maxOutputTokens");
  const totalTimeoutMs = boundedInteger(options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS, 1_000, 15 * 60_000, "totalTimeoutMs");
  const candidateTimeoutMs = boundedInteger(options.candidateTimeoutMs, 500, totalTimeoutMs, "candidateTimeoutMs");
  const maxCandidateAttempts = boundedInteger(options.maxCandidateAttempts ?? DEFAULT_MAX_CANDIDATE_ATTEMPTS, 1, 3, "maxCandidateAttempts");
  const signal = AbortSignal.timeout(totalTimeoutMs);
  let previousOversizedChars: number | undefined;
  for (let attempt = 1; attempt <= maxCandidateAttempts; attempt += 1) {
    throwIfTotalDeadlineExpired(signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), candidateTimeoutMs);
    timer.unref?.();
    try {
      const result = await runDreamText(options.textRunner, {
        instructions: "Return only the requested compact plain-text memory block.",
        prompt: buildShortenPrompt(options.block, maxChars, previousOversizedChars),
        dynamicTools: [],
        dispatch: async () => { throw Object.assign(new Error("Dream shortening exposes no tools."), { code: "unknown_tool" }); },
        signal: AbortSignal.any([signal, controller.signal]), timeoutMs: candidateTimeoutMs, maxOutputTokens,
      });
      const shortened = result.text.trim();
      const invalidCode = invalidShorteningCode(result.finishReason, shortened.length, maxChars);
      if (invalidCode === undefined) return { text: shortened, model: result.model, providerId: result.providerId, fallbackCount: 0 };
      if (attempt < maxCandidateAttempts) {
        previousOversizedChars = invalidCode === "shortening_output_too_large" ? shortened.length : undefined;
        continue;
      }
      throw dreamModelOutputError(invalidCode);
    } catch (error) {
      if (signal.aborted) throw totalDeadlineError(error);
      if (controller.signal.aborted) {
        if (attempt < maxCandidateAttempts) continue;
        throw Object.assign(new Error("Dream memory shortening timed out.", { cause: error }), { code: "ETIMEDOUT" });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Dream shortening loop ended unexpectedly.");
}

function invalidShorteningCode(finishReason: string, trimmedChars: number, maxChars: number): string | undefined {
  if (finishReason !== "stop") return `incomplete_shortening:${finishReason}`;
  if (trimmedChars === 0) return "empty_shortening";
  if (trimmedChars > maxChars) return "shortening_output_too_large";
  return undefined;
}

function buildShortenPrompt(block: string, maxChars: number, previousOversizedChars: number | undefined): string {
  const targetChars = Math.max(1, Math.floor(maxChars * SHORTEN_TARGET_RATIO));
  const lines = [
    "Сократи следующий блок долговременной памяти чата, сохранив ключевые факты.",
    `Жёсткий максимум: ${maxChars} символов.`,
    `Целевая длина: не больше ${targetChars} символов.`,
    "Верни только compact plain-text блок, без заголовков и пояснений.",
  ];
  if (previousOversizedChars !== undefined) lines.push(`Предыдущий ответ занял ${previousOversizedChars} символов и превысил лимит; сожми исходный блок заново.`);
  lines.push("", "<memory_block>", block, "</memory_block>");
  return lines.join("\n");
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}

function throwIfTotalDeadlineExpired(signal: AbortSignal): void {
  if (signal.aborted) throw totalDeadlineError(signal.reason);
}

function totalDeadlineError(cause: unknown): Error {
  return Object.assign(new Error("Memory shortening total deadline expired.", cause === undefined ? undefined : { cause }), { code: "ETIMEDOUT" });
}
