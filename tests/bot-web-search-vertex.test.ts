import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VertexGeminiWebSearchProvider,
} from "../src/bot/web-search-vertex.js";
import {
  WebSearchHttpError,
  WebSearchProtocolError,
  WebSearchTransportError,
} from "../src/bot/web-search.js";

const PROJECT = "project-test-123";
const TOKEN = "fake-adc-token-do-not-leak";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function mockFetch(
  respond: (request: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof fetch; last: () => CapturedRequest | undefined } {
  let captured: CapturedRequest | undefined;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured = {
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      init: init ?? {},
    };
    return await respond(captured);
  }) as typeof fetch;
  return { fetch: fetchImpl, last: () => captured };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function groundedPayload(text: string, chunks: unknown[]): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text }] },
        groundingMetadata: { groundingChunks: chunks },
      },
    ],
  };
}

test("vertex provider parses grounded text and attributed sources", async () => {
  const { fetch, last } = mockFetch(() =>
    jsonResponse(
      groundedPayload("Факт один [1] и факт два [2, 3].", [
        { web: { uri: "https://a.example.test/page", title: "A" } },
        { web: { uri: "not a url", title: "skip me" } },
        { web: { uri: "https://b.example.test/other" } },
        { web: { uri: "ftp://nope.example.test/x" } },
      ]),
    ),
  );
  const provider = new VertexGeminiWebSearchProvider({
    project: PROJECT,
    fetch,
    getAccessToken: () => TOKEN,
  });

  const result = await provider.search({
    query: "последняя версия Python",
    signal: new AbortController().signal,
  });

  assert.equal(result.text, "Факт один и факт два.");
  assert.deepEqual(result.sources, [
    { url: "https://a.example.test/page", title: "A" },
    { url: "https://b.example.test/other" },
  ]);

  const request = last();
  assert.ok(request);
  assert.match(
    request.url,
    new RegExp(
      `/projects/${PROJECT}/locations/global/publishers/google/models/gemini-3.6-flash:generateContent$`,
      "u",
    ),
  );
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["x-goog-user-project"], PROJECT);
  const body = JSON.parse(request.init.body as string) as {
    contents: Array<{ parts: Array<{ text: string }> }>;
    tools: Array<Record<string, unknown>>;
  };
  assert.equal(
    body.contents[0]?.parts[0]?.text,
    "последняя версия Python",
  );
  assert.deepEqual(body.tools, [{ googleSearch: {} }]);
});

test("vertex provider returns fallback text when candidates are empty", async () => {
  const { fetch } = mockFetch(() => jsonResponse({ candidates: [] }));
  const provider = new VertexGeminiWebSearchProvider({
    project: PROJECT,
    fetch,
    getAccessToken: () => TOKEN,
  });

  const result = await provider.search({
    query: "ничего",
    signal: new AbortController().signal,
  });

  assert.equal(result.text, "Поиск ничего не вернул.");
  assert.equal(result.sources, undefined);
});

test("vertex provider maps HTTP rejection without reading secrets", async () => {
  const { fetch } = mockFetch(() => new Response("denied", { status: 401 }));
  const provider = new VertexGeminiWebSearchProvider({
    project: PROJECT,
    fetch,
    getAccessToken: () => TOKEN,
  });

  await assert.rejects(
    provider.search({
      query: "q",
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof WebSearchHttpError && error.status === 401,
  );
});

test("vertex provider wraps transport failure", async () => {
  const fetchImpl = (async () => {
    throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
  }) as typeof fetch;
  const provider = new VertexGeminiWebSearchProvider({
    project: PROJECT,
    fetch: fetchImpl,
    getAccessToken: () => TOKEN,
  });

  await assert.rejects(
    provider.search({
      query: "q",
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof WebSearchTransportError &&
      error.code === "ECONNRESET",
  );
});

test("vertex provider rejects malformed JSON body", async () => {
  const { fetch } = mockFetch(
    () => new Response("{not json", { status: 200 }),
  );
  const provider = new VertexGeminiWebSearchProvider({
    project: PROJECT,
    fetch,
    getAccessToken: () => TOKEN,
  });

  await assert.rejects(
    provider.search({
      query: "q",
      signal: new AbortController().signal,
    }),
    WebSearchProtocolError,
  );
});

test("vertex provider validates the query before any network call", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return jsonResponse({ candidates: [] });
  }) as typeof fetch;
  let tokenCalls = 0;
  const provider = new VertexGeminiWebSearchProvider({
    project: PROJECT,
    fetch: fetchImpl,
    getAccessToken: () => {
      tokenCalls += 1;
      return TOKEN;
    },
  });

  await assert.rejects(
    provider.search({
      query: "   ",
      signal: new AbortController().signal,
    }),
    WebSearchProtocolError,
  );
  await assert.rejects(
    provider.search({
      query: "x".repeat(501),
      signal: new AbortController().signal,
    }),
    WebSearchProtocolError,
  );
  assert.equal(called, false);
  assert.equal(tokenCalls, 0);
});

test("vertex provider honors an already-aborted signal", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return jsonResponse({ candidates: [] });
  }) as typeof fetch;
  const provider = new VertexGeminiWebSearchProvider({
    project: PROJECT,
    fetch: fetchImpl,
    getAccessToken: () => TOKEN,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    provider.search({ query: "q", signal: controller.signal }),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(called, false);
});

test("injected token source skips gcloud resolution entirely", () => {
  assert.doesNotThrow(() => {
    new VertexGeminiWebSearchProvider({
      project: PROJECT,
      gcloudPath: "/definitely/missing/gcloud-binary-xyz",
      getAccessToken: () => TOKEN,
    });
  });
});

test("default token source fails fast when gcloud is absent", () => {
  assert.throws(
    () =>
      new VertexGeminiWebSearchProvider({
        project: PROJECT,
        gcloudPath: "/definitely/missing/gcloud-binary-xyz",
      }),
    /executable gcloud/u,
  );
});

test("error messages never interpolate the access token", async () => {
  const { fetch } = mockFetch(() => new Response("no", { status: 500 }));
  const provider = new VertexGeminiWebSearchProvider({
    project: PROJECT,
    fetch,
    getAccessToken: () => TOKEN,
  });

  try {
    await provider.search({
      query: "q",
      signal: new AbortController().signal,
    });
    assert.fail("expected rejection");
  } catch (error) {
    assert.doesNotMatch(
      error instanceof Error ? error.message : String(error),
      new RegExp(TOKEN, "u"),
    );
  }
});
