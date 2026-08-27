import {
  MAX_BOT_AGENT_FINAL_REPLY_UTF16_CODE_UNITS,
  MAX_BOT_AGENT_FINAL_REPLY_UTF8_BYTES,
  isBotAgentFinalReplyWithinLimit,
} from "../bot/agent-contract.js";
import type { CausalRagSource } from "../bot/causal-rag/index.js";
import {
  renderTelegramCausalAttributions,
  renderTelegramUrlCitations,
  type ResponsesUrlCitation,
} from "../bot/responses-telegram/index.js";

/** Deliberately plain, host-owned notice appended after a bounded model answer. */
export const BOT_AGENT_FINAL_REPLY_TRUNCATION_MARKER =
  "\n\nОтвет сокращён: достигнут лимит публикации.";

export interface ResponsesBotFinalReplyInput {
  readonly modelText: string;
  readonly causalSources: readonly CausalRagSource[];
  readonly citations: readonly ResponsesUrlCitation[];
  readonly statusFooter: string;
}

/**
 * Formats the one string handed to the durable turn owner.
 *
 * A direct Codex subscription can ignore `max_output_tokens`, so never let an
 * unbounded provider value reach persistence.  The normal path is byte-for-
 * byte identical to the former composition.  Only an oversized envelope
 * reserves its complete possible citation footer and trusted status footer
 * before clipping model-visible text on a Unicode boundary.
 */
export function formatResponsesBotFinalReply(input: ResponsesBotFinalReplyInput): string {
  const visible = renderTelegramCausalAttributions(input.modelText, input.causalSources);
  const ordinaryCitations = renderTelegramUrlCitations(input.citations, input.modelText);
  const ordinary = `${visible}${ordinaryCitations}${input.statusFooter}`;
  if (isBotAgentFinalReplyWithinLimit(ordinary)) {
    return ordinary;
  }

  // This is the largest trusted citation envelope this annotation set can
  // render.  Reserve it first, then recompute against the visible prefix so a
  // citation whose inline link was clipped is still retained in the footer.
  const maximumCitations = renderTelegramUrlCitations(input.citations);
  const reservedVisible = truncateVisibleText(
    visible,
    remainingBudget(`${maximumCitations}${input.statusFooter}`),
  );
  const citations = renderTelegramUrlCitations(input.citations, reservedVisible);
  const boundedVisible = truncateVisibleText(
    visible,
    remainingBudget(`${citations}${input.statusFooter}`),
  );
  const boundedCitations = renderTelegramUrlCitations(input.citations, boundedVisible);
  const bounded = `${boundedVisible}${boundedCitations}${input.statusFooter}`;
  if (isBotAgentFinalReplyWithinLimit(bounded)) {
    return bounded;
  }

  // The fallback is intentionally conservative.  Citation rendering is
  // bounded, so reserving the maximum envelope guarantees this path cannot
  // turn an oversized final into a durable-turn failure.
  return `${reservedVisible}${renderTelegramUrlCitations(input.citations, reservedVisible)}${input.statusFooter}`;
}

interface ReplyBudget {
  readonly utf16: number;
  readonly utf8: number;
}

function remainingBudget(suffix: string): ReplyBudget {
  return {
    utf16: Math.max(0, MAX_BOT_AGENT_FINAL_REPLY_UTF16_CODE_UNITS - suffix.length),
    utf8: Math.max(0, MAX_BOT_AGENT_FINAL_REPLY_UTF8_BYTES - Buffer.byteLength(suffix, "utf8")),
  };
}

function truncateVisibleText(text: string, budget: ReplyBudget): string {
  if (text.length <= budget.utf16 && Buffer.byteLength(text, "utf8") <= budget.utf8) {
    return text;
  }

  const markerUtf16 = BOT_AGENT_FINAL_REPLY_TRUNCATION_MARKER.length;
  const markerUtf8 = Buffer.byteLength(BOT_AGENT_FINAL_REPLY_TRUNCATION_MARKER, "utf8");
  const contentBudget = {
    utf16: Math.max(0, budget.utf16 - markerUtf16),
    utf8: Math.max(0, budget.utf8 - markerUtf8),
  };
  let end = 0;
  let utf16 = 0;
  let utf8 = 0;
  let lastLineBreak = -1;
  for (const codePoint of text) {
    const nextUtf16 = utf16 + codePoint.length;
    const nextUtf8 = utf8 + Buffer.byteLength(codePoint, "utf8");
    if (nextUtf16 > contentBudget.utf16 || nextUtf8 > contentBudget.utf8) break;
    utf16 = nextUtf16;
    utf8 = nextUtf8;
    end += codePoint.length;
    if (codePoint === "\n") lastLineBreak = end;
  }

  // Prefer ending at a nearby paragraph boundary, but never discard a large
  // useful prefix merely because the model emitted a very long line.
  if (lastLineBreak > 0 && end - lastLineBreak <= 2_048) end = lastLineBreak;
  return `${text.slice(0, end).trimEnd()}${BOT_AGENT_FINAL_REPLY_TRUNCATION_MARKER}`;
}
