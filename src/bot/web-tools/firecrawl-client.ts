import {
  isPublicAddress,
  isPublicHttpsCandidate,
  lookupPublicAddresses,
  validatePublicHttpsUrl,
  type ResolvedAddress,
} from "../read-tools/public-address.js";
import {
  LoopbackJsonClient,
  LoopbackJsonResponseTooLargeError,
  LoopbackJsonTimeoutError,
  LoopbackJsonTransportError,
} from "./loopback-json.js";

const DEFAULT_FIRECRAWL_ORIGIN = "http://127.0.0.1:3002";
const DEFAULT_CRAWL_LIMIT = 3;
const MAX_CRAWL_LIMIT = 10;
const MAX_CRAWL_DEPTH = 3;
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;
const CANCEL_TIMEOUT_MS = 5_000;
const RAW_STATUS_MAX_BYTES = 2_000_000;
const MAX_PAGES = 5;
const MAX_PAGE_TEXT_CHARS = 8_000;
const MAX_PAGE_IMAGES = 6;
const MAX_ID_CHARS = 128;
const MAX_COUNT_BOUND = 1_000_000;
// Conservative job-id pattern: Firecrawl v2 ids are short URL-safe tokens.
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface FirecrawlCrawlParams {
  url: string;
  limit?: number;
  maxDepth?: number;
}

export interface FirecrawlPage {
  url: string;
  title?: string;
  markdown: string;
  truncated: boolean;
  images?: string[];
}

export interface FirecrawlCrawlResponse {
  ok: true;
  status: "done" | "empty";
  id: string;
  pages: FirecrawlPage[];
  completed: number;
  total: number;
  truncated: boolean;
}

export interface FirecrawlCrawlError {
  ok: false;
  error: { code: string; message: string };
}

export type FirecrawlCrawlResult = FirecrawlCrawlResponse | FirecrawlCrawlError;

export interface FirecrawlClientOptions {
  origin?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

type FirecrawlJobStatus =
  | "scraping"
  | "completed"
  | "failed"
  | "cancelled";

interface FirecrawlStatusBody {
  status: FirecrawlJobStatus;
  completed: number;
  total: number;
  data: Array<{
    markdown?: unknown;
    images?: unknown;
    metadata?: {
      title?: unknown;
      sourceURL?: unknown;
    };
  }>;
  pageCount: number;
}

/**
 * Firecrawl v2 adapter over the bounded loopback JSON transport. The bot
 * pre-resolves the crawl target and fails closed on private/special answers,
 * but the local crawler itself resolves independently; this adapter does not
 * claim to pin the crawler's own connections.
 */
export class FirecrawlClient {
  readonly #json: LoopbackJsonClient;
  readonly #pollIntervalMs: number;
  readonly #pollTimeoutMs: number;
  readonly #lookup: (hostname: string) => Promise<readonly ResolvedAddress[]>;

