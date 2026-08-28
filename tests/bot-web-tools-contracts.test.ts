import assert from "node:assert/strict";
import { test } from "node:test";
import { SearXNGClient } from "../src/bot/web-tools/searxng-client.js";
import { FirecrawlClient } from "../src/bot/web-tools/firecrawl-client.js";

const PUBLIC_LOOKUP = async (): Promise<readonly { address: string; family: 4 | 6 }[]> =>
  [{ address: "93.184.216.34", family: 4 }];

interface FakeRoute {
  method: string;
  path: string;
  status: number;
  body: string;
  calls?: number;
}

function fakeFetch(routes: FakeRoute[]): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = routes.find(
      (item) => item.method === method && url.pathname === item.path,
    );
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    route.calls = (route.calls ?? 0) + 1;
    return new Response(route.body, {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

// ─── Firecrawl abort during status poll ─────────────────────────────────────

test("Firecrawl abort during GET status returns aborted and deletes the job", async () => {
  let releaseGet!: () => void;
  const getGate = new Promise<void>((resolveGate) => {
    releaseGet = resolveGate;
  });
  let markGetStarted!: () => void;
  const getStarted = new Promise<void>((resolveStarted) => {
    markGetStarted = resolveStarted;
  });
  let deleteCalls = 0;
  let capturedSignal: AbortSignal | null | undefined;
  const controller = new AbortController();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input));
    if (url.pathname === "/v2/crawl" && method === "POST") {
      return new Response(
        JSON.stringify({ success: true, id: "job-1" }),
        { status: 200 },
      );
    }
    if (url.pathname === "/v2/crawl/job-1" && method === "GET") {
      capturedSignal = init?.signal;
      markGetStarted();
      // The fake captures the composed signal but ignores its abort until
      // the gate releases: the client must still surface the caller abort.
      await getGate;
      return new Response(
        JSON.stringify({ status: "scraping", completed: 0, total: 1, data: [] }),
        { status: 200 },
      );
    }
    if (url.pathname === "/v2/crawl/job-1" && method === "DELETE") {
      deleteCalls += 1;
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl,
    pollTimeoutMs: 60_000,
    pollIntervalMs: 10,
  });
  const promise = client.crawl(
    { url: "https://example.com/docs" },
    controller.signal,
  );
  await getStarted; // the GET status request has begun
  controller.abort(new Error("caller cancelled"));
  releaseGet();
  const result = await promise;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "aborted");
  assert.equal(deleteCalls, 1);
  assert.equal(capturedSignal?.aborted, true);
});

// ─── Firecrawl strict validation ────────────────────────────────────────────

test("Firecrawl rejects invalid counts instead of coercing to zero", async () => {
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl: fakeFetch([
      {
        method: "POST",
        path: "/v2/crawl",
        status: 200,
        body: JSON.stringify({ success: true, id: "job-1" }),
      },
      {
        method: "GET",
        path: "/v2/crawl/job-1",
        status: 200,
        body: JSON.stringify({
          status: "completed",
          completed: "many",
          total: 5,
          data: [],
        }),
      },
    ]),
    pollTimeoutMs: 60_000,
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "provider_error");
});

test("Firecrawl requires present bounded counts with completed <= total", async () => {
  const invalidBodies = [
    { status: "completed", total: 5, data: [] }, // missing completed
    { status: "completed", completed: 5, data: [] }, // missing total
    { status: "completed", completed: -1, total: 5, data: [] },
    { status: "completed", completed: 1.5, total: 5, data: [] },
    { status: "completed", completed: 6, total: 5, data: [] },
    { status: "scraping", completed: 2, total: 1, data: [] },
  ];
  for (const body of invalidBodies) {
    const client = new FirecrawlClient({
      lookup: PUBLIC_LOOKUP,
      fetchImpl: fakeFetch([
        {
          method: "POST",
          path: "/v2/crawl",
          status: 200,
          body: JSON.stringify({ success: true, id: "job-1" }),
        },
        {
          method: "GET",
          path: "/v2/crawl/job-1",
          status: 200,
          body: JSON.stringify(body),
        },
      ]),
      pollTimeoutMs: 60_000,
    });
    const result = await client.crawl(
      { url: "https://example.com/docs" },
      new AbortController().signal,
    );
    assert.equal(result.ok, false, JSON.stringify(body));
    if (!result.ok) assert.equal(result.error.code, "provider_error");
  }
});

