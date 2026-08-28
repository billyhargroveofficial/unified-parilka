import type {
  BotReadToolSuccess,
  PaperSearchProvider,
  PaperSearchResponse,
  PaperSearchResult,
  ReadToolEvidence,
} from "./contracts.js";
import {
  ReadToolExecutionError,
  success,
} from "./payload.js";
import {
  paperSearchResponseSchema,
  type PaperSearchArgs,
} from "./schemas.js";

const DEFAULT_PAPER_TIMEOUT_MS = 30_000;
const DEFAULT_PAPER_RATE_LIMIT_MS = 3_000;
// Ten Atom/JSON records, including their abstracts, fit comfortably within this
// bound while keeping an untrusted provider response small enough to parse.
const MAX_PAPER_RESPONSE_BYTES = 512 * 1024;
const ARXIV_BASE_URL = "https://export.arxiv.org/api/query";
const EUROPEPMC_BASE_URL =
  "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

let lastArxivCallMs = 0;

async function callPaperProvider(params: {
  provider: PaperSearchProvider;
  query: string;
  source: "arxiv" | "europepmc";
  maxResults: number;
  timeoutMs: number;
  externalSignal?: AbortSignal;
}): Promise<PaperSearchResponse> {
  return callPaperOperation({
    timeoutMs: params.timeoutMs,
    externalSignal: params.externalSignal,
    operation: (signal) =>
      params.provider.search({
        query: params.query,
        source: params.source,
        maxResults: params.maxResults,
        signal,
      }),
  });
}

async function callPublicPaperSearch(params: {
  query: string;
  source: "arxiv" | "europepmc";
  maxResults: number;
  timeoutMs: number;
  rateLimitMs: number;
  externalSignal?: AbortSignal;
}): Promise<PaperSearchResponse> {
  return callPaperOperation({
    timeoutMs: params.timeoutMs,
    externalSignal: params.externalSignal,
    operation: (signal) =>
      searchPublicPapers(
        params.query,
        params.source,
        params.maxResults,
        params.rateLimitMs,
        signal,
      ),
  });
}

async function callPaperOperation(params: {
  timeoutMs: number;
  externalSignal?: AbortSignal;
  operation: (signal: AbortSignal) => Promise<PaperSearchResponse>;
}): Promise<PaperSearchResponse> {
  const deadline = performance.now() + params.timeoutMs;
  if (params.externalSignal?.aborted) {
    const timedOut = abortSignalTimedOut(params.externalSignal);
    throw new ReadToolExecutionError(
      timedOut ? "timeout" : "aborted",
      timedOut,
      timedOut
        ? "Paper search timed out."
        : "Paper search was aborted.",
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  let externalTimedOut = false;
  const onExternalAbort = () => {
    externalTimedOut =
      params.externalSignal != null &&
      abortSignalTimedOut(params.externalSignal);
    controller.abort(params.externalSignal?.reason);
  };
  params.externalSignal?.addEventListener(
    "abort",
    onExternalAbort,
    { once: true },
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new ReadToolExecutionError(
        "timeout",
        true,
        `Paper search exceeded ${params.timeoutMs} ms.`,
      ),
    );
  }, params.timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(
          controller.signal.reason ??
            new ReadToolExecutionError(
              "aborted",
              false,
              "Paper search was aborted.",
            ),
        );
      },
      { once: true },
    );
  });

  try {
    const response = await Promise.race([
      Promise.resolve().then(() => params.operation(controller.signal)),
      aborted,
    ]);
    if (performance.now() >= deadline) {
      throw new ReadToolExecutionError(
        "timeout",
        true,
        `Paper search exceeded ${params.timeoutMs} ms.`,
      );
    }
    return response;
  } catch (error) {
    if (params.externalSignal?.aborted) {
      throw new ReadToolExecutionError(
        externalTimedOut ? "timeout" : "aborted",
        externalTimedOut,
        externalTimedOut
          ? "Paper search timed out."
          : "Paper search was aborted.",
      );
    }
    if (timedOut || performance.now() >= deadline) {
      throw new ReadToolExecutionError(
        "timeout",
        true,
        `Paper search exceeded ${params.timeoutMs} ms.`,
      );
    }
    if (error instanceof ReadToolExecutionError) {
      throw error;
    }
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      "Paper search failed.",
    );
  } finally {
    clearTimeout(timeout);
    params.externalSignal?.removeEventListener(
      "abort",
      onExternalAbort,
    );
  }
}

