import { isPublicHttpsCandidate } from "../read-tools/public-address.js";
import {
  LoopbackJsonClient,
  LoopbackJsonResponseTooLargeError,
  LoopbackJsonTimeoutError,
  LoopbackJsonTransportError,
} from "./loopback-json.js";

const DEFAULT_SEARXNG_ORIGIN = "http://127.0.0.1:8080";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 512_000;
const MAX_SEARXNG_RESULTS = 10;
const ALLOWED_LANGUAGES = new Set([
  "en", "ru", "de", "fr", "es", "it", "pt", "ja", "zh", "ko", "ar", "uk",
  "be", "kk", "tr", "pl", "nl", "sv", "no", "da", "fi",
]);

export type SearXNGSearchCategory = "general" | "news" | "images";
export type SearXNGTimeRange = "day" | "month" | "year";

export interface SearXNGSearchParams {
  query: string;
  category?: SearXNGSearchCategory;
  language?: string;
  pageno?: number;
  time_range?: SearXNGTimeRange;
  safesearch?: 0 | 1 | 2;
  limit: number;
}

export interface SearXNGSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
}

export interface SearXNGSearchResponse {
  ok: true;
  status: "done" | "empty";
  query: string;
  results: SearXNGSearchResultItem[];
  truncated: boolean;
}

export interface SearXNGSearchError {
  ok: false;
  error: { code: string; message: string };
}

export type SearXNGSearchResult = SearXNGSearchResponse | SearXNGSearchError;

export interface SearXNGClientOptions {
  origin?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export class SearXNGClient {
  readonly #json: LoopbackJsonClient;

  constructor(options: SearXNGClientOptions = {}) {
    this.#json = new LoopbackJsonClient({
      origin: options.origin ?? DEFAULT_SEARXNG_ORIGIN,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      fetchImpl: options.fetchImpl,
    });
  }

  async search(
    params: SearXNGSearchParams,
    signal: AbortSignal,
  ): Promise<SearXNGSearchResult> {
    const validation = validateSearchParams(params);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: validation.message,
        },
      };
    }
    if (signal.aborted) {
      return {
        ok: false,
        error: { code: "aborted", message: "Operation aborted." },
      };
    }

    const searchParams = new URLSearchParams();
    searchParams.set("q", validation.query);
    searchParams.set("format", "json");
    if (validation.category) {
      searchParams.set("categories", validation.category);
    }
    if (validation.language) {
      searchParams.set("language", validation.language);
    }
    if (validation.pageno !== undefined) {
      searchParams.set("pageno", String(validation.pageno));
    }
    if (validation.time_range) {
      searchParams.set("time_range", validation.time_range);
    }
    if (validation.safesearch !== undefined) {
      searchParams.set("safesearch", String(validation.safesearch));
    }

    let response;
    try {
      response = await this.#json.request({
        path: `/search?${searchParams.toString()}`,
        method: "GET",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        return {
          ok: false,
          error: { code: "aborted", message: "Operation aborted." },
        };
      }
      if (error instanceof LoopbackJsonTimeoutError) {
        return {
          ok: false,
          error: { code: "timeout", message: "SearXNG request timed out." },
        };
      }
      if (error instanceof LoopbackJsonResponseTooLargeError) {
        return {
          ok: false,
          error: {
            code: "provider_error",
            message: "SearXNG response too large.",
          },
        };
      }
      if (error instanceof LoopbackJsonTransportError) {
        return {
          ok: false,
          error: {
            code: "provider_unavailable",
            message: "SearXNG request failed.",
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "provider_unavailable",
          message: "SearXNG request failed.",
        },
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: `SearXNG returned HTTP ${response.status}.`,
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: "SearXNG returned invalid JSON.",
        },
      };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: "Unexpected response shape.",
        },
      };
    }

    const obj = parsed as Record<string, unknown>;
    const rawResults = Array.isArray(obj.results) ? obj.results : [];
    // Scan raw rows until `limit` safe results are collected; malformed or
    // unsafe rows are omitted and counted as truncation.
    const projected: SearXNGSearchResultItem[] = [];
    let scanned = 0;
    for (const entry of rawResults) {
      if (projected.length >= validation.limit) {
        break;
      }
      scanned += 1;
      const item = projectResult(entry);
      if (item) {
        projected.push(item);
      }
    }

    const truncated =
      rawResults.length > validation.limit || scanned > projected.length;
    if (projected.length === 0) {
      return {
        ok: true,
        status: "empty",
        query: validation.query,
        results: [],
        truncated,
      };
    }
    return {
      ok: true,
      status: "done",
      query: validation.query,
      results: projected,
      truncated,
    };
  }
}

