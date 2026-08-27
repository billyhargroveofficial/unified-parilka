import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import { fingerprintEmbeddingSource } from "./embedding-source.js";
import { ToolError } from "./errors.js";
import { providerIdentityUrl } from "./observability/redaction.js";
import type { SparseTerm } from "./storage/types.js";

export type EmbeddingChunkInput = {
  chatId: string;
  startMessageId: number;
  endMessageId: number;
  messageIds: number[];
  messageCount: number;
  text: string;
};

export type EmbeddingChunkVector = EmbeddingChunkInput & {
  namespace: string;
  model: string;
  dimensions: number;
  embedding: Buffer;
  contentHash: string;
  /**
   * Learned sparse postings emitted by the same local BGE-M3 encode pass as
   * the dense vector. Absent for external OpenAI-compatible providers.
   */
  sparseTerms?: readonly SparseTerm[];
};

type EmbeddingsResponse = {
  data?: unknown;
};

export const EMBEDDING_NORMALIZATION_VERSION = "l2-v1";
const MAX_EMBEDDING_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Minimal configuration surface needed by embedding and vector code. */
export type EmbeddingRuntimeConfig = Pick<AppConfig, "embeddings">;

export class EmbeddingClient {
  constructor(private readonly config: EmbeddingRuntimeConfig) {}

  get isEnabled(): boolean {
    return this.config.embeddings.enabled;
  }

  get isConfigured(): boolean {
    return this.isEnabled && Boolean(this.config.embeddings.apiKey);
  }

  assertConfigured(): void {
    if (!this.config.embeddings.enabled) {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message: "Embeddings are disabled. Set TELEGRAM_EMBEDDINGS_ENABLED=true.",
      });
    }
    if (!this.config.embeddings.apiKey) {
      throw new ToolError({
        category: "auth",
        retryable: false,
        message: "Embedding API key is missing. Set OPENAI_API_KEY or TELEGRAM_EMBEDDINGS_API_KEY.",
      });
    }
  }

  async embedTexts(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    this.assertConfigured();
    throwIfAborted(signal);
    if (texts.length === 0) {
      return [];
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.embedTextsOnce(texts, signal);
      } catch (error) {
        throwIfAborted(signal);
        const normalized = error instanceof ToolError ? error.normalized : undefined;
        if (!normalized?.retryable || attempt >= this.config.embeddings.maxRetries) {
          throw error;
        }
        const requestedRetryDelayMs =
          normalized.retryAfterSec != null
            ? normalized.retryAfterSec * 1000
            : this.config.embeddings.retryInitialMs * 2 ** attempt;
        const retryDelayMs = Math.max(
          0,
          Math.min(
            requestedRetryDelayMs,
            this.config.embeddings.retryMaxMs,
          ),
        );
        await abortableSleep(retryDelayMs, signal);
      }
    }
  }

  private async embedTextsOnce(
    texts: string[],
    externalSignal?: AbortSignal,
  ): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.config.embeddings.model,
      input: texts,
      encoding_format: "float",
    };
    if (this.config.embeddings.dimensions != null) {
      body.dimensions = this.config.embeddings.dimensions;
    }

    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () =>
      controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, {
      once: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new DOMException("Embedding request timed out.", "TimeoutError"),
      );
    }, this.config.embeddings.requestTimeoutMs);
    try {
      const response = await fetch(
        embeddingEndpoint(this.config.embeddings.baseUrl),
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.config.embeddings.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          // Never forward the bearer token or cached chat text to a location
          // other than the operator-validated embeddings endpoint.
          redirect: "error",
        },
      );
      const source = await readBoundedEmbeddingBody(
        response,
        controller.signal,
      );
      const payload = parseEmbeddingPayload(source);

      if (!response.ok) {
        const authFailure =
          response.status === 401 || response.status === 403;
        const retryable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        throw new ToolError({
          category: authFailure
            ? "auth"
            : response.status === 429
              ? "rate_limit"
              : "internal",
          retryable,
          retryAfterSec: parseRetryAfterSec(
            response.headers.get("retry-after"),
          ),
          message: `Embedding API request failed with HTTP ${response.status}.`,
        });
      }

      const vectors = validateEmbeddingVectors(
        payload.data,
        texts.length,
      );
      const expectedDimensions = this.config.embeddings.dimensions;
      if (expectedDimensions != null) {
        const mismatchIndex = vectors.findIndex(
          (vector) => vector?.length !== expectedDimensions,
        );
        if (mismatchIndex >= 0) {
          throw new ToolError({
            category: "internal",
            retryable: false,
            message: `Embedding API returned ${vectors[mismatchIndex]?.length ?? 0} dimensions for input ${mismatchIndex}; expected TELEGRAM_EMBEDDINGS_DIMENSIONS=${expectedDimensions}.`,
          });
        }
      }
      return vectors;
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
          message: `Embedding API request timed out after ${this.config.embeddings.requestTimeoutMs}ms.`,
        });
      }
      throw new ToolError({
        category: "internal",
        retryable: true,
        message: "Embedding API request failed.",
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
    const [embedding] = await this.embedTexts([query], signal);
    return normalizeVector(embedding);
  }

  async embedChunks(
    chunks: EmbeddingChunkInput[],
    signal?: AbortSignal,
  ): Promise<EmbeddingChunkVector[]> {
    const vectors = await this.embedTexts(
      chunks.map((chunk) => chunk.text),
      signal,
    );
    return chunks.map((chunk, index) => {
      const normalized = normalizeVector(vectors[index]);
      return {
        ...chunk,
        namespace: embeddingNamespace(this.config),
        model: this.config.embeddings.model,
        dimensions: normalized.length,
        embedding: vectorToBlob(normalized),
        contentHash: fingerprintEmbeddingSource(chunk.text),
      };
    });
  }
}

