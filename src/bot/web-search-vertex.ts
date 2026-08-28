import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type {
  WebSearchProvider,
  WebSearchResponse,
  WebSearchSource,
} from "./read-tools.js";
import {
  WebSearchHttpError,
  WebSearchProtocolError,
  WebSearchTransportError,
} from "./web-search.js";

/**
 * Bot-owned Vertex Gemini web-search provider.
 *
 * Mirrors the proven par-lang-bot approach: Gemini is a search proxy, not the
 * answering model. A single `generateContent` call carries `googleSearch`
 * grounding, the visible answer is returned verbatim and the grounding chunks
 * become attributed sources. Authentication reuses the operator's Application
 * Default Credentials via `gcloud auth application-default print-access-token`
 * (a one-hour user token, cached well inside its lifetime), exactly as the
 * embedding client does — there is no API key and no rulesync MCP involved.
 *
 * All network and credential access is dependency-injected so tests never
 * touch gcloud or Vertex: pass `fetch` and `getAccessToken` to isolate the
 * parser, or omit them in production to use the real ADC + global fetch path.
 */

export const VERTEX_WEB_SEARCH_DEFAULT_PROJECT =
  "project-2eb13fe3-79a9-4d2b-83c";
export const VERTEX_WEB_SEARCH_DEFAULT_MODEL = "gemini-3.6-flash";
export const VERTEX_WEB_SEARCH_DEFAULT_REGION = "global";
export const VERTEX_WEB_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS = 2000;
export const VERTEX_WEB_SEARCH_DEFAULT_INSTRUCTION =
  "Ты поисковый помощник. Ответь на запрос по свежим данным из поиска, " +
  "по-русски, сжато — 2-5 предложений. Только факты из найденного, без воды " +
  "и без предложений помочь ещё. Если ничего внятного не нашлось — так и скажи.";

const TOKEN_REFRESH_MS = 30 * 60 * 1000;
const GCLOUD_TOKEN_TIMEOUT_MS = 30_000;
const MAX_QUERY_CHARS = 500;
const MAX_TEXT_CHARS = 4000;
const MAX_SOURCES = 5;
const MAX_RESPONSE_BYTES = 256_000;
const EMPTY_SEARCH_TEXT = "Поиск ничего не вернул.";
const CITATION_MARKER = /\s*\[\d+(?:,\s*\d+)*\]?/gu;

export interface VertexGeminiWebSearchProviderOptions {
  readonly project: string;
  readonly model?: string;
  readonly region?: string;
  readonly maxOutputTokens?: number;
  readonly systemInstruction?: string;
  readonly gcloudPath?: string;
  readonly fetch?: typeof fetch;
  readonly getAccessToken?: () => Promise<string> | string;
  readonly now?: () => number;
}

