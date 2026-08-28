import { ZodError } from "zod";
import type { StoredMessage } from "../../store.js";
import { isCalendarDay } from "./calendar.js";
import {
  MAX_BOT_READ_TOOL_OUTPUT_CHARS,
  MAX_FIND_CHAT_MESSAGES_OUTPUT_CHARS,
  MAX_READ_CHAT_SLICE_OUTPUT_CHARS,
  type BotReadToolFailure,
  type BotReadToolName,
  type BotReadToolSuccess,
  type CachedDigest,
  type ReadToolError,
  type ReadToolErrorCode,
  type ReadToolEvidence,
} from "./contracts.js";

/**
 * Ordinary read tools keep the short historical cap. Only the purpose-built
 * cache-only tools get a larger (still finite) projection budget so a real
 * transcript of hundreds of short messages reaches the model in one call.
 */
export function maxReadToolOutputChars(tool: BotReadToolName): number {
  if (tool === "read_chat_slice") {
    return MAX_READ_CHAT_SLICE_OUTPUT_CHARS;
  }
  if (tool === "keyword_search") {
    return MAX_FIND_CHAT_MESSAGES_OUTPUT_CHARS;
  }
  return MAX_BOT_READ_TOOL_OUTPUT_CHARS;
}

export function projectDigest(
  digest: CachedDigest,
  chatId: string,
): {
  result: Record<string, unknown>;
  evidence: ReadToolEvidence;
} {
  if (
    (digest.kind !== "day" && digest.kind !== "week") ||
    !requireString(digest.period) ||
    !isCalendarDay(digest.dayFrom) ||
    !isCalendarDay(digest.dayTo) ||
    typeof digest.text !== "string"
  ) {
    throw new ReadToolExecutionError(
      "cache_error",
      false,
      "Digest cache returned malformed digest data.",
    );
  }
  const startMessageId = optionalPositiveSafeInteger(digest.startMessageId);
  const endMessageId = optionalPositiveSafeInteger(digest.endMessageId);
  if (
    (digest.startMessageId !== undefined && startMessageId === undefined) ||
    (digest.endMessageId !== undefined && endMessageId === undefined)
  ) {
    throw new ReadToolExecutionError(
      "cache_error",
      false,
      "Digest cache returned malformed message attribution.",
    );
  }

  return {
    result: {
      kind: digest.kind,
      period: digest.period,
      dayFrom: digest.dayFrom,
      dayTo: digest.dayTo,
      ...(startMessageId === undefined ? {} : { startMessageId }),
      ...(endMessageId === undefined ? {} : { endMessageId }),
    },
    evidence: {
      source: "digest",
      chat: { id: chatId },
      message:
        startMessageId === undefined
          ? null
          : {
              id: startMessageId,
              ...(endMessageId === undefined
                ? {}
                : { endId: endMessageId }),
            },
      speaker: { id: null, name: null },
      date: digest.dayFrom,
      text: digest.text,
      range: {
        dayFrom: digest.dayFrom,
        dayTo: digest.dayTo,
      },
    },
  };
}

export function chatEvidence(
  messages: readonly StoredMessage[],
  expectedChatId: string,
  botSenderId?: string,
): ReadToolEvidence[] {
  if (!Array.isArray(messages)) {
    throw new ReadToolExecutionError(
      "cache_error",
      false,
      "Local cache returned an invalid message list.",
    );
  }
  return messages.map((message) => {
    if (
      message == null ||
      typeof message !== "object" ||
      message.chatId !== expectedChatId ||
      !Number.isSafeInteger(message.messageId) ||
      message.messageId <= 0 ||
      typeof message.text !== "string"
    ) {
      throw new ReadToolExecutionError(
        "cache_error",
        false,
        "Local cache returned malformed or cross-chat evidence.",
      );
    }
    const isOwnTurn =
      botSenderId !== undefined && message.senderId === botSenderId;
    return {
      source: "chat_message",
      sourceId: `chat:${message.messageId}`,
      chat: { id: message.chatId },
      message: {
        id: message.messageId,
        ...(message.replyToMessageId == null
          ? {}
          : { replyToMessageId: message.replyToMessageId }),
      },
      speaker: {
        id: message.senderId ?? null,
        name: message.senderName ?? null,
      },
      authorRole: isOwnTurn ? "assistant" : "user",
      isOwnTurn,
      date: message.date ?? null,
      text: message.text,
    };
  });
}

