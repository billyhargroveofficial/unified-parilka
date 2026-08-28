import assert from "node:assert/strict";
import { test } from "node:test";
import { FirecrawlClient } from "../src/bot/web-tools/firecrawl-client.js";

// ─── Fake helpers ───────────────────────────────────────────────────────────

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

async function settle(): Promise<void> {
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
}

function firecrawlRoutes(statusBody: string): FakeRoute[] {
  return [
    {
      method: "POST",
      path: "/v2/crawl",
      status: 200,
      body: JSON.stringify({ success: true, id: "job-1", url: "http://127.0.0.1:3002/v2/crawl" }),
    },
    { method: "GET", path: "/v2/crawl/job-1", status: 200, body: statusBody },
    { method: "DELETE", path: "/v2/crawl/job-1", status: 200, body: "{}" },
  ];
}

// ─── Firecrawl client ───────────────────────────────────────────────────────

test("Firecrawl start body is fail-closed and bounded", async () => {
  let capturedBody = "";
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith("/v2/crawl")) {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ success: true, id: "job-1" }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new FirecrawlClient({ fetchImpl, lookup: PUBLIC_LOOKUP, pollIntervalMs: 5 });
  const result = await client.crawl(
    { url: "https://example.com/docs", limit: 5, maxDepth: 2 },
    new AbortController().signal,
  );
  assert.equal(result.ok, false); // poll fails with 404 → provider_error
  const body = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.equal(body.url, "https://example.com/docs");
  assert.equal(body.limit, 5);
  assert.equal(body.maxDiscoveryDepth, 2);
  assert.equal(body.sitemap, "skip");
  assert.equal(body.allowExternalLinks, false);
  assert.equal(body.allowSubdomains, false);
  assert.equal(body.crawlEntireDomain, false);
  assert.deepEqual(body.scrapeOptions, {
    formats: ["markdown", "images"],
    onlyMainContent: true,
  });
});

test("Firecrawl start-poll-complete projection", async () => {
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    pollIntervalMs: 5,
    fetchImpl: fakeFetch(firecrawlRoutes(JSON.stringify({
      status: "completed",
      completed: 2,
      total: 2,
      data: [
        {
          markdown: "# Page A\n".repeat(50),
          metadata: { title: "A", sourceURL: "https://example.com/a" },
          images: ["https://example.com/a.png"],
        },
        {
          markdown: "# Page B",
          metadata: { title: "B", sourceURL: "http://localhost/private" },
        },
      ],
    }))),
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, "done");
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0]!.url, "https://example.com/a");
    assert.equal(result.pages[0]!.images?.[0], "https://example.com/a.png");
    // Private page dropped → truncated.
    assert.equal(result.truncated, true);
    assert.equal(result.completed, 2);
  }
});

test("Firecrawl truncates oversized markdown and page counts", async () => {
  const bigMarkdown = "x".repeat(12_000);
  const pages = Array.from({ length: 7 }, (_, i) => ({
    markdown: bigMarkdown,
    metadata: { sourceURL: `https://example.com/p${i}` },
  }));
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    pollIntervalMs: 5,
    fetchImpl: fakeFetch(firecrawlRoutes(JSON.stringify({
      status: "completed",
      completed: 7,
      total: 7,
      data: pages,
    }))),
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pages.length, 5); // MAX_PAGES
    assert.equal(result.pages[0]!.truncated, true);
    assert.equal(result.truncated, true);
    assert.ok(result.pages[0]!.markdown.length <= 8_000);
  }
});

test("Firecrawl ORs single-page markdown truncation into the result", async () => {
  // One oversized page with no page-count truncation: only the page-level
  // flag can mark the result truncated.
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    pollIntervalMs: 5,
    fetchImpl: fakeFetch(firecrawlRoutes(JSON.stringify({
      status: "completed",
      completed: 1,
      total: 1,
      data: [
        {
          markdown: "x".repeat(12_000),
          metadata: { title: "Big", sourceURL: "https://example.com/big" },
        },
      ],
    }))),
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0]!.truncated, true);
    assert.equal(result.truncated, true);
    assert.ok(result.pages[0]!.markdown.length <= 8_000);
  }
});

test("Firecrawl timeout aborts with a best-effort DELETE", async () => {
  const routes: FakeRoute[] = [
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
      body: JSON.stringify({ status: "scraping", completed: 0, total: 1, data: [] }),
    },
    { method: "DELETE", path: "/v2/crawl/job-1", status: 200, body: "{}" },
  ];
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl: fakeFetch(routes),
    pollIntervalMs: 5,
    pollTimeoutMs: 100,
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "timeout");
  assert.equal(routes[2]!.calls, 1); // DELETE was issued
});