test("Firecrawl rejects malformed job ids", async () => {
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl: fakeFetch([
      {
        method: "POST",
        path: "/v2/crawl",
        status: 200,
        body: JSON.stringify({ success: true, id: "job id with spaces!" }),
      },
    ]),
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "provider_error");
});

test("Firecrawl rejects invalid limit and maxDepth instead of clamping", async () => {
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl: fakeFetch([]),
  });
  for (const params of [
    { url: "https://example.com/docs", limit: Number.NaN },
    { url: "https://example.com/docs", limit: 2.5 },
    { url: "https://example.com/docs", limit: 0 },
    { url: "https://example.com/docs", limit: 11 },
    { url: "https://example.com/docs", maxDepth: Number.NaN },
    { url: "https://example.com/docs", maxDepth: -1 },
    { url: "https://example.com/docs", maxDepth: 4 },
  ]) {
    const result = await client.crawl(params, new AbortController().signal);
    assert.equal(result.ok, false, JSON.stringify(params));
    if (!result.ok) assert.equal(result.error.code, "invalid_arguments");
  }
});

test("Firecrawl marks truncation for image arrays and unsafe image URLs", async () => {
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl: fakeFetch([
      {
        method: "POST",
        path: "/v2/crawl",
        status: 200,
        body: JSON.stringify({ success: true, id: "job-1" }),
      },
      {
        method: "GET",
        path: "/v2/crawl/job-1",
        status: 200,
        body: JSON.stringify({
          status: "completed",
          completed: 1,
          total: 1,
          data: [
            {
              markdown: "# Page",
              metadata: { sourceURL: "https://example.com/a" },
              images: [
                "https://example.com/1.png",
                "http://localhost/private.png",
                "not a url",
                ...Array.from({ length: 10 }, (_, i) =>
                  `https://example.com/${i}.png`),
              ],
            },
          ],
        }),
      },
    ]),
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    // Unsafe/private entries dropped and the array capped → truncated.
    assert.equal(result.truncated, true);
    assert.equal(result.pages[0]!.images?.length, 6);
  }
});

// ─── SearXNG strict validation and truncation ───────────────────────────────

test("SearXNG rejects non-finite limits instead of returning empty", async () => {
  const client = new SearXNGClient({
    fetchImpl: fakeFetch([{ method: "GET", path: "/search", status: 200, body: "{}" }]),
  });
  for (const limit of [Number.NaN, 0, 11, 2.5, Number.POSITIVE_INFINITY]) {
    const result = await client.search(
      { query: "x", limit },
      new AbortController().signal,
    );
    assert.equal(result.ok, false, `limit ${limit}`);
    if (!result.ok) assert.equal(result.error.code, "invalid_arguments");
  }
});

test("SearXNG marks truncation when unsafe rows are omitted", async () => {
  const client = new SearXNGClient({
    fetchImpl: fakeFetch([{
      method: "GET",
      path: "/search",
      status: 200,
      body: JSON.stringify({
        results: [
          { title: "OK", url: "https://example.com/ok" },
          { title: "Private", url: "http://localhost/private" },
          { title: "OK2", url: "https://example.com/ok2" },
        ],
      }),
    }]),
  });
  const result = await client.search(
    { query: "x", limit: 5 },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.results.length, 2);
    // An unsafe row inside the window was omitted → truncated.
    assert.equal(result.truncated, true);
  }
});

test("SearXNG scans until safe results fill the limit", async () => {
  const client = new SearXNGClient({
    fetchImpl: fakeFetch([{
      method: "GET",
      path: "/search",
      status: 200,
      body: JSON.stringify({
        results: [
          { title: "Bad", url: "https://user:pass@example.com/x" },
          { title: "Bad2", url: "http://example.com/x" },
          { title: "OK", url: "https://example.com/ok" },
          { title: "OK2", url: "https://example.com/ok2" },
        ],
      }),
    }]),
  });
  const result = await client.search(
    { query: "x", limit: 2 },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0]!.url, "https://example.com/ok");
    assert.equal(result.results[1]!.url, "https://example.com/ok2");
  }
});