export class VertexGeminiWebSearchProvider
  implements WebSearchProvider
{
  readonly #project: string;
  readonly #model: string;
  readonly #region: string;
  readonly #maxOutputTokens: number;
  readonly #systemInstruction: string;
  readonly #fetch: typeof fetch;
  readonly #getAccessToken: () => Promise<string>;
  readonly #now: () => number;
  readonly #gcloudPath: string | undefined;
  #cachedToken: { value: string; at: number } | undefined;

  constructor(options: VertexGeminiWebSearchProviderOptions) {
    this.#project = validateIdentifier(
      options.project,
      "project",
      128,
    );
    this.#model = validateIdentifier(
      options.model ?? VERTEX_WEB_SEARCH_DEFAULT_MODEL,
      "model",
      80,
    );
    this.#region = validateIdentifier(
      options.region ?? VERTEX_WEB_SEARCH_DEFAULT_REGION,
      "region",
      32,
    );
    this.#maxOutputTokens = validateMaxOutputTokens(
      options.maxOutputTokens ??
        VERTEX_WEB_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
    );
    this.#systemInstruction = validateBounded(
      options.systemInstruction ??
        VERTEX_WEB_SEARCH_DEFAULT_INSTRUCTION,
      "systemInstruction",
      4_000,
    );
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    if (options.getAccessToken !== undefined) {
      const injected = options.getAccessToken;
      this.#getAccessToken = async () => {
        const token = await injected();
        return validateAccessToken(token);
      };
      this.#gcloudPath = options.gcloudPath;
    } else {
      // Fail fast at construction when the operator-selected binary is
      // missing; the default ADC path is resolved eagerly so a broken
      // deployment surfaces at startup, not mid-turn.
      this.#gcloudPath = resolveGcloudPath(options.gcloudPath);
      this.#getAccessToken = () => this.#adcToken();
    }
  }

  async search(request: {
    query: string;
    signal: AbortSignal;
  }): Promise<WebSearchResponse> {
    throwIfAborted(request.signal);
    const query = request.query.trim();
    if (!query || query.length > MAX_QUERY_CHARS) {
      throw new WebSearchProtocolError("INVALID_QUERY");
    }

    const token = await this.#getAccessToken();
    throwIfAborted(request.signal);

    const url =
      `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.#project)}` +
      `/locations/${encodeURIComponent(this.#region)}` +
      `/publishers/google/models/${encodeURIComponent(this.#model)}:generateContent`;
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: query }] }],
      systemInstruction: {
        parts: [{ text: this.#systemInstruction }],
      },
      tools: [{ googleSearch: {} }],
      generationConfig: {
        maxOutputTokens: this.#maxOutputTokens,
        temperature: 0.2,
      },
    });

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "x-goog-user-project": this.#project,
        },
        body,
        signal: request.signal,
        redirect: "error",
      });
    } catch (error) {
      throwIfAborted(request.signal);
      throw new WebSearchTransportError(
        safeTransportCode(error),
        error,
      );
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new WebSearchHttpError(response.status);
    }

    const raw = await readBoundedText(
      response,
      request.signal,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new WebSearchProtocolError("INVALID_JSON", error);
    }
    return parseGenerateContent(payload);
  }

  async #adcToken(): Promise<string> {
    const cached = this.#cachedToken;
    if (
      cached !== undefined &&
      this.#now() - cached.at < TOKEN_REFRESH_MS
    ) {
      return cached.value;
    }
    const gcloudPath =
      this.#gcloudPath ?? resolveGcloudPath(undefined);
    const value = await execGcloudAccessToken(gcloudPath);
    this.#cachedToken = { value, at: this.#now() };
    return value;
  }
}

function parseGenerateContent(input: unknown): WebSearchResponse {
  if (!isRecord(input)) {
    throw new WebSearchProtocolError("INVALID_RESPONSE");
  }
  const candidates = input.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { text: EMPTY_SEARCH_TEXT };
  }
  const candidate = candidates[0];
  if (!isRecord(candidate)) {
    throw new WebSearchProtocolError("INVALID_RESPONSE");
  }
  const content = isRecord(candidate.content)
    ? candidate.content
    : undefined;
  const parts =
    content !== undefined && Array.isArray(content.parts)
      ? content.parts
      : [];
  const rawText = parts
    .map((part) =>
      isRecord(part) && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
  const text = stripCitations(rawText).slice(0, MAX_TEXT_CHARS);
  const sources = extractSources(candidate);
  const finalText = text.length > 0 ? text : EMPTY_SEARCH_TEXT;
  return sources.length > 0
    ? { text: finalText, sources }
    : { text: finalText };
}

