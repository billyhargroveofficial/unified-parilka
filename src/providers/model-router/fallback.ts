import {
  APICallError,
  InvalidArgumentError,
  InvalidPromptError,
  LoadAPIKeyError,
  RetryError,
  TypeValidationError,
} from "ai";
import { ZodError } from "zod";
import type { ModelFallbackDecision } from "./contracts.js";
import { ModelContentFilterError } from "./errors.js";

const TRANSPORT_CODES = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function classifyModelFallback(error: unknown): ModelFallbackDecision {
  const chain = errorChain(unwrapRetryError(error));

  // A candidate deadline intentionally wraps the provider's AbortError in an
  // explicit ETIMEDOUT. Preserve that operational meaning: otherwise the
  // nested AbortError would be mistaken for an operator cancellation and make
  // a retryable provider timeout terminal.
  if (chain.some(isExplicitTimeoutError)) {
    return { fallback: true, reason: "transport" };
  }
  if (chain.some(isAbortError)) {
    return { fallback: false, reason: "abort" };
  }
  if (chain.some(isAuthError)) {
    // Authentication and subscription failures are provider-local. Falling
    // through to a separately configured candidate is the point of the
    // routing chain; the attempt record still makes the broken subscription
    // visible instead of silently masking it.
    return { fallback: true, reason: "auth" };
  }
  if (chain.some(isValidationError)) {
    return { fallback: false, reason: "validation" };
  }
  if (chain.some(isContentFilterError)) {
    // Content-filter rejections are policy decisions. Falling through to a
    // less strict backup provider would bypass the red lines the filter
    // enforces, so this is always terminal for the current turn.
    return { fallback: false, reason: "content_filter" };
  }
  if (chain.some(isFallbackEligibleModelOutputError)) {
    return { fallback: true, reason: "invalid_output" };
  }

  const statusCode = firstStatusCode(chain);
  if (statusCode === 402 || statusCode === 429) {
    return { fallback: true, reason: "rate_limit" };
  }
  if (statusCode === 404 || statusCode === 408) {
    return {
      fallback: true,
      reason: statusCode === 408 ? "transport" : "client_error",
    };
  }
  if (statusCode != null && statusCode >= 500 && statusCode <= 599) {
    return { fallback: true, reason: "server_error" };
  }
  if (statusCode != null && statusCode >= 400 && statusCode <= 499) {
    return { fallback: false, reason: "client_error" };
  }
  if (chain.some(isRetryableTransportError)) {
    return { fallback: true, reason: "transport" };
  }
  return { fallback: false, reason: "other" };
}

function unwrapRetryError(error: unknown): unknown {
  if (!RetryError.isInstance(error)) {
    return error;
  }
  if (error.reason === "abort") {
    return Object.assign(new Error(error.message), {
      name: "AbortError",
      cause: error.lastError,
    });
  }
  return error.lastError;
}

export function abortErrorFrom(error: unknown): unknown {
  const unwrapped = unwrapRetryError(error);
  return errorChain(unwrapped).find(isAbortError) ?? unwrapped;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !seen.has(current) && chain.length < 8) {
    chain.push(current);
    seen.add(current);
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return chain;
}

function isAbortError(error: unknown): boolean {
  const candidate = asErrorRecord(error);
  return candidate?.name === "AbortError" || candidate?.code === "ABORT_ERR";
}

function isExplicitTimeoutError(error: unknown): boolean {
  const candidate = asErrorRecord(error);
  return typeof candidate?.code === "string" &&
    candidate.code.toUpperCase() === "ETIMEDOUT";
}

function isAuthError(error: unknown): boolean {
  if (LoadAPIKeyError.isInstance(error)) {
    return true;
  }
  const statusCode = statusCodeOf(error);
  return statusCode === 401 || statusCode === 403;
}

function isValidationError(error: unknown): boolean {
  return (
    error instanceof ZodError ||
    TypeValidationError.isInstance(error) ||
    InvalidArgumentError.isInstance(error) ||
    InvalidPromptError.isInstance(error)
  );
}

function isContentFilterError(error: unknown): boolean {
  if (error instanceof ModelContentFilterError) {
    return true;
  }
  const candidate = asErrorRecord(error);
  return candidate?.finishReason === "content-filter" || candidate?.code === "content_filter";
}

function isFallbackEligibleModelOutputError(error: unknown): boolean {
  const candidate = asErrorRecord(error);
  return (
    (candidate?.name === "BotAgentProtocolError" ||
      candidate?.name === "ModelProviderResponseTooLargeError") &&
    candidate?.modelFallback === true
  );
}

function firstStatusCode(chain: readonly unknown[]): number | undefined {
  for (const error of chain) {
    const statusCode = statusCodeOf(error);
    if (statusCode != null) {
      return statusCode;
    }
  }
  return undefined;
}

function statusCodeOf(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) {
    return error.statusCode;
  }
  const candidate = asErrorRecord(error);
  const raw = candidate?.statusCode ?? candidate?.status;
  return typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
}

function isRetryableTransportError(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    return error.statusCode == null && error.isRetryable;
  }
  const candidate = asErrorRecord(error);
  if (!candidate) {
    return false;
  }
  if (typeof candidate.code === "string" && TRANSPORT_CODES.has(candidate.code.toUpperCase())) {
    return candidate.code.toUpperCase() !== "ABORT_ERR";
  }
  return candidate.name === "TypeError" && /^fetch failed$/i.test(String(candidate.message ?? "").trim());
}

function asErrorRecord(error: unknown):
  | {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      finishReason?: unknown;
      modelFallback?: unknown;
    }
  | undefined {
  return typeof error === "object" && error !== null
    ? (error as {
        name?: unknown;
        message?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
        finishReason?: unknown;
        modelFallback?: unknown;
      })
    : undefined;
}