test("Firecrawl caller abort during the start request returns aborted", async () => {
  let deleteCalls = 0;
  const controller = new AbortController();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (String(input).endsWith("/v2/crawl") && method === "POST") {
      // A signal-respecting upstream: the start request rejects on abort.
      await new Promise<void>((_, rejectGate) => {
        init?.signal?.addEventListener("abort", () => {
          rejectGate(
            init?.signal?.reason instanceof Error
              ? init.signal.reason
              : new DOMException("Aborted", "AbortError"),
          );
        }, { once: true });
      });
      return new Response(
        JSON.stringify({ success: true, id: "job-1" }),
        { status: 200 },
      );
    }
    if (String(input).endsWith("/v2/crawl/job-1") && method === "DELETE") {
      deleteCalls += 1;
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl,
    pollIntervalMs: 5,
    pollTimeoutMs: 60_000,
  });
  const promise = client.crawl(
    { url: "https://example.com/docs" },
    controller.signal,
  );
  await settle();
  controller.abort(); // abort while the start request is in flight
  const result = await promise;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "aborted");
  // The start never returned a job id, so there is nothing to cancel.
  assert.equal(deleteCalls, 0);
});

test("Firecrawl rejects private crawl targets", async () => {
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl: fakeFetch([]),
    pollIntervalMs: 5,
  });
  for (const url of [
    "https://localhost/x",
    "https://192.168.1.1/x",
    "http://example.com/x",
    "https://user:pass@example.com/x",
  ]) {
    const result = await client.crawl({ url }, new AbortController().signal);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "unsafe_url");
  }
});

test("Firecrawl sends the first status GET immediately", async () => {
  let getAt = 0;
  const startedAt = Date.now();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/v2/crawl") {
      return new Response(
        JSON.stringify({ success: true, id: "job-1" }),
        { status: 200 },
      );
    }
    if (method === "GET" && url.pathname === "/v2/crawl/job-1") {
      getAt = Date.now();
      return new Response(
        JSON.stringify({ status: "completed", completed: 1, total: 1, data: [] }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl,
    pollIntervalMs: 60_000, // a pre-poll sleep would blow the test timeout
    pollTimeoutMs: 60_000,
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  assert.ok(
    getAt - startedAt < 1_000,
    `first status GET fired after ${getAt - startedAt}ms`,
  );
});

test("Firecrawl never accepts completed after the poll deadline", async () => {
  let deleteCalls = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/v2/crawl") {
      return new Response(
        JSON.stringify({ success: true, id: "job-1" }),
        { status: 200 },
      );
    }
    if (method === "GET" && url.pathname === "/v2/crawl/job-1") {
      // A signal-ignoring upstream: the completed response lands after the
      // remaining poll budget and must be rejected as a timeout.
      await new Promise((resolveTick) => setTimeout(resolveTick, 200));
      return new Response(
        JSON.stringify({
          status: "completed",
          completed: 1,
          total: 1,
          data: [{ markdown: "x", metadata: { sourceURL: "https://example.com/x" } }],
        }),
        { status: 200 },
      );
    }
    if (method === "DELETE" && url.pathname === "/v2/crawl/job-1") {
      deleteCalls += 1;
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl,
    pollIntervalMs: 5,
    pollTimeoutMs: 100,
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "timeout");
  assert.equal(deleteCalls, 1);
});

test("Firecrawl caller abort during polling returns aborted with DELETE", async () => {
  let deleteCalls = 0;
  const controller = new AbortController();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/v2/crawl") {
      return new Response(
        JSON.stringify({ success: true, id: "job-1" }),
        { status: 200 },
      );
    }
    if (method === "GET" && url.pathname === "/v2/crawl/job-1") {
      return new Response(
        JSON.stringify({ status: "scraping", completed: 0, total: 1, data: [] }),
        { status: 200 },
      );
    }
    if (method === "DELETE" && url.pathname === "/v2/crawl/job-1") {
      deleteCalls += 1;
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    fetchImpl,
    pollIntervalMs: 60_000, // long back-off; the abort must cut it short
    pollTimeoutMs: 60_000,
  });
  const promise = client.crawl(
    { url: "https://example.com/docs" },
    controller.signal,
  );
  await settle();
  await settle();
  controller.abort(); // abort while the crawl backs off between polls
  const result = await promise;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "aborted");
  assert.equal(deleteCalls, 1);
});
