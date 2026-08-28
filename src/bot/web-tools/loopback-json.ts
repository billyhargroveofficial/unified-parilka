import { requireLoopbackHttpOrigin } from "./url-validation.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES_BOUND = 8_000_000;

export interface LoopbackJsonRequest {
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: string;
  signal?: AbortSignal;
  /** Per-request timeout override; defaults to the constructor value. */
  timeoutMs?: number;
  /** Per-request response byte cap override. */
  maxResponseBytes?: number;
}

export interface LoopbackJsonResponse {
  status: number;
  text: string;
}

export interface LoopbackJsonClientOptions {
  origin: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export class LoopbackJsonTimeoutError extends Error {
  readonly code = "timeout";
}

export class LoopbackJsonTransportError extends Error {
  readonly code = "provider_unavailable";
}

export class LoopbackJsonResponseTooLargeError extends Error {
  readonly code = "provider_error";
}

/**
 * Bounded JSON transport for operator-owned loopback HTTP services
 * (SearXNG, Firecrawl). The origin is validated once as a credential-free
 * loopback HTTP origin; every request uses `redirect: "error"`, composes the
 * caller signal with a single deadline that covers headers AND the full
 * bounded body read, and cleans up its composed listeners afterwards.
 */
export class LoopbackJsonClient {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetchImpl: typeof fetch;

  constructor(options: LoopbackJsonClientOptions) {
    this.#origin = requireLoopbackHttpOrigin(options.origin);
    this.#timeoutMs = boundedPositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxResponseBytes = boundedPositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(
    request: LoopbackJsonRequest,
  ): Promise<LoopbackJsonResponse> {
    const timeoutMs = boundedPositiveInteger(
      request.timeoutMs ?? this.#timeoutMs,
      "timeoutMs",
    );
    const maxBytes = boundedPositiveInteger(
      request.maxResponseBytes ?? this.#maxResponseBytes,
      "maxResponseBytes",
    );
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const composed = composeAbortSignals([
      request.signal,
      deadline.signal,
    ]);
    try {
      let response: Response;
      try {
        response = await this.#fetchImpl(
          `${this.#origin}${request.path}`,
          {
            method: request.method ?? "GET",
            ...(request.body === undefined
              ? {}
              : { body: request.body }),
            headers: { accept: "application/json", ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
            redirect: "error",
            signal: composed.signal,
          },
        );
      } catch (error) {
        // One deadline covers headers; body reads happen below.
        throw mapFetchError(error, request.signal, deadline);
      }
      // Re-check abort after headers resolve so an upstream that ignores the
      // signal until then cannot turn an aborted call into success.
      throwIfAborted(request.signal, deadline);

      let buffer = new Uint8Array(0);
      try {
        const reader = response.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            // Same check between body reads.
            throwIfAborted(request.signal, deadline);
            const { done, value } = await reader.read();
            // Re-check after the read: an abort or deadline that landed while
            // the final read was in flight must not turn a done-only result
            // into success.
            throwIfAborted(request.signal, deadline);
            if (done) {
              break;
            }
            total += value.length;
            if (total > maxBytes) {
              await reader.cancel("response_too_large");
              throw new LoopbackJsonResponseTooLargeError(
                "Loopback JSON response exceeded the byte limit.",
              );
            }
            chunks.push(value);
          }
          buffer = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.length;
          }
        }
      } catch (error) {
        if (error instanceof LoopbackJsonResponseTooLargeError) {
          throw error;
        }
        throw mapFetchError(error, request.signal, deadline);
      }

      return {
        status: response.status,
        text: new TextDecoder().decode(buffer),
      };
    } finally {
      clearTimeout(timer);
      composed.dispose();
    }
  }
}

/**
 * Fails an in-flight request when the caller or the deadline already aborted.
 * Caller cancellation surfaces its own reason (never a timeout); deadline
 * expiry maps to the typed timeout error.
 */
function throwIfAborted(
  callerSignal: AbortSignal | undefined,
  deadline: AbortController,
): void {
  if (callerSignal?.aborted) {
    const reason = callerSignal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    throw new DOMException("Aborted", "AbortError");
  }
  if (deadline.signal.aborted) {
    throw new LoopbackJsonTimeoutError("Loopback JSON request timed out.");
  }
}

function mapFetchError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  deadline: AbortController,
): Error {
  if (callerSignal?.aborted) {
    // Caller cancellation wins; rethrow so clients map it to "aborted".
    throw error;
  }
  if (deadline.signal.aborted) {
    throw new LoopbackJsonTimeoutError(
      "Loopback JSON request timed out.",
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    throw new LoopbackJsonTimeoutError(
      "Loopback JSON request timed out.",
    );
  }
  if (
    error instanceof LoopbackJsonResponseTooLargeError ||
    error instanceof LoopbackJsonTimeoutError
  ) {
    throw error;
  }
  throw new LoopbackJsonTransportError(
    "Loopback JSON request failed.",
  );
}

/** Validates a positive bounded safe integer option. */
function boundedPositiveInteger(value: number, name: string): number {
  const maximum = name === "maxResponseBytes"
    ? MAX_RESPONSE_BYTES_BOUND
    : MAX_TIMEOUT_MS;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be a positive safe integer up to ${maximum}.`,
    );
  }
  return value;
}

interface ComposedSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Resolves when any input signal aborts; listeners are removable via dispose. */
export function composeAbortSignals(
  signals: ReadonlyArray<AbortSignal | undefined>,
): ComposedSignal {
  const controller = new AbortController();
  const active = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const onAbort = (): void => controller.abort();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose(): void {
      for (const signal of active) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
