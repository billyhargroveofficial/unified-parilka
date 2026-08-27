import type { EmbeddingRuntimeConfig } from "../embeddings.js";
import { ToolError } from "../errors.js";
import {
  MAX_SPARSE_QUERY_TERMS,
  MAX_SPARSE_TERMS_PER_CHUNK,
  normalizeSparseTerms,
  type SparseTerm,
} from "../store.js";
import {
  LOCAL_BGE_M3_DIMENSIONS,
  LOCAL_BGE_M3_MAX_TEXT_CHARS,
} from "../config/types.js";

/** Wire contract of the operator-owned loopback BGE-M3 service. */
export const LOCAL_BGE_SERVICE_CONTRACT = "bge-m3-v1";
/** Fixed model identity; every response must carry it or it is rejected. */
export const LOCAL_BGE_MODEL_ID = "BAAI/bge-m3";
export const LOCAL_ENCODE_MAX_BATCH = 64;
export const LOCAL_ENCODE_MAX_TEXT_CHARS = LOCAL_BGE_M3_MAX_TEXT_CHARS;
export const LOCAL_RERANK_MAX_CANDIDATES = 32;
export const LOCAL_QUERY_MAX_CHARS = 2_000;

const MAX_LOCAL_RESPONSE_BYTES = 32 * 1024 * 1024;

export type BgeEncodedText = {
  dense: number[];
  sparseTerms: SparseTerm[];
};

export const LOCAL_HEALTH_STATUSES = [
  "ok",
  "loading",
  "error",
] as const;

export type BgeHealthStatusCode =
  (typeof LOCAL_HEALTH_STATUSES)[number];

export type BgeHealthStatus = {
  status: BgeHealthStatusCode;
  model: string;
  contract: string;
};

/**
 * Hardened HTTP client for the local BGE-M3 service. One encode pass returns
 * dense and learned sparse outputs together; rerank scores bounded candidate
 * texts via ColBERT late interaction without ever returning vectors.
 *
 * The service binds loopback only and takes no credential, so requests carry
 * no Authorization header and no secret can leak into this transport.
 */
export class LocalBgeM3Client {
  constructor(private readonly config: EmbeddingRuntimeConfig) {}

  get isConfigured(): boolean {
    const embeddings = this.config.embeddings;
    return (
      embeddings.enabled &&
      embeddings.backend === "local_bge_m3" &&
      embeddings.localEndpoint !== ""
    );
  }