function abortSignalTimedOut(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    (("name" in reason &&
      (reason as { name?: unknown }).name === "TimeoutError") ||
      ("code" in reason &&
        (reason as { code?: unknown }).code === "timeout"))
  );
}

export async function executePaperSearch(
  provider: PaperSearchProvider | undefined,
  args: PaperSearchArgs,
  timeoutMs: number,
  rateLimitMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<BotReadToolSuccess> {
  const response = provider
    ? await callPaperProvider({
        provider,
        query: args.query,
        source: args.source,
        maxResults: args.max_results,
        timeoutMs,
        externalSignal,
      })
    : await callPublicPaperSearch({
        query: args.query,
        source: args.source,
        maxResults: args.max_results,
        timeoutMs,
        rateLimitMs,
        externalSignal,
      });

  const parsed = paperSearchResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      "Paper search provider returned an invalid response.",
    );
  }

  const papers = parsed.data.papers.slice(0, args.max_results);
  const text = formatPaperResults(papers);
  const evidence: ReadToolEvidence[] = papers.map((paper) => ({
    source: "paper",
    chat: null,
    message: null,
    speaker: { id: null, name: null },
    date: paper.year ?? null,
    text:
      paper.abstract?.trim() ||
      `${paper.title}. ${paper.authors.join(", ")}.`,
    url: paper.url,
    title: paper.title,
  }));

  return success(
    "paper_search",
    papers.length === 0 ? "empty" : "done",
    {
      query: args.query,
      source: args.source,
      resultCount: papers.length,
      text,
    },
    evidence,
  );
}

async function searchPublicPapers(
  query: string,
  source: "arxiv" | "europepmc",
  maxResults: number,
  rateLimitMs: number,
  signal: AbortSignal,
): Promise<PaperSearchResponse> {
  if (source === "arxiv") {
    return searchArxiv(
      query,
      maxResults,
      rateLimitMs,
      signal,
    );
  }
  return searchEuropePMC(
    query,
    maxResults,
    signal,
  );
}

async function searchArxiv(
  query: string,
  maxResults: number,
  rateLimitMs: number,
  signal: AbortSignal,
): Promise<PaperSearchResponse> {
  const elapsed = Date.now() - lastArxivCallMs;
  if (elapsed < rateLimitMs) {
    await sleep(rateLimitMs - elapsed, signal);
  }

  const url = new URL(ARXIV_BASE_URL);
  url.searchParams.set("search_query", `all:${query}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("sortBy", "relevance");
  url.searchParams.set("sortOrder", "descending");

  const response = await fetchPaperResponse(
    url.toString(),
    signal,
  );
  lastArxivCallMs = Date.now();

  rejectPaperRedirect(response, "arXiv");
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      `arXiv returned ${response.status}.`,
    );
  }
  const atom = await readBoundedPaperBody(response, signal);
  const papers = parseArxivAtom(atom, maxResults);
  throwIfPaperSearchAborted(signal);
  return {
    query,
    source: "arxiv",
    papers,
  };
}

async function searchEuropePMC(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<PaperSearchResponse> {
  const url = new URL(EUROPEPMC_BASE_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", String(maxResults));

  const response = await fetchPaperResponse(
    url.toString(),
    signal,
  );
  rejectPaperRedirect(response, "Europe PMC");
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      `Europe PMC returned ${response.status}.`,
    );
  }
  const json = JSON.parse(
    await readBoundedPaperBody(response, signal),
  ) as Record<string, unknown>;
  const papers = parseEuropePMC(json, maxResults);
  throwIfPaperSearchAborted(signal);
  return {
    query,
    source: "europepmc",
    papers,
  };
}

async function fetchPaperResponse(
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    signal,
    headers: { Accept: "application/atom+xml, application/json" },
    // The built-in endpoints are fixed HTTPS origins. Do not let a redirect
    // turn a paper lookup into a request to an unvalidated second target.
    redirect: "error",
  });
}

function rejectPaperRedirect(response: Response, provider: string): void {
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => undefined);
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      `${provider} redirected the request.`,
    );
  }
}

async function readBoundedPaperBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (/^\d+$/u.test(contentLength ?? "")) {
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared > MAX_PAPER_RESPONSE_BYTES
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw paperResponseTooLarge();
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
      throwIfPaperSearchAborted(signal);
      const chunk = await reader.read();
      throwIfPaperSearchAborted(signal);
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PAPER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw paperResponseTooLarge();
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

function paperResponseTooLarge(): ReadToolExecutionError {
  return new ReadToolExecutionError(
    "provider_error",
    false,
    "Paper search response exceeded the 512 KiB limit.",
  );
}

function throwIfPaperSearchAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new ReadToolExecutionError(
          "aborted",
          false,
          "Paper search was aborted.",
        );
  }
}

function parseArxivAtom(
  atom: string,
  maxResults: number,
): PaperSearchResult[] {
  const entries: PaperSearchResult[] = [];
  const entryRegex = /<entry[^>]*>[\s\S]*?<\/entry>/giu;
  let match: RegExpExecArray | null;
  while (
    (match = entryRegex.exec(atom)) !== null &&
    entries.length < maxResults
  ) {
    const entry = match[0];
    const title = stripXmlTags(firstTag(entry, "title"));
    const summary = stripXmlTags(firstTag(entry, "summary"));
    const published = firstTag(entry, "published").slice(0, 4);
    const id = firstTag(entry, "id");
    const authors: string[] = [];
    const authorRegex = /<author[^>]*>[\s\S]*?<\/author>/giu;
    let authorMatch: RegExpExecArray | null;
    while (
      (authorMatch = authorRegex.exec(entry)) !== null &&
      authors.length < 10
    ) {
      const name = stripXmlTags(firstTag(authorMatch[0], "name"));
      if (name) {
        authors.push(name);
      }
    }
    if (title) {
      entries.push({
        title,
        authors,
        ...(published ? { year: published } : {}),
        ...(summary ? { abstract: summary } : {}),
        url: id || `https://arxiv.org/abs/unknown`,
      });
    }
  }
  return entries;
}

