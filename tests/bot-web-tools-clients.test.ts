import assert from "node:assert/strict";
import { test } from "node:test";
import { SearXNGClient } from "../src/bot/web-tools/searxng-client.js";

// ─── Fake helpers ───────────────────────────────────────────────────────────

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

// ─── SearXNG client ─────────────────────────────────────────────────────────

test("SearXNG request shape, projection and bounds", async () => {
  const routes: FakeRoute[] = [{
    method: "GET",
    path: "/search",
    status: 200,
    body: JSON.stringify({
      results: [
        {
          title: "Первый",
          url: "https://example.com/a",
          content: "snippet",
          publishedDate: "2026-07-30",
        },
        {
          title: "Приватный",
          url: "http://localhost/private",
          content: "snippet",
        },
        {
          title: "С креденшелами",
          url: "https://user:pass@example.com/b",
          content: "snippet",
        },
        {
          title: "Без полей",
        },
      ],
    }),
  }];
  const client = new SearXNGClient({ fetchImpl: fakeFetch(routes) });
  const result = await client.search({
    query: "тест",
    category: "news",
    language: "ru",
    time_range: "month",
    pageno: 2,
    limit: 10,
  }, new AbortController().signal);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.url, "https://example.com/a");
    assert.equal(result.results[0]!.snippet, "snippet");
    assert.equal(result.results[0]!.publishedAt, "2026-07-30");
    // Unsafe/malformed rows were omitted → the projection is truncated.
    assert.equal(result.truncated, true);
  }
  assert.equal(routes[0]!.calls, 1);
});

test("SearXNG sends exact bounded query parameters", async () => {
  let capturedUrl = "";
  const fetchImpl = (async (input: string | URL) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;
  const client = new SearXNGClient({ fetchImpl });
  await client.search({
    query: "новости",
    category: "images",
    language: "en",
    pageno: 3,
    time_range: "day",
    safesearch: 2,
    limit: 7,
  }, new AbortController().signal);
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("q"), "новости");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("categories"), "images");
  assert.equal(url.searchParams.get("language"), "en");
  assert.equal(url.searchParams.get("pageno"), "3");
  assert.equal(url.searchParams.get("time_range"), "day");
  assert.equal(url.searchParams.get("safesearch"), "2");
});

test("SearXNG caps results to limit and reports truncation", async () => {
  const results = Array.from({ length: 12 }, (_, i) => ({
    title: `T${i}`,
    url: `https://example.com/${i}`,
  }));
  const client = new SearXNGClient({
    fetchImpl: fakeFetch([{
      method: "GET",
      path: "/search",
      status: 200,
      body: JSON.stringify({ results }),
    }]),
  });
  const result = await client.search({ query: "x", limit: 5 },
    new AbortController().signal);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.results.length, 5);
    assert.equal(result.truncated, true);
  }
});

test("SearXNG validation bounds and malformed responses", async () => {
  const client = new SearXNGClient({
    fetchImpl: fakeFetch([{ method: "GET", path: "/search", status: 200, body: "not-json" }]),
  });
  const signal = new AbortController().signal;

  const emptyQuery = await client.search({ query: "", limit: 5 }, signal);
  assert.equal(emptyQuery.ok, false);
  if (!emptyQuery.ok) assert.equal(emptyQuery.error.code, "invalid_arguments");

  const longQuery = await client.search({ query: "x".repeat(501), limit: 5 }, signal);
  assert.equal(longQuery.ok, false);

  const badLanguage = await client.search({ query: "x", language: "zz", limit: 5 }, signal);
  assert.equal(badLanguage.ok, false);

  const badPage = await client.search({ query: "x", pageno: 11, limit: 5 }, signal);
  assert.equal(badPage.ok, false);

  const malformed = await client.search({ query: "x", limit: 5 }, signal);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "provider_error");
});

test("SearXNG error status and abort propagation", async () => {
  const errorClient = new SearXNGClient({
    fetchImpl: fakeFetch([{ method: "GET", path: "/search", status: 500, body: "{}" }]),
  });
  const errorResult = await errorClient.search({ query: "x", limit: 5 },
    new AbortController().signal);
  assert.equal(errorResult.ok, false);
  if (!errorResult.ok) assert.equal(errorResult.error.code, "provider_error");

  const aborted = new AbortController();
  aborted.abort();
  const abortClient = new SearXNGClient({
    fetchImpl: fakeFetch([{ method: "GET", path: "/search", status: 200, body: "{}" }]),
  });
  const abortResult = await abortClient.search({ query: "x", limit: 5 }, aborted.signal);
  assert.equal(abortResult.ok, false);
  if (!abortResult.ok) assert.equal(abortResult.error.code, "aborted");
});