export function deduplicateEvidence(
  evidence: readonly ReadToolEvidence[],
): ReadToolEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key =
      item.source === "chat_message"
        ? `chat:${item.chat?.id}:${item.message?.id}`
        : item.source === "web" || item.source === "paper"
          ? `${item.source}:${item.url}:${item.text}`
          : item.source === "research"
            ? `research:${item.date}:${item.text}`
            : `digest:${item.chat?.id}:${item.range?.dayFrom}:${item.range?.dayTo}:${item.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function success(
  tool: BotReadToolName,
  status: "done" | "empty",
  result: Record<string, unknown>,
  evidence: ReadToolEvidence[],
): BotReadToolSuccess {
  const bounded = boundToolPayload(tool, status, result, evidence);
  return {
    ok: true,
    tool,
    status,
    result: bounded.result,
    evidence: bounded.evidence,
  };
}

export function failure(tool: string, error: ReadToolError): BotReadToolFailure {
  return { ok: false, tool, error, evidence: [] };
}

export function normalizeReadToolError(error: unknown): ReadToolError {
  if (error instanceof ReadToolExecutionError) {
    return {
      code: error.code,
      retryable: error.retryable,
      message: error.message,
    };
  }
  if (error instanceof ZodError) {
    return {
      code: "invalid_arguments",
      retryable: false,
      message: "Invalid tool arguments.",
      fields: error.issues.flatMap((issue) => {
        if (issue.code === "unrecognized_keys") {
          return issue.keys.map((key) => ({
            path: [...issue.path.map(String), key].join("."),
            message: `Unrecognized key: ${key}`,
          }));
        }
        return [
          {
            path: issue.path.map(String).join("."),
            message: issue.message,
          },
        ];
      }),
    };
  }
  return {
    code: "cache_error",
    retryable: false,
    message: "Read tool failed.",
  };
}

function boundToolPayload(
  tool: BotReadToolName,
  status: "done" | "empty",
  result: Record<string, unknown>,
  evidence: readonly ReadToolEvidence[],
): { result: Record<string, unknown>; evidence: ReadToolEvidence[] } {
  const root = {
    result: structuredClone(result),
    evidence: structuredClone([...evidence]),
  };
  const maxCharacters = maxReadToolOutputChars(tool);
  let truncated = false;
  let omittedEvidence = 0;

  const recordProjection = (): void => {
    root.result.projection = {
      truncated: true,
      omittedEvidence,
      maxCharacters,
    };
  };

  const serializedLength = (): number =>
    JSON.stringify({ ok: true, tool, status, ...root }).length;

  while (serializedLength() > maxCharacters) {
    const overflow = serializedLength() - maxCharacters;
    const slot = longestStringSlot(root);
    if (slot && slot.value.length > 64) {
      const marker = "…[TRUNCATED]";
      const target = Math.max(
        32,
        slot.value.length - overflow - marker.length,
      );
      const replacement =
        slot.value.slice(0, Math.min(target, slot.value.length - 1)) + marker;
      if (Array.isArray(slot.parent)) {
        slot.parent[slot.key as number] = replacement;
      } else {
        slot.parent[slot.key as string] = replacement;
      }
      truncated = true;
      recordProjection();
      continue;
    }
    if (root.evidence.length > 0) {
      root.evidence.pop();
      omittedEvidence += 1;
      truncated = true;
      recordProjection();
      continue;
    }

    // Metadata alone is normally tiny. Keep the hard invariant even if a
    // future caller adds an unexpectedly large non-string structure.
    root.result = {
      projection: {
        truncated: true,
        omittedEvidence,
        maxCharacters,
      },
    };
    break;
  }

  if (!truncated) {
    return root;
  }
  return root;
}

function longestStringSlot(
  value: unknown,
): { parent: Record<string, unknown> | unknown[]; key: string | number; value: string } | undefined {
  let longest:
    | {
        parent: Record<string, unknown> | unknown[];
        key: string | number;
        value: string;
      }
    | undefined;

  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => {
        if (typeof item === "string") {
          if (!longest || item.length > longest.value.length) {
            longest = { parent: entry, key: index, value: item };
          }
        } else {
          visit(item);
        }
      });
      return;
    }
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (typeof item === "string") {
        if (!longest || item.length > longest.value.length) {
          longest = {
            parent: entry as Record<string, unknown>,
            key,
            value: item,
          };
        }
      } else {
        visit(item);
      }
    }
  };

  visit(value);
  return longest;
}

export class ReadToolExecutionError extends Error {
  constructor(
    readonly code: Exclude<ReadToolErrorCode, "unknown_tool">,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

function optionalPositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError(`${name} must not be empty.`);
  }
  return trimmed;
}

function requireString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