function parseEuropePMC(
  json: Record<string, unknown>,
  maxResults: number,
): PaperSearchResult[] {
  const resultList =
    typeof json.resultList === "object" && json.resultList !== null
      ? (json.resultList as Record<string, unknown>)
      : {};
  const results = Array.isArray(resultList.result)
    ? resultList.result
    : [];
  const entries: PaperSearchResult[] = [];
  for (const item of results.slice(0, maxResults)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const title = String(record.title ?? "");
    const authors = String(record.authorString ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 10);
    const year = String(record.pubYear ?? "").slice(0, 4);
    const abstract = String(record.abstractText ?? "");
    const pmid = String(record.pmid ?? "");
    const pmcid = String(record.pmcid ?? "");
    const doi = String(record.doi ?? "");
    const url = pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      : pmcid
        ? `https://europepmc.org/article/PMC/${pmcid.replace("PMC", "")}`
        : doi
          ? `https://doi.org/${doi}`
          : "https://europepmc.org";
    if (title) {
      entries.push({
        title,
        authors,
        ...(year ? { year } : {}),
        ...(abstract ? { abstract } : {}),
        url,
      });
    }
  }
  return entries;
}

function firstTag(xml: string, tag: string): string {
  const regex = new RegExp(
    `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "iu",
  );
  const match = regex.exec(xml);
  return match?.[1] ?? "";
}

function stripXmlTags(value: string): string {
  return value
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatPaperResults(
  papers: readonly PaperSearchResult[],
): string {
  return papers
    .map((paper, index) => {
      const authors = paper.authors.slice(0, 3).join(", ");
      const more =
        paper.authors.length > 3
          ? ` +${paper.authors.length - 3}`
          : "";
      const year = paper.year ? ` (${paper.year})` : "";
      const abstract = paper.abstract
        ? `\n${paper.abstract.slice(0, 600)}`
        : "";
      return `${index + 1}. ${paper.title}${year}\n${authors}${more}\n${paper.url}${abstract}`;
    })
    .join("\n\n");
}

function sleep(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(
        signal.reason ?? new ReadToolExecutionError(
          "aborted",
          false,
          "Paper search was aborted during rate-limit wait.",
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export {
  DEFAULT_PAPER_TIMEOUT_MS,
  DEFAULT_PAPER_RATE_LIMIT_MS,
};
