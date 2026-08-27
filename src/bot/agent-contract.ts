import type { StoredBotTurn, StoredMessage } from "../store.js";
import type { FoldBatch, TurnBoundary } from "./turn-coordinator.js";
import type { ToolProgressPort } from "./tool-progress.js";

/**
 * Durable-owner ingress limits for one untrusted model final.
 *
 * These are deliberately above Telegram's individual rich/plain payload
 * limits: an ordinary multi-part plain reply remains valid.  They bound the
 * otherwise unbounded model-to-SQLite hand-off before table normalization,
 * draft persistence, or any Telegram publication work.  The UTF-16 ceiling
 * permits sixteen 4,096-unit Telegram chunks; the stricter UTF-8 ceiling
 * keeps multi-byte output from turning that allowance into a large durable
 * write.
 */
export const MAX_BOT_AGENT_FINAL_REPLY_UTF16_CODE_UNITS = 64 * 1024;
export const MAX_BOT_AGENT_FINAL_REPLY_UTF8_BYTES = 128 * 1024;

/** A stable, content-free failure used by the durable worker and telemetry. */
export class BotAgentFinalReplyTooLargeError extends Error {
  readonly code = "BOT_AGENT_FINAL_REPLY_TOO_LARGE";

  constructor() {
    super("Bot agent final reply exceeds the durable owner limit.");
    this.name = this.code;
  }
}

/**
 * Checks both JavaScript's UTF-16 transport measure and the actual SQLite/
 * Telegram UTF-8 payload size. Check UTF-16 first so an absurdly large value
 * never needs an additional full UTF-8 traversal.
 */
export function isBotAgentFinalReplyWithinLimit(text: string): boolean {
  return text.length <= MAX_BOT_AGENT_FINAL_REPLY_UTF16_CODE_UNITS &&
    Buffer.byteLength(text, "utf8") <= MAX_BOT_AGENT_FINAL_REPLY_UTF8_BYTES;
}

export function assertBotAgentFinalReplyWithinLimit(text: string): void {
  if (!isBotAgentFinalReplyWithinLimit(text)) {
    throw new BotAgentFinalReplyTooLargeError();
  }
}

/**
 * Provider boundary for one durable bot turn.
 *
 * Runtime owns claiming, cancellation, delivery and durable state. A direct
 * Responses adapter owns only producing the final visible reply.
 */
export interface BotAgentFinalResult {
  kind: "final";
  text: string;
  responseOrigin?: "local_audio";
  telemetry: {
    finalModelId: string;
    finalProviderId: string;
    /** Actual validated provider tier, deliberately bounded to safe labels. */
    serviceTier?: "fast" | "priority";
    reasoningMode?: string;
    steps: readonly {
      modelId: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
    }[];
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokens?: number;
    contextUsedTokens?: number;
    contextWindowTokens?: number;
    toolCalls: number;
    durationMs: number;
    incomplete: boolean;
  };
}

export interface BotAgentRequest {
  turn: Readonly<StoredBotTurn>;
  trigger: Readonly<StoredMessage>;
  replyTarget?: Readonly<StoredMessage>;
  context: readonly Readonly<StoredMessage>[];
  signal: AbortSignal;
  drainFold: (boundary: TurnBoundary) => FoldBatch;
  toolProgressPort?: ToolProgressPort;
}

export interface BotTurnAgent {
  run(request: BotAgentRequest): Promise<BotAgentFinalResult>;
}
