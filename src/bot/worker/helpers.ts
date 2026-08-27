import type { StoredMessage } from "../../store.js";
import type { BotAgentFinalResult } from "./contracts.js";

export class WorkerAbortError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "WorkerAbortError";
  }
}

export class WorkerProtocolError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "WorkerProtocolError";
  }
}

export function isAgentFinal(value: unknown): value is BotAgentFinalResult {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "final" ||
    typeof candidate.text !== "string" ||
    (candidate.responseOrigin !== undefined &&
      candidate.responseOrigin !== "local_audio")
  ) {
    return false;
  }
  const telemetry = candidate.telemetry;
  if (!isRecord(telemetry)) {
    return false;
  }
  if (
    typeof telemetry.finalModelId !== "string" ||
    typeof telemetry.finalProviderId !== "string" ||
    !isOptionalEffectiveServiceTier(telemetry.serviceTier) ||
    !isOptionalString(telemetry.reasoningMode) ||
    !Array.isArray(telemetry.steps) ||
    !isOptionalNonNegativeInteger(telemetry.totalInputTokens) ||
    !isOptionalNonNegativeInteger(telemetry.totalOutputTokens) ||
    !isOptionalNonNegativeInteger(telemetry.totalTokens) ||
    !isOptionalNonNegativeInteger(telemetry.contextUsedTokens) ||
    !isOptionalPositiveInteger(telemetry.contextWindowTokens) ||
    !isNonNegativeInteger(telemetry.toolCalls) ||
    !isNonNegativeInteger(telemetry.durationMs) ||
    typeof telemetry.incomplete !== "boolean"
  ) {
    return false;
  }
  return telemetry.steps.every(isStepUsageRecord);
}

function isStepUsageRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.modelId === "string" &&
    isOptionalNonNegativeInteger(value.inputTokens) &&
    isOptionalNonNegativeInteger(value.outputTokens) &&
    isOptionalNonNegativeInteger(value.totalTokens) &&
    isOptionalNonNegativeInteger(value.reasoningTokens)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalEffectiveServiceTier(value: unknown): value is "fast" | "priority" | undefined {
  return value === undefined || value === "fast" || value === "priority";
}

function isOptionalNonNegativeInteger(
  value: unknown,
): value is number | undefined {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalPositiveInteger(
  value: unknown,
): value is number | undefined {
  return value === undefined || (isNonNegativeInteger(value) && value > 0);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function durableMessageId(message: StoredMessage): string {
  return `${message.chatId}:${message.messageId}`;
}

export function safeErrorCode(error: unknown): string {
  if (error != null && typeof error === "object") {
    const candidate = error as { code?: unknown; name?: unknown };
    if (
      typeof candidate.name === "string" &&
      /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(candidate.name)
    ) {
      return candidate.name;
    }
    if (
      typeof candidate.code === "string" &&
      /^[A-Z0-9_]{1,64}$/u.test(candidate.code)
    ) {
      return candidate.code;
    }
  }
  return "unknown_error";
}

/** Agent errors retry by default; an explicit false is a terminal contract. */
export function isRetryableAgentError(error: unknown): boolean {
  return !(error != null && typeof error === "object" &&
    (error as { retryable?: unknown }).retryable === false);
}

export function safeMachineCode(value: string, fallback: string): string {
  return /^[A-Z0-9_]{1,64}$/u.test(value) ? value : fallback;
}

export function publisherFailureKind(value: unknown): string {
  return value === "network" ||
    value === "timeout" ||
    value === "telegram_rejected"
    ? value
    : "unknown";
}

export function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError(`${name} must not be empty`);
  }
  return trimmed;
}

export function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