  assertConfigured(): void {
    const embeddings = this.config.embeddings;
    if (!embeddings.enabled) {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message:
          "Embeddings are disabled. Set TELEGRAM_EMBEDDINGS_ENABLED=true.",
      });
    }
    if (embeddings.backend !== "local_bge_m3") {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message:
          "Local BGE-M3 retrieval requires TELEGRAM_EMBEDDINGS_BACKEND=local_bge_m3.",
      });
    }
    if (embeddings.localEndpoint === "") {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message:
          "Local BGE-M3 endpoint is not configured. Set TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT to the loopback service origin.",
      });
    }
  }

  /**
   * Validates service identity before trusting anything else and returns
   * only the validated shape. Never exposes unvalidated response fields.
   */
  async health(signal?: AbortSignal): Promise<BgeHealthStatus> {
    this.assertConfigured();
    const payload = await this.request(
      "GET",
      "/health",
      undefined,
      this.config.embeddings.localRequestTimeoutMs,
      signal,
    );
    const record = assertServiceIdentity(payload, "health");
    if (
      typeof record.status !== "string" ||
      !LOCAL_HEALTH_STATUSES.includes(
        record.status as BgeHealthStatusCode,
      )
    ) {
      throw serviceIdentityError(
        "health",
        "Local BGE-M3 health response carries an unknown status.",
      );
    }
    return {
      status: record.status as BgeHealthStatusCode,
      model: LOCAL_BGE_MODEL_ID,
      contract: LOCAL_BGE_SERVICE_CONTRACT,
    };
  }

  async encodeTexts(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<BgeEncodedText[]> {
    this.assertConfigured();
    if (texts.length === 0) {
      return [];
    }
    if (texts.length > LOCAL_ENCODE_MAX_BATCH) {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message: `Local BGE-M3 encode batch is limited to ${LOCAL_ENCODE_MAX_BATCH} texts.`,
      });
    }
    for (const [index, text] of texts.entries()) {
      assertBoundedText(text, LOCAL_ENCODE_MAX_TEXT_CHARS, `text ${index}`);
    }
    const payload = assertServiceIdentity(
      await this.request(
        "POST",
        "/encode",
        { contract: LOCAL_BGE_SERVICE_CONTRACT, texts },
        this.config.embeddings.localRequestTimeoutMs,
        signal,
      ),
      "encode",
    );
    return parseEncodePayload(payload, texts.length);
  }

  async encodeQuery(
    query: string,
    signal?: AbortSignal,
  ): Promise<BgeEncodedText> {
    assertBoundedText(query, LOCAL_QUERY_MAX_CHARS, "query");
    const [encoded] = await this.encodeTexts([query], signal);
    // Deterministically bound query postings so a long valid query can never
    // turn the sparse channel into a storage exception downstream.
    return {
      dense: encoded.dense,
      sparseTerms: normalizeSparseTerms(
        encoded.sparseTerms,
        MAX_SPARSE_QUERY_TERMS,
      ),
    };
  }

  /**
   * Bounded ColBERT late-interaction rerank. Returns one finite score per
   * candidate in input order; callers own deterministic reordering.
   */
  async rerank(
    query: string,
    candidates: string[],
    signal?: AbortSignal,
  ): Promise<number[]> {
    this.assertConfigured();
    if (candidates.length === 0) {
      return [];
    }
    if (candidates.length > LOCAL_RERANK_MAX_CANDIDATES) {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message: `Local BGE-M3 rerank accepts at most ${LOCAL_RERANK_MAX_CANDIDATES} candidates.`,
      });
    }
    assertBoundedText(query, LOCAL_QUERY_MAX_CHARS, "query");
    for (const [index, text] of candidates.entries()) {
      assertBoundedText(
        text,
        LOCAL_ENCODE_MAX_TEXT_CHARS,
        `candidate ${index}`,
      );
    }
    const payload = assertServiceIdentity(
      await this.request(
        "POST",
        "/rerank",
        {
          contract: LOCAL_BGE_SERVICE_CONTRACT,
          query,
          candidates,
        },
        this.config.embeddings.rerankTimeoutMs,
        signal,
      ),
      "rerank",
    );
    return parseRerankPayload(payload, candidates.length);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(externalSignal);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce(
          method,
          path,
          body,
          timeoutMs,
          externalSignal,
        );
      } catch (error) {
        throwIfAborted(externalSignal);
        const normalized =
          error instanceof ToolError ? error.normalized : undefined;
        if (
          !normalized?.retryable ||
          attempt >= this.config.embeddings.maxRetries
        ) {
          throw error;
        }
        const requestedDelayMs =
          normalized.retryAfterSec != null
            ? normalized.retryAfterSec * 1000
            : this.config.embeddings.retryInitialMs * 2 ** attempt;
        const delayMs = Math.max(
          0,
          Math.min(requestedDelayMs, this.config.embeddings.retryMaxMs),
        );
        await abortableSleep(delayMs, externalSignal);
      }
    }
  }

  private async requestOnce(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.config.embeddings.localEndpoint.replace(/\/+$/u, "")}${path}`;
    const controller = new AbortController();
    let timedOut = false;
    // An already-aborted caller signal must cancel before any socket work.
    if (externalSignal?.aborted) {
      controller.abort(externalSignal.reason);
    }
    const onExternalAbort = () =>
      controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, {
      once: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new DOMException(
          "Local BGE-M3 request timed out.",
          "TimeoutError",
        ),
      );
    }, timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
        signal: controller.signal,
        // The service is loopback-only; a redirect would move cached chat
        // text to an unvalidated origin.
        redirect: "error",
      });
      const source = await readBoundedBody(
        response,
        controller.signal,
      );
      if (!response.ok) {
        throw localServiceHttpError(response.status);
      }
      return parseJsonPayload(source);
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      if (externalSignal?.aborted) {
        throw abortReason(externalSignal);
      }
      if (timedOut || controller.signal.aborted || isAbortError(error)) {
        throw new ToolError({
          category: "internal",
          retryable: true,
          message: `Local BGE-M3 request timed out after ${timeoutMs}ms.`,
        });
      }
      throw new ToolError({
        category: "internal",
        retryable: true,
        message: "Local BGE-M3 service request failed.",
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function assertBoundedText(
  value: string,
  maxChars: number,
  label: string,
): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolError({
      category: "internal",
      retryable: false,
      message: `Local BGE-M3 ${label} must be a non-empty string.`,
    });
  }
  if (value.length > maxChars) {
    throw new ToolError({
      category: "internal",
      retryable: false,
      message: `Local BGE-M3 ${label} exceeds ${maxChars} characters.`,
    });
  }
}

function localServiceHttpError(status: number): ToolError {
  const retryable =
    status === 408 || status === 429 || status >= 500;
  return new ToolError({
    category:
      status === 401 || status === 403 ? "auth" : "internal",
    retryable,
    message: `Local BGE-M3 service returned HTTP ${status}.`,
  });
}

function parseJsonPayload(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ToolError({
      category: "internal",
      retryable: false,
      message: "Local BGE-M3 service returned invalid JSON.",
    });
  }
}

/**
 * Rejects any response whose contract or model identity does not exactly
 * match the fixed BGE-M3 wire contract; a stale or foreign loopback service
 * must never poison the fixed namespace with incompatible vectors.
 */
function assertServiceIdentity(
  payload: unknown,
  operation: string,
): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    throw serviceIdentityError(
      operation,
      `Local BGE-M3 ${operation} response is not an object.`,
    );
  }
  const record = payload as Record<string, unknown>;
  if (record.contract !== LOCAL_BGE_SERVICE_CONTRACT) {
    throw serviceIdentityError(
      operation,
      `Local BGE-M3 ${operation} response contract does not match ${LOCAL_BGE_SERVICE_CONTRACT}.`,
    );
  }
  if (record.model !== LOCAL_BGE_MODEL_ID) {
    throw serviceIdentityError(
      operation,
      `Local BGE-M3 ${operation} response model does not match ${LOCAL_BGE_MODEL_ID}.`,
    );
  }
  return record;
}

function serviceIdentityError(
  operation: string,
  message: string,
): ToolError {
  return new ToolError({
    category: "internal",
    retryable: false,
    message,
  });
}

function parseEncodePayload(
  payload: unknown,
  expectedCount: number,
): BgeEncodedText[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results) || results.length !== expectedCount) {
    throw malformedEncodeShape();
  }
  return results.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw malformedEncodeShape();
    }
    const record = item as Record<string, unknown>;
    const dense = record.dense;
    if (
      !Array.isArray(dense) ||
      dense.length !== LOCAL_BGE_M3_DIMENSIONS ||
      dense.some(
        (value) =>
          typeof value !== "number" || !Number.isFinite(value),
      )
    ) {
      throw malformedEncodeShape(
        `Local BGE-M3 encode result ${index} must carry ${LOCAL_BGE_M3_DIMENSIONS} finite dense values.`,
      );
    }
    const sparse = record.sparse;
    if (!Array.isArray(sparse)) {
      throw malformedEncodeShape(
        `Local BGE-M3 encode result ${index} is missing its sparse terms.`,
      );
    }
    if (sparse.length > MAX_SPARSE_TERMS_PER_CHUNK) {
      throw malformedEncodeShape(
        `Local BGE-M3 encode result ${index} returned ${sparse.length} sparse terms; at most ${MAX_SPARSE_TERMS_PER_CHUNK} are accepted.`,
      );
    }
    const terms: SparseTerm[] = [];
    for (const entry of sparse) {
      if (typeof entry !== "object" || entry === null) {
        throw malformedEncodeShape();
      }
      const term = entry as Record<string, unknown>;
      if (
        typeof term.token_id !== "number" ||
        typeof term.weight !== "number"
      ) {
        throw malformedEncodeShape(
          `Local BGE-M3 sparse term of result ${index} must be {token_id, weight}.`,
        );
      }
      terms.push({
        tokenId: term.token_id,
        weight: term.weight,
      });
    }
    let sparseTerms: SparseTerm[];
    try {
      sparseTerms = normalizeSparseTerms(
        terms,
        MAX_SPARSE_TERMS_PER_CHUNK,
      );
    } catch (error) {
      throw malformedEncodeShape(
        error instanceof Error
          ? `Local BGE-M3 sparse terms of result ${index} are invalid: ${error.message}`
          : undefined,
      );
    }
    return { dense, sparseTerms };
  });
}

function parseRerankPayload(
  payload: unknown,
  expectedCount: number,
): number[] {
  const scores = (payload as { scores?: unknown })?.scores;
  if (
    !Array.isArray(scores) ||
    scores.length !== expectedCount ||
    scores.some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  ) {
    throw new ToolError({
      category: "internal",
      retryable: false,
      message: `Local BGE-M3 rerank must return ${expectedCount} finite scores.`,
    });
  }
  return scores;
}

function malformedEncodeShape(message?: string): ToolError {
  return new ToolError({
    category: "internal",
    retryable: false,
    message:
      message ??
      "Local BGE-M3 service returned an unexpected encode shape.",
  });
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (/^\d+$/u.test(contentLength ?? "")) {
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared > MAX_LOCAL_RESPONSE_BYTES
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw localResponseTooLarge();
    }
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  const cancelOnAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_LOCAL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw localResponseTooLarge();
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError({
      category: "internal",
      retryable: true,
      message: "Local BGE-M3 response could not be read.",
    });
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

function localResponseTooLarge(): ToolError {
  return new ToolError({
    category: "internal",
    retryable: false,
    message: `Local BGE-M3 response exceeded ${MAX_LOCAL_RESPONSE_BYTES} bytes.`,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(
        "Local BGE-M3 request was aborted.",
        "AbortError",
      );
}

function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