function extractSources(candidate: Record<string, unknown>): WebSearchSource[] {
  const metadata = isRecord(candidate.groundingMetadata)
    ? candidate.groundingMetadata
    : undefined;
  if (metadata === undefined) {
    return [];
  }
  const chunks = Array.isArray(metadata.groundingChunks)
    ? metadata.groundingChunks
    : [];
  const sources: WebSearchSource[] = [];
  for (const chunk of chunks) {
    if (sources.length >= MAX_SOURCES) {
      break;
    }
    if (!isRecord(chunk)) {
      continue;
    }
    const web = isRecord(chunk.web) ? chunk.web : undefined;
    if (web === undefined) {
      continue;
    }
    const url = safeSourceUrl(
      typeof web.uri === "string" ? web.uri : undefined,
    );
    if (url === undefined) {
      continue;
    }
    const title =
      typeof web.title === "string" &&
      web.title.trim().length > 0 &&
      web.title.length <= 500
        ? web.title.trim()
        : undefined;
    sources.push(
      title === undefined ? { url } : { url, title },
    );
  }
  return sources;
}

function safeSourceUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "https:" &&
      parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  ) {
    return undefined;
  }
  return parsed.toString();
}

function stripCitations(text: string): string {
  return text.replace(CITATION_MARKER, "").trim();
}

function execGcloudAccessToken(gcloudPath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      gcloudPath,
      ["auth", "application-default", "print-access-token"],
      {
        // gcloud is a Python script, so the interpreter must come from PATH
        // (the systemd unit PATH includes /usr/bin/python3). Pinning
        // CLOUDSDK_PYTHON to the Node binary — as a Python bot would — makes
        // gcloud exit with "bad option: -S", so the environment is inherited
        // untouched instead.
        timeout: GCLOUD_TOKEN_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectPromise(
            new WebSearchTransportError(
              "GCLOUD_ADC_TOKEN_FAILED",
              error,
            ),
          );
          return;
        }
        try {
          resolvePromise(validateAccessToken(stdout));
        } catch (validationError) {
          rejectPromise(validationError);
        }
        void stderr;
      },
    );
  });
}

function resolveGcloudPath(custom: string | undefined): string {
  if (custom !== undefined) {
    const resolved = resolvePath(custom);
    if (isExecutable(resolved)) {
      return resolved;
    }
    throw new Error(
      "PARILKA_GCLOUD_PATH must point to an executable gcloud binary.",
    );
  }
  const candidates = [
    ...gcloudPathFromEnvPath(),
    resolvePath(homedir(), ".local/bin/gcloud"),
    resolvePath(homedir(), "google-cloud-sdk/bin/gcloud"),
    "/usr/local/bin/gcloud",
    "/opt/homebrew/bin/gcloud",
    "/snap/bin/gcloud",
    "/usr/bin/gcloud",
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "gcloud was not found in PATH or standard locations; install the Google Cloud SDK or set PARILKA_GCLOUD_PATH.",
  );
}

function gcloudPathFromEnvPath(): string[] {
  const rawPath = process.env.PATH;
  if (!rawPath) {
    return [];
  }
  return rawPath
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolvePath(entry, "gcloud"));
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function validateAccessToken(raw: string): string {
  const token = raw.trim();
  if (
    !token ||
    token.length > 16_384 ||
    /[\r\n]/u.test(token)
  ) {
    throw new WebSearchTransportError(
      "GCLOUD_ADC_TOKEN_INVALID",
    );
  }
  return token;
}

function validateIdentifier(
  value: string,
  name: string,
  maximum: number,
): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > maximum ||
    !/^[A-Za-z0-9._-]+$/u.test(trimmed)
  ) {
    throw new TypeError(
      `${name} must be a non-empty identifier of at most ${maximum} characters.`,
    );
  }
  return trimmed;
}

function validateMaxOutputTokens(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 8_192
  ) {
    throw new TypeError(
      "maxOutputTokens must be an integer between 1 and 8192.",
    );
  }
  return value;
}

function validateBounded(
  value: string,
  name: string,
  maximum: number,
): string {
  const flattened = value.replace(/\s+/gu, " ").trim();
  if (!flattened || flattened.length > maximum) {
    throw new TypeError(
      `${name} must contain between 1 and ${maximum} characters.`,
    );
  }
  return flattened;
}

async function readBoundedText(
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
      if (byteCount > MAX_RESPONSE_BYTES) {
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

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