  constructor(options: FirecrawlClientOptions = {}) {
    this.#json = new LoopbackJsonClient({
      origin: options.origin ?? DEFAULT_FIRECRAWL_ORIGIN,
      timeoutMs: 30_000,
      maxResponseBytes: RAW_STATUS_MAX_BYTES,
      fetchImpl: options.fetchImpl,
    });
    this.#pollIntervalMs = boundedPollInterval(
      options.pollIntervalMs ?? POLL_INTERVAL_MS,
    );
    this.#pollTimeoutMs = boundedPollTimeout(
      options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    );
    this.#lookup = options.lookup ?? lookupPublicAddresses;
  }

  async crawl(
    params: FirecrawlCrawlParams,
    signal: AbortSignal,
  ): Promise<FirecrawlCrawlResult> {
    const validated = validateCrawlParams(params);
    if (!validated.ok) {
      return {
        ok: false,
        error: { code: "invalid_arguments", message: validated.message },
      };
    }

    // Sync pre-flight check, then fail-closed public-address pre-resolution.
    // This adapter never pins the crawler's own connections; the local
    // crawler resolves the target independently.
    let targetUrl: URL;
    try {
      targetUrl = validatePublicHttpsUrl(params.url);
      const addresses = await this.#lookup(targetUrl.hostname);
      if (
        addresses.length === 0 ||
        addresses.some((item) => !isPublicAddress(item))
      ) {
        throw new Error("private or unsupported address");
      }
    } catch {
      return {
        ok: false,
        error: {
          code: "unsafe_url",
          message:
            "Firecrawl target must be a public HTTPS URL without credentials.",
        },
      };
    }

    if (signal.aborted) {
      return {
        ok: false,
        error: { code: "aborted", message: "Operation aborted." },
      };
    }

    const body = JSON.stringify({
      url: targetUrl.toString(),
      limit: validated.limit,
      maxDiscoveryDepth: validated.maxDepth,
      sitemap: "skip",
      allowExternalLinks: false,
      allowSubdomains: false,
      crawlEntireDomain: false,
      scrapeOptions: {
        formats: ["markdown", "images"],
        onlyMainContent: true,
      },
    });

    let startResponse;
    try {
      startResponse = await this.#json.request({
        path: "/v2/crawl",
        method: "POST",
        body,
        signal,
      });
    } catch (error) {
      return mapTransportError(error, signal, "Firecrawl start");
    }
    if (startResponse.status < 200 || startResponse.status >= 300) {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: `Firecrawl returned HTTP ${startResponse.status}.`,
        },
      };
    }

    let startBody: Record<string, unknown>;
    try {
      startBody = parseJsonObject(startResponse.text);
    } catch {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: "Firecrawl start response unreadable.",
        },
      };
    }
    if (
      startBody.success !== true ||
      typeof startBody.id !== "string" ||
      !JOB_ID_PATTERN.test(startBody.id) ||
      startBody.id.length > MAX_ID_CHARS
    ) {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: "Firecrawl failed to start crawl job.",
        },
      };
    }
    const jobId = startBody.id;

    const startedAt = Date.now();
    try {
      while (true) {
        if (signal.aborted) {
          await this.#bestEffortCancel(jobId);
          return {
            ok: false,
            error: { code: "aborted", message: "Operation aborted." },
          };
        }
        // pollTimeoutMs is the hard deadline of the whole polling phase.
        const remaining = this.#pollTimeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) {
          await this.#bestEffortCancel(jobId);
          return {
            ok: false,
            error: { code: "timeout", message: "Firecrawl poll timed out." },
          };
        }

        // The first status GET goes out immediately; every GET is bounded by
        // the remaining budget so a completed job cannot arrive late.
        const status = await this.#pollStatus(jobId, signal, remaining);
        if (status === undefined) {
          await this.#bestEffortCancel(jobId);
          return {
            ok: false,
            error: {
              code: "provider_error",
              message: "Firecrawl status poll failed.",
            },
          };
        }
        // Timer slack may land the response just past the deadline: never
        // accept a completed job after it.
        if (Date.now() - startedAt > this.#pollTimeoutMs) {
          await this.#bestEffortCancel(jobId);
          return {
            ok: false,
            error: { code: "timeout", message: "Firecrawl poll timed out." },
          };
        }
        if (status.status === "completed") {
          return projectCompletedResult(jobId, status);
        }
        if (
          status.status === "failed" ||
          status.status === "cancelled"
        ) {
          return {
            ok: false,
            error: {
              code: "provider_error",
              message: `Firecrawl job ${status.status}.`,
            },
          };
        }
        // status === "scraping" — back off only after a poll, never longer
        // than the remaining budget.
        const sleepMs = Math.min(
          this.#pollIntervalMs,
          this.#pollTimeoutMs - (Date.now() - startedAt),
        );
        if (sleepMs > 0) {
          await sleep(sleepMs, signal);
        }
      }
    } catch (error) {
      await this.#bestEffortCancel(jobId);
      if (signal.aborted) {
        return {
          ok: false,
          error: { code: "aborted", message: "Operation aborted." },
        };
      }
      if (error instanceof LoopbackJsonTimeoutError) {
        return {
          ok: false,
          error: { code: "timeout", message: "Firecrawl poll timed out." },
        };
      }
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: "Firecrawl status poll failed.",
        },
      };
    }
  }

  async #pollStatus(
    jobId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<FirecrawlStatusBody | undefined> {
    let response;
    try {
      response = await this.#json.request({
        path: `/v2/crawl/${encodeURIComponent(jobId)}`,
        method: "GET",
        signal,
        timeoutMs,
      });
    } catch (error) {
      // Caller abort and own-timeout stay typed; only plain transport
      // failures degrade to the generic poll-failure path.
      if (signal.aborted) {
        throw error;
      }
      if (
        error instanceof LoopbackJsonTimeoutError ||
        error instanceof LoopbackJsonResponseTooLargeError
      ) {
        throw error;
      }
      if (error instanceof LoopbackJsonTransportError) {
        return undefined;
      }
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      return undefined;
    }
    try {
      return parseStatusBody(response.text);
    } catch {
      return undefined;
    }
  }

  async #bestEffortCancel(jobId: string): Promise<void> {
    try {
      await this.#json.request({
        path: `/v2/crawl/${encodeURIComponent(jobId)}`,
        method: "DELETE",
        timeoutMs: CANCEL_TIMEOUT_MS,
      });
    } catch {
      // Best-effort; swallow.
    }
  }
}