function projectResult(entry: unknown): SearXNGSearchResultItem | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const e = entry as Record<string, unknown>;
  const title = stringField(e.title, 256);
  const url = stringField(e.url, 2048);
  // Only credential-free public HTTPS URLs pass as evidence.
  if (!title || !url || !isPublicHttpsCandidate(url)) {
    return undefined;
  }
  const item: SearXNGSearchResultItem = { title, url };
  const snippet = stringField(e.content ?? e.snippet, 200);
  if (snippet) item.snippet = snippet;
  const publishedAt = stringField(e.publishedDate ?? e.published, 64);
  if (publishedAt) item.publishedAt = publishedAt;
  const imageUrl = stringField(e.img_src ?? e.image, 2048);
  if (imageUrl && isPublicHttpsCandidate(imageUrl)) item.imageUrl = imageUrl;
  const thumbnailUrl = stringField(e.thumbnail ?? e.thumbnail_src, 2048);
  if (thumbnailUrl && isPublicHttpsCandidate(thumbnailUrl)) {
    item.thumbnailUrl = thumbnailUrl;
  }
  return item;
}

function stringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}

function validateSearchParams(params: SearXNGSearchParams): {
  ok: true;
  query: string;
  category?: SearXNGSearchCategory;
  language?: string;
  pageno?: number;
  time_range?: SearXNGTimeRange;
  safesearch?: 0 | 1 | 2;
  limit: number;
} | {
  ok: false;
  message: string;
} {
  const query = params.query.trim();
  if (query.length === 0 || query.length > 500) {
    return {
      ok: false,
      message: "query must be between 1 and 500 characters.",
    };
  }
  if (
    params.category !== undefined &&
    params.category !== "general" &&
    params.category !== "news" &&
    params.category !== "images"
  ) {
    return { ok: false, message: "category must be general, news, or images." };
  }
  let language: string | undefined;
  if (params.language !== undefined) {
    const lang = params.language.toLowerCase().trim();
    if (!ALLOWED_LANGUAGES.has(lang)) {
      return { ok: false, message: "language is not supported." };
    }
    language = lang;
  }
  let pageno: number | undefined;
  if (params.pageno !== undefined) {
    if (
      !Number.isSafeInteger(params.pageno) ||
      params.pageno < 1 ||
      params.pageno > 10
    ) {
      return { ok: false, message: "page must be between 1 and 10." };
    }
    pageno = params.pageno;
  }
  if (
    params.time_range !== undefined &&
    params.time_range !== "day" &&
    params.time_range !== "month" &&
    params.time_range !== "year"
  ) {
    return { ok: false, message: "time_range must be day, month, or year." };
  }
  if (
    params.safesearch !== undefined &&
    ![0, 1, 2].includes(params.safesearch)
  ) {
    return { ok: false, message: "safesearch must be 0, 1, or 2." };
  }
  if (
    !Number.isSafeInteger(params.limit) ||
    params.limit < 1 ||
    params.limit > MAX_SEARXNG_RESULTS
  ) {
    return {
      ok: false,
      message: `limit must be an integer between 1 and ${MAX_SEARXNG_RESULTS}.`,
    };
  }
  const limit = params.limit;
  return {
    ok: true,
    query,
    limit,
    ...(params.category === undefined ? {} : { category: params.category }),
    ...(language === undefined ? {} : { language }),
    ...(pageno === undefined ? {} : { pageno }),
    ...(params.time_range === undefined
      ? {}
      : { time_range: params.time_range }),
    ...(params.safesearch === undefined
      ? {}
      : { safesearch: params.safesearch }),
  };
}
