import type {
  ReviewDynamicTool,
  ReviewToolDispatch,
} from "./review-tools.js";

/**
 * Minimal boundary between Dream and a direct model text runner. The runner
 * may invoke `dispatch` only for entries declared in `dynamicTools`; Dream
 * owns all persistence and therefore never gives the runner a database
 * handle.
 */
export interface DreamTextRunner {
  runText(options: DreamTextRunOptions): Promise<DreamTextRunResult>;
}

export interface DreamTextRunOptions {
  instructions: string;
  prompt: string;
  dynamicTools: readonly ReviewDynamicTool[];
  dispatch: ReviewToolDispatch;
  signal: AbortSignal;
  /** Per-attempt deadline; the runner must not create an unbounded turn. */
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface DreamTextRunResult {
  /** Final assistant text, not an intermediate tool result. */
  text: string;
  /** Model turn finish reason. Only `stop` is accepted by Dream. */
  finishReason: string;
  /** Number of completed dynamic-tool calls made during this turn. */
  toolCalls: number;
  /** Pinned model actually used. */
  model: string;
  /** Stable service label, normally `openai-responses`. */
  providerId: string;
}

/**
 * A deliberately small adapter for test and production injection. It rejects
 * malformed runner results at the boundary rather than letting a partial
 * transport implementation look like a successful Dream review.
 */
export async function runDreamText(
  runner: DreamTextRunner,
  options: DreamTextRunOptions,
): Promise<DreamTextRunResult> {
  const result = await runner.runText(options);
  if (
    result === null ||
    typeof result !== "object" ||
    typeof result.text !== "string" ||
    typeof result.finishReason !== "string" ||
    !Number.isSafeInteger(result.toolCalls) ||
    result.toolCalls < 0 ||
    typeof result.model !== "string" ||
    result.model.trim().length === 0 ||
    typeof result.providerId !== "string" ||
    result.providerId.trim().length === 0
  ) {
    throw Object.assign(new Error("Dream text runner returned an invalid result."), {
      name: "BotAgentProtocolError",
      code: "invalid_dream_text_result",
      modelFallback: true,
    });
  }
  return result;
}
