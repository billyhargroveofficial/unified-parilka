import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HttpJsonWebSearchProvider,
  WebSearchHttpError,
  WebSearchProtocolError,
} from "../src/bot/web-search.js";

test("HTTP web-search adapter sends the stable contract and validates sources", async () => {
  let capturedInput: string | URL | Request | undefined;
  let capturedInit: RequestInit | undefined;
  const provider = new HttpJsonWebSearchProvider({
    endpoint: "https://search.example.test/query",
    bearerToken: "super-private-token",
    fetch: async (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return Response.json({
        text: "Найденный внешний факт",
        sources: [
          {
            url: "https://example.test/source",
            title: "Источник",
            snippet: "Короткий фрагмент",
          },
        ],
      });
    },
  });

  const result = await provider.search({
    query: "  свежий факт  ",
    signal: new AbortController().signal,
  });

  assert.equal(capturedInput, "https://search.example.test/query");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  assert.equal(capturedInit?.body, '{"query":"свежий факт"}');
  assert.equal(
    new Headers(capturedInit?.headers).get("authorization"),
    "Bearer super-private-token",
  );
  assert.deepEqual(result, {
    text: "Найденный внешний факт",
    sources: [
      {
        url: "https://example.test/source",
        title: "Источник",
        snippet: "Короткий фрагмент",
      },
    ],
  });
});

test("web-search adapter reports only safe typed HTTP failures", async () => {
  const provider = new HttpJsonWebSearchProvider({
    endpoint: "https://search.example.test/query",
    fetch: async () =>
      new Response("private upstream error body", {
        status: 429,
      }),
  });

  await assert.rejects(
    provider.search({
      query: "query",
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.equal(error instanceof WebSearchHttpError, true);
      assert.equal((error as WebSearchHttpError).code, "WEB_SEARCH_HTTP_429");
      assert.doesNotMatch(
        (error as Error).message,
        /private upstream error body/u,
      );
      return true;
    },
  );
});

test("web-search adapter rejects oversized or structurally loose responses", async () => {
  const extraField = new HttpJsonWebSearchProvider({
    endpoint: "http://127.0.0.1:8766/search",
    fetch: async () =>
      Response.json({
        text: "result",
        sources: [
          {
            url: "https://example.test/",
            unexpected: "field",
          },
        ],
      }),
  });
  await assert.rejects(
    extraField.search({
      query: "query",
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof WebSearchProtocolError &&
      error.code === "INVALID_SOURCE_FIELDS",
  );

  const tooLarge = new HttpJsonWebSearchProvider({
    endpoint: "https://search.example.test/query",
    fetch: async () =>
      new Response("{}", {
        headers: {
          "content-length": "200000",
        },
      }),
  });
  await assert.rejects(
    tooLarge.search({
      query: "query",
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof WebSearchProtocolError &&
      error.code === "RESPONSE_TOO_LARGE",
  );

  const streamedTooLarge = new HttpJsonWebSearchProvider({
    endpoint: "https://search.example.test/query",
    fetch: async () =>
      new Response("x".repeat(128_001)),
  });
  await assert.rejects(
    streamedTooLarge.search({
      query: "query",
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof WebSearchProtocolError &&
      error.code === "RESPONSE_TOO_LARGE",
  );
});

test("already-aborted web search never invokes fetch", async () => {
  let calls = 0;
  const provider = new HttpJsonWebSearchProvider({
    endpoint: "https://search.example.test/query",
    fetch: async () => {
      calls += 1;
      return Response.json({ text: "unexpected" });
    },
  });
  const controller = new AbortController();
  controller.abort(new DOMException("stop", "AbortError"));

  await assert.rejects(
    provider.search({
      query: "query",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
});