function embeddingEndpoint(baseUrl: string): string {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/embeddings`;
  return endpoint.href;
}

function validateEmbeddingVectors(
  data: unknown,
  inputCount: number,
): number[][] {
  if (!Array.isArray(data) || data.length !== inputCount) {
    throw unexpectedEmbeddingShape();
  }
  const vectors = new Array<number[]>(inputCount);
  let dimensions: number | undefined;
  for (const item of data) {
    if (item == null || typeof item !== "object") {
      throw unexpectedEmbeddingShape();
    }
    const record = item as Record<string, unknown>;
    const index = record.index;
    const embedding = record.embedding;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= inputCount ||
      vectors[index] != null ||
      !isFiniteEmbeddingVector(embedding)
    ) {
      throw unexpectedEmbeddingShape();
    }
    if (
      dimensions != null &&
      embedding.length !== dimensions
    ) {
      throw unexpectedEmbeddingShape(
        "Embedding API returned inconsistent vector dimensions.",
      );
    }
    dimensions = embedding.length;
    vectors[index] = embedding;
  }
  if (vectors.some((vector) => vector == null)) {
    throw unexpectedEmbeddingShape();
  }
  return vectors;
}

function isFiniteEmbeddingVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (component): component is number =>
        typeof component === "number" && Number.isFinite(component),
    )
  );
}

function unexpectedEmbeddingShape(
  message = "Embedding API returned an unexpected response shape.",
): ToolError {
  return new ToolError({
    category: "internal",
    retryable: false,
    message,
  });
}

export function embeddingNamespace(config: EmbeddingRuntimeConfig): string {
  const payload = JSON.stringify({
    provider: embeddingProviderKey(config.embeddings.baseUrl),
    baseUrl: normalizeBaseUrl(config.embeddings.baseUrl),
    model: config.embeddings.model,
    dimensions: config.embeddings.dimensions ?? null,
    normalization: EMBEDDING_NORMALIZATION_VERSION,
  });
  return `emb_${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

/**
 * Sparse postings contract of the local BGE-M3 backend. Bump when the
 * tokenizer, weight normalization, or posting bounds change so an
 * incompatible sparse index can never mix with a current one.
 */
export const LOCAL_SPARSE_CONTRACT_VERSION = "bge-m3-sparse-v1";

/**
 * Versioning namespace for the local BGE-M3 backend. It intentionally
 * includes the backend kind and sparse contract version, never the loopback
 * endpoint, so a port change does not invalidate a compatible index.
 */
export function localBgeM3Namespace(
  model: string,
  dimensions: number,
): string {
  const payload = JSON.stringify({
    backend: "local_bge_m3",
    model,
    dimensions,
    normalization: EMBEDDING_NORMALIZATION_VERSION,
    sparseContract: LOCAL_SPARSE_CONTRACT_VERSION,
  });
  return `emb_${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

function embeddingProviderKey(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host.endsWith("openai.com") ? "openai" : "openai-compatible";
  } catch {
    return "openai-compatible";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return providerIdentityUrl(baseUrl);
}

function parseRetryAfterSec(raw: string | null): number | undefined {
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

function parseEmbeddingPayload(source: string): EmbeddingsResponse {
  try {
    const parsed = JSON.parse(source) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as EmbeddingsResponse)
      : {};
  } catch {
    return {};
  }
}

async function readBoundedEmbeddingBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (/^\d+$/u.test(contentLength ?? "")) {
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared > MAX_EMBEDDING_RESPONSE_BYTES
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw embeddingResponseTooLarge();
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
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_EMBEDDING_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw embeddingResponseTooLarge();
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

function embeddingResponseTooLarge(): ToolError {
  return new ToolError({
    category: "internal",
    retryable: false,
    message:
      "Embedding API response exceeded 64 MiB. Reduce the embedding batch size or dimensions.",
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
    : new DOMException("Embedding request was aborted.", "AbortError");
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
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

export function vectorToBlob(vector: number[]): Buffer {
  if (
    vector.length === 0 ||
    vector.some(
      (value) =>
        !Number.isFinite(value) || !Number.isFinite(Math.fround(value)),
    )
  ) {
    throw new TypeError("Embedding vector must contain finite float values.");
  }
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index], index * Float32Array.BYTES_PER_ELEMENT);
  }
  return buffer;
}

export function blobToVector(
  blob: Uint8Array,
  expectedDimensions?: number,
): Float32Array {
  if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new TypeError("Embedding blob byte length must be divisible by 4.");
  }
  const buffer = Buffer.from(blob);
  const values = new Float32Array(buffer.length / Float32Array.BYTES_PER_ELEMENT);
  if (
    values.length === 0 ||
    (expectedDimensions !== undefined && values.length !== expectedDimensions)
  ) {
    throw new TypeError(
      expectedDimensions === undefined
        ? "Embedding blob must contain at least one dimension."
        : `Embedding blob expected ${expectedDimensions} dimensions but received ${values.length}.`,
    );
  }
  for (let index = 0; index < values.length; index += 1) {
    values[index] = buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
    if (!Number.isFinite(values[index])) {
      throw new TypeError("Embedding blob contains a non-finite value.");
    }
  }
  return values;
}

/**
 * Builds a scorer for a validated query vector without retaining any candidate
 * vector state. Candidate blobs are decoded and validated during each call.
 *
 * This is deliberately separate from `blobToVector`: callers that need a
 * materialized vector still receive an owned copy, while the dense retrieval
 * hot path can read a SQLite BLOB directly. On little-endian, aligned hosts a
 * `Float32Array` view is safe and allocation-free. Other hosts use a
 * little-endian `DataView` fallback, preserving the on-disk BLOB format.
 */
export function createBlobCosineScorer(
  normalizedLeft: ArrayLike<number>,
): (blob: Uint8Array, expectedDimensions?: number) => number {
  // Snapshot the already-validated query once. This prevents a mutable caller
  // from introducing a non-finite value after construction while keeping the
  // repeated candidate path allocation-free.
  const left = Array.from(normalizedLeft);
  for (let index = 0; index < left.length; index += 1) {
    if (!Number.isFinite(left[index])) {
      throw new TypeError("Cosine similarity requires finite vector values.");
    }
  }

  return (blob, expectedDimensions) => {
    if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new TypeError("Embedding blob byte length must be divisible by 4.");
    }
    const dimensions = blob.byteLength / Float32Array.BYTES_PER_ELEMENT;
    if (
      dimensions === 0 ||
      (expectedDimensions !== undefined && dimensions !== expectedDimensions)
    ) {
      throw new TypeError(
        expectedDimensions === undefined
          ? "Embedding blob must contain at least one dimension."
          : `Embedding blob expected ${expectedDimensions} dimensions but received ${dimensions}.`,
      );
    }
    if (left.length !== dimensions) {
      throw new TypeError("Cosine similarity requires vectors with the same dimensions.");
    }

    let score = 0;
    if (HOST_IS_LITTLE_ENDIAN && blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
      const values = new Float32Array(blob.buffer, blob.byteOffset, dimensions);
      for (let index = 0; index < dimensions; index += 1) {
        const value = values[index]!;
        if (!Number.isFinite(value)) {
          throw new TypeError("Embedding blob contains a non-finite value.");
        }
        score += left[index]! * value;
      }
      return score;
    }

    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    for (let index = 0; index < dimensions; index += 1) {
      const value = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
      if (!Number.isFinite(value)) {
        throw new TypeError("Embedding blob contains a non-finite value.");
      }
      score += left[index]! * value;
    }
    return score;
  };
}

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(
  new Uint16Array([1]).buffer,
)[0] === 1;

export function cosineSimilarity(normalizedLeft: ArrayLike<number>, normalizedRight: ArrayLike<number>): number {
  if (normalizedLeft.length !== normalizedRight.length) {
    throw new TypeError("Cosine similarity requires vectors with the same dimensions.");
  }
  const length = normalizedLeft.length;
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    if (
      !Number.isFinite(normalizedLeft[index]) ||
      !Number.isFinite(normalizedRight[index])
    ) {
      throw new TypeError("Cosine similarity requires finite vector values.");
    }
    score += normalizedLeft[index] * normalizedRight[index];
  }
  return score;
}

export function normalizeVector(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / norm);
}
