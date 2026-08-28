import type {
  WebSearchProvider,
  WebSearchResponse,
  WebSearchSource,
} from "./read-tools.js";

const MAX_WEB_RESPONSE_CHARS = 128_000;
const MAX_WEB_SOURCES = 10;

export interface HttpJsonWebSearchProviderOptions {
  endpoint: string;
  bearerToken?: string;
  fetch?: typeof fetch;
}

/**
 * Small provider-neutral HTTP boundary for optional external search.
 *
 * The endpoint owns any vendor-specific integration and receives only
 * `{ "query": string }`. The bot expects a stable JSON response shaped as
 * `{ "text": string, "sources"?: [...] }`, so swapping a subscription never
 * changes the model-facing tool contract.
 */
export class HttpJsonWebSearchProvider implements WebSearchProvider {
  readonly #endpoint: string;
  readonly #bearerToken: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: HttpJsonWebSearchProviderOptions) {
    this.#endpoint = validateEndpoint(options.endpoint);
    this.#bearerToken = validateToken(options.bearerToken);
    this.#fetch = options.fetch ?? fetch;
  }

  async search(request: {
    query: string;
    signal: AbortSignal;
  }): Promise<WebSearchResponse> {
    throwIfAborted(request.signal);
    const query = request.query.trim();
    if (!query || query.length > 500) {
      throw new WebSearchProtocolError("INVALID_QUERY");
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          ...(this.#bearerToken === undefined
            ? {}
            : {
                authorization: `Bearer ${this.#bearerToken}`,
              }),
        },
        body: JSON.stringify({ query }),
        signal: request.signal,
        // Redirects are not allowed to replace the operator-validated
        // HTTPS/loopback destination with an unvalidated internal target.
        redirect: "error",
      });
    } catch (error) {
      throwIfAborted(request.signal);
      throw new WebSearchTransportError(safeTransportCode(error), error);
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new WebSearchHttpError(response.status);
    }
    const declaredLength = boundedContentLength(
      response.headers.get("content-length"),
    );
    if (
      declaredLength !== undefined &&
      declaredLength > MAX_WEB_RESPONSE_CHARS
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new WebSearchProtocolError("RESPONSE_TOO_LARGE");
    }

    const source = await readBoundedBody(
      response,
      request.signal,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(source) as unknown;
    } catch (error) {
      throw new WebSearchProtocolError("INVALID_JSON", error);
    }
    return parseResponse(payload);
  }
}

export class WebSearchHttpError extends Error {
  readonly name = "WebSearchHttpError";
  readonly code: string;

  constructor(readonly status: number) {
    super("The configured web-search endpoint rejected the request.");
    this.code =
      Number.isInteger(status) && status >= 100 && status <= 599
        ? `WEB_SEARCH_HTTP_${status}`
        : "WEB_SEARCH_HTTP_ERROR";
  }
}

export class WebSearchTransportError extends Error {
  readonly name = "WebSearchTransportError";

  constructor(readonly code: string, cause?: unknown) {
    super(
      "The configured web-search endpoint could not be reached.",
      cause === undefined ? undefined : { cause },
    );
  }
}

export class WebSearchProtocolError extends Error {
  readonly name = "WebSearchProtocolError";

  constructor(readonly code: string, cause?: unknown) {
    super(
      "The configured web-search endpoint returned an invalid response.",
      cause === undefined ? undefined : { cause },
    );
  }
}

function parseResponse(input: unknown): WebSearchResponse {
  if (!isRecord(input)) {
    throw new WebSearchProtocolError("INVALID_RESPONSE");
  }
  const text =
    typeof input.text === "string" ? input.text.trim() : undefined;
  if (text === undefined || text.length > 8_000) {
    throw new WebSearchProtocolError("INVALID_TEXT");
  }

  let sources: WebSearchSource[] | undefined;
  if (input.sources !== undefined) {
    if (
      !Array.isArray(input.sources) ||
      input.sources.length > MAX_WEB_SOURCES
    ) {
      throw new WebSearchProtocolError("INVALID_SOURCES");
    }
    sources = input.sources.map(parseSource);
  }
  return {
    text,
    ...(sources === undefined ? {} : { sources }),
  };
}

function parseSource(input: unknown): WebSearchSource {
  if (!isRecord(input) || typeof input.url !== "string") {
    throw new WebSearchProtocolError("INVALID_SOURCE");
  }
  const url = validateSourceUrl(input.url);
  const title = optionalBoundedString(input.title, 500, "INVALID_SOURCE_TITLE");
  const snippet = optionalBoundedString(
    input.snippet,
    4_000,
    "INVALID_SOURCE_SNIPPET",
  );
  const publishedAt = optionalBoundedString(
    input.publishedAt,
    100,
    "INVALID_SOURCE_DATE",
  );
  const extraKeys = Object.keys(input).filter(
    (key) =>
      key !== "url" &&
      key !== "title" &&
      key !== "snippet" &&
      key !== "publishedAt",
  );
  if (extraKeys.length > 0) {
    throw new WebSearchProtocolError("INVALID_SOURCE_FIELDS");
  }
  return {
    url,
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

function validateEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TypeError("endpoint must be an absolute URL.");
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        isLoopbackHostname(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "endpoint must use HTTPS (or loopback HTTP) and contain no credentials, query, or fragment.",
    );
  }
  return url.toString();
}

function validateSourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebSearchProtocolError("INVALID_SOURCE_URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new WebSearchProtocolError("INVALID_SOURCE_URL");
  }
  return url.toString();
}

function validateToken(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const token = raw.trim();
  if (!token || token.length > 16_384) {
    throw new TypeError(
      "bearerToken must contain between 1 and 16384 characters.",
    );
  }
  return token;
}

function optionalBoundedString(
  value: unknown,
  maximum: number,
  code: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maximum) {
    throw new WebSearchProtocolError(code);
  }
  return value;
}

function boundedContentLength(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/u.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let byteCount = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteCount += chunk.value.byteLength;
      if (byteCount > MAX_WEB_RESPONSE_CHARS) {
        await reader.cancel().catch(() => undefined);
        throw new WebSearchProtocolError("RESPONSE_TOO_LARGE");
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    if (error instanceof WebSearchProtocolError) {
      throw error;
    }
    await reader.cancel().catch(() => undefined);
    throwIfAborted(signal);
    throw new WebSearchProtocolError("INVALID_RESPONSE_BODY", error);
  } finally {
    reader.releaseLock();
  }
}

function safeTransportCode(error: unknown): string {
  if (isRecord(error)) {
    const candidate =
      typeof error.code === "string"
        ? error.code
        : typeof error.name === "string"
          ? error.name
          : undefined;
    if (
      candidate &&
      /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(candidate)
    ) {
      return candidate.toUpperCase();
    }
  }
  return "WEB_SEARCH_TRANSPORT_ERROR";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException(
          "Web search was aborted.",
          "AbortError",
        );
  }
}

function isLoopbackHostname(raw: string): boolean {
  const hostname =
    raw.startsWith("[") && raw.endsWith("]")
      ? raw.slice(1, -1)
      : raw;
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