function mapTransportError(
  error: unknown,
  signal: AbortSignal,
  phase: string,
): FirecrawlCrawlResult {
  if (signal.aborted) {
    return {
      ok: false,
      error: { code: "aborted", message: "Operation aborted." },
    };
  }
  if (error instanceof LoopbackJsonTimeoutError) {
    return {
      ok: false,
      error: { code: "timeout", message: `${phase} request timed out.` },
    };
  }
  if (error instanceof LoopbackJsonResponseTooLargeError) {
    return {
      ok: false,
      error: {
        code: "provider_error",
        message: `${phase} response too large.`,
      },
    };
  }
  if (error instanceof LoopbackJsonTransportError) {
    return {
      ok: false,
      error: {
        code: "provider_unavailable",
        message: `${phase} request failed.`,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "provider_unavailable",
      message: `${phase} request failed.`,
    },
  };
}

function validateCrawlParams(params: FirecrawlCrawlParams): {
  ok: true;
  limit: number;
  maxDepth: number;
} | {
  ok: false;
  message: string;
} {
  let limit = DEFAULT_CRAWL_LIMIT;
  if (params.limit !== undefined) {
    if (
      !Number.isSafeInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > MAX_CRAWL_LIMIT
    ) {
      return {
        ok: false,
        message: `limit must be an integer between 1 and ${MAX_CRAWL_LIMIT}.`,
      };
    }
    limit = params.limit;
  }
  let maxDepth = 0;
  if (params.maxDepth !== undefined) {
    if (
      !Number.isSafeInteger(params.maxDepth) ||
      params.maxDepth < 0 ||
      params.maxDepth > MAX_CRAWL_DEPTH
    ) {
      return {
        ok: false,
        message: `maxDepth must be an integer between 0 and ${MAX_CRAWL_DEPTH}.`,
      };
    }
    maxDepth = params.maxDepth;
  }
  return { ok: true, limit, maxDepth };
}

function projectCompletedResult(
  jobId: string,
  status: FirecrawlStatusBody,
): FirecrawlCrawlResult {
  const pages: FirecrawlPage[] = [];
  const rawPages = Array.isArray(status.data) ? status.data : [];
  const capped = rawPages.slice(0, MAX_PAGES);
  let truncated = status.pageCount > MAX_PAGES || rawPages.length > MAX_PAGES;

  for (const entry of capped) {
    if (typeof entry !== "object" || entry === null) {
      truncated = true;
      continue;
    }
    const markdownRaw =
      typeof entry.markdown === "string" ? entry.markdown : "";
    const pageTruncated = markdownRaw.length > MAX_PAGE_TEXT_CHARS;
    if (pageTruncated) {
      // Page-level text truncation counts as result-level truncation even
      // when no pages were dropped.
      truncated = true;
    }
    const markdown = pageTruncated
      ? markdownRaw.slice(0, MAX_PAGE_TEXT_CHARS)
      : markdownRaw;
    const title =
      typeof entry.metadata?.title === "string"
        ? entry.metadata.title.trim().slice(0, 256)
        : undefined;
    const sourceUrl =
      typeof entry.metadata?.sourceURL === "string"
        ? entry.metadata.sourceURL.trim().slice(0, 2048)
        : undefined;
    // Only credential-free public HTTPS page URLs pass as evidence.
    const pageUrl = sourceUrl && isPublicHttpsCandidate(sourceUrl)
      ? sourceUrl
      : undefined;
    if (pageUrl === undefined) {
      truncated = true;
      continue;
    }

    let images: string[] | undefined;
    if (Array.isArray(entry.images)) {
      const safeImages: string[] = [];
      let imageDropped = false;
      for (const img of entry.images) {
        if (safeImages.length >= MAX_PAGE_IMAGES) {
          imageDropped = true;
          break;
        }
        if (
          typeof img === "string" &&
          img.length > 0 &&
          img.length <= 2048 &&
          isPublicHttpsCandidate(img)
        ) {
          safeImages.push(img);
        } else {
          imageDropped = true;
        }
      }
      if (safeImages.length > 0) images = safeImages;
      if (imageDropped || entry.images.length > safeImages.length) {
        truncated = true;
      }
    }

    pages.push({
      url: pageUrl,
      ...(title === undefined ? {} : { title }),
      markdown,
      truncated: pageTruncated,
      ...(images === undefined ? {} : { images }),
    });
  }

  if (pages.length === 0) {
    return {
      ok: true,
      status: "empty",
      id: jobId,
      pages: [],
      completed: status.completed,
      total: status.total,
      truncated,
    };
  }
  return {
    ok: true,
    status: "done",
    id: jobId,
    pages,
    completed: status.completed,
    total: status.total,
    truncated,
  };
}

function parseStatusBody(text: string): FirecrawlStatusBody {
  const raw = parseJsonObject(text);
  const statusValue = raw.status;
  if (
    statusValue !== "scraping" &&
    statusValue !== "completed" &&
    statusValue !== "failed" &&
    statusValue !== "cancelled"
  ) {
    throw new Error("invalid status");
  }
  const completed = requiredBoundedCount(raw.completed);
  const total = requiredBoundedCount(raw.total);
  if (completed > total) {
    throw new Error("completed exceeds total");
  }
  const rawData = Array.isArray(raw.data) ? raw.data : [];
  return {
    status: statusValue,
    completed,
    total,
    data: rawData.slice(0, MAX_PAGES + 1).map((entry) => {
      const item = entry as Record<string, unknown>;
      const metadata =
        typeof item.metadata === "object" && item.metadata !== null
          ? (item.metadata as Record<string, unknown>)
          : undefined;
      return {
        markdown: item.markdown,
        images: item.images,
        metadata: metadata === undefined
          ? undefined
          : {
              title: metadata.title,
              sourceURL: metadata.sourceURL,
            },
      };
    }),
    pageCount: rawData.length,
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("not an object");
  }
  return parsed as Record<string, unknown>;
}

function requiredBoundedCount(value: unknown): number {
  // Strict validation: completed and total must be present bounded integers
  // on every status response; absent or invalid counts fail the poll.
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_COUNT_BOUND
  ) {
    throw new Error("invalid count");
  }
  return value;
}

function boundedPollTimeout(value: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 600_000
  ) {
    throw new Error("pollTimeoutMs must be a positive safe integer.");
  }
  return value;
}

function boundedPollInterval(value: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 600_000
  ) {
    throw new Error(
      "pollIntervalMs must be a positive safe integer up to 600000.",
    );
  }
  return value;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
