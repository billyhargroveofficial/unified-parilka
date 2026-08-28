import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotReadTools,
} from "../src/bot/read-tools.js";
import type { PaperSearchProvider } from "../src/bot/read-tools/contracts.js";
import {
  asFailure,
  CHAT,
  emptyCache,
} from "./support/bot-read-tools.js";

test("paper_search exposes provider-neutral result and bounded output", async () => {
  let observedMaxResults = 0;
  const provider: PaperSearchProvider = {
    async search({ query, source, maxResults }: Parameters<PaperSearchProvider["search"]>[0]) {
      observedMaxResults = maxResults;
      assert.equal(source, "arxiv");
      return {
        query,
        source,
        papers: [
          {
            title: "Attention Is All You Need",
            authors: ["Vaswani et al."],
            year: "2017",
            abstract: "We propose a new simple network architecture.",
            url: "https://arxiv.org/abs/1706.03762",
          },
        ],
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    paperSearch: provider,
  });

  const result = await tools.callTool("paper_search", {
    query: "transformer",
    max_results: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(observedMaxResults, 2);
  if (!result.ok) {
    return;
  }
  assert.equal(result.tool, "paper_search");
  assert.equal(result.status, "done");
  assert.equal(result.result.source, "arxiv");
  assert.equal(result.result.resultCount, 1);
  assert.equal(result.evidence[0]?.source, "paper");
  assert.equal(
    result.evidence[0]?.url,
    "https://arxiv.org/abs/1706.03762",
  );
});

test("paper_search defaults to arxiv and three results", async () => {
  const provider: PaperSearchProvider = {
    async search({ source, maxResults }: Parameters<PaperSearchProvider["search"]>[0]) {
      assert.equal(source, "arxiv");
      assert.equal(maxResults, 3);
      return {
        query: "q",
        source,
        papers: [],
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    paperSearch: provider,
  });

  const result = await tools.callTool("paper_search", {
    query: "foo",
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "empty");
});

test("paper_search rejects invalid max_results", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
  });
  const result = asFailure(
    await tools.callTool("paper_search", {
      query: "x",
      max_results: 10,
    }),
  );
  assert.equal(result.error.code, "invalid_arguments");
});

test("paper_search enforces timeout and caller abort", async () => {
  let timeoutSignalObserved = false;
  const hangingProvider: PaperSearchProvider = {
    async search({ signal }: Parameters<PaperSearchProvider["search"]>[0]) {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            timeoutSignalObserved = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    paperSearch: hangingProvider,
    paperSearchTimeoutMs: 10,
    paperSearchRateLimitMs: 1,
  });

  const timeout = asFailure(
    await tools.callTool("paper_search", { query: "hang" }),
  );
  assert.equal(timeout.error.code, "timeout");
  assert.equal(timeout.error.retryable, true);
  assert.equal(timeoutSignalObserved, true);

  const controller = new AbortController();
  controller.abort(new Error("turn ended"));
  const aborted = asFailure(
    await tools.callTool(
      "paper_search",
      { query: "cancel" },
      { signal: controller.signal },
    ),
  );
  assert.equal(aborted.error.code, "aborted");
  assert.equal(aborted.error.retryable, false);
});

test("paper_search whole-operation post-check rejects resolved and rejected work after synchronous event-loop starvation", async () => {
  const blocker = new Int32Array(new SharedArrayBuffer(4));
  const expectTimeout = async (provider: PaperSearchProvider) => {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearch: provider,
      paperSearchTimeoutMs: 5,
      paperSearchRateLimitMs: 1,
    });
    const timeout = asFailure(
      await tools.callTool("paper_search", { query: "starved" }),
    );
    assert.equal(timeout.error.code, "timeout");
    assert.equal(timeout.error.retryable, true);
  };

  await expectTimeout({
    async search({ query, source }) {
      Atomics.wait(blocker, 0, 0, 25);
      return { query, source, papers: [] };
    },
  });
  await expectTimeout({
    async search() {
      Atomics.wait(blocker, 0, 0, 25);
      throw new Error("provider rejected after blocking");
    },
  });
});

test("paper_search parses built-in arxiv atom response", async () => {
  const originalFetch = globalThis.fetch;
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Sample Paper</title>
    <summary>Abstract text.</summary>
    <published>2024-05-20T00:00:00Z</published>
    <id>https://arxiv.org/abs/2405.12345</id>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
  </entry>
</feed>`;
  globalThis.fetch = async () =>
    new Response(atom, { status: 200 });
  try {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 5_000,
      paperSearchRateLimitMs: 1,
    });
    const result = await tools.callTool("paper_search", {
      query: "sample",
      max_results: 1,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.result.resultCount, 1);
    assert.equal(result.evidence[0]?.title, "Sample Paper");
    assert.equal(result.evidence[0]?.url, "https://arxiv.org/abs/2405.12345");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("built-in arxiv uses HTTPS and rejects redirects before a second request", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let requestedUrl: URL | undefined;
  let redirectMode: string | undefined;
  globalThis.fetch = async (input, init) => {
    fetchCalls += 1;
    requestedUrl = new URL(String(input));
    redirectMode = init?.redirect;
    return new Response("", { status: 302 });
  };
  try {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 1_000,
      paperSearchRateLimitMs: 1,
    });
    const result = asFailure(
      await tools.callTool("paper_search", { query: "redirect" }),
    );

    assert.equal(result.error.code, "provider_error");
    assert.equal(fetchCalls, 1);
    assert.equal(requestedUrl?.protocol, "https:");
    assert.equal(requestedUrl?.hostname, "export.arxiv.org");
    assert.equal(redirectMode, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("built-in arxiv spends its one timeout budget during rate-limit wait", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("<feed></feed>", { status: 200 });
  };
  try {
    const warmup = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 1_000,
      paperSearchRateLimitMs: 250,
    });
    const first = await warmup.callTool("paper_search", { query: "warmup" });
    assert.equal(first.ok, true);

    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 20,
      paperSearchRateLimitMs: 250,
    });
    const timeout = asFailure(
      await tools.callTool("paper_search", { query: "budget" }),
    );

    assert.equal(timeout.error.code, "timeout");
    assert.equal(timeout.error.retryable, true);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("built-in paper search times out stalled request headers", async () => {
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    return await new Promise<Response>(() => undefined);
  };
  try {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 20,
      paperSearchRateLimitMs: 1,
    });
    const timeout = asFailure(
      await tools.callTool("paper_search", { query: "headers" }),
    );

    assert.equal(timeout.error.code, "timeout");
    assert.equal(timeout.error.retryable, true);
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("built-in paper search times out stalled bodies and cancels their reader", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
  try {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 20,
      paperSearchRateLimitMs: 1,
    });
    const timeout = asFailure(
      await tools.callTool("paper_search", { query: "stalled" }),
    );

    assert.equal(timeout.error.code, "timeout");
    assert.equal(timeout.error.retryable, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("built-in paper search prechecks and cancels oversized response streams", async () => {
  const originalFetch = globalThis.fetch;
  let declaredCancelled = false;
  let streamedCancelled = false;
  try {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            declaredCancelled = true;
          },
        }),
        {
          status: 200,
          headers: { "content-length": "1048576" },
        },
      );
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 1_000,
      paperSearchRateLimitMs: 1,
    });
    const declared = asFailure(
      await tools.callTool("paper_search", {
        query: "declared",
        source: "europepmc",
      }),
    );
    assert.equal(declared.error.code, "provider_error");
    assert.equal(declared.error.retryable, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(declaredCancelled, true);

    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1_048_576));
          },
          cancel() {
            streamedCancelled = true;
          },
        }),
        { status: 200 },
      );
    const streamed = asFailure(
      await tools.callTool("paper_search", {
        query: "streamed",
        source: "europepmc",
      }),
    );
    assert.equal(streamed.error.code, "provider_error");
    assert.equal(streamed.error.retryable, false);
    assert.equal(streamedCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("built-in paper search preserves an external abort while reading a body", async () => {
  const originalFetch = globalThis.fetch;
  let fetchReturned: (() => void) | undefined;
  const fetchReturnedPromise = new Promise<void>((resolve) => {
    fetchReturned = resolve;
  });
  let cancelled = false;
  globalThis.fetch = async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
    fetchReturned?.();
    return response;
  };
  try {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 1_000,
      paperSearchRateLimitMs: 1,
    });
    const controller = new AbortController();
    const result = tools.callTool(
      "paper_search",
      { query: "cancel", source: "europepmc" },
      { signal: controller.signal },
    );
    await fetchReturnedPromise;
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("turn ended"));

    const aborted = asFailure(await result);
    assert.equal(aborted.error.code, "aborted");
    assert.equal(aborted.error.retryable, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper_search parses built-in europepmc json response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        resultList: {
          result: [
            {
              title: "PMC Paper",
              authorString: "Smith A, Jones B",
              pubYear: "2023",
              abstractText: "A study.",
              pmcid: "PMC123456",
            },
          ],
        },
      }),
      { status: 200 },
    );
  try {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 5_000,
      paperSearchRateLimitMs: 1,
    });
    const result = await tools.callTool("paper_search", {
      query: "pmc",
      source: "europepmc",
      max_results: 1,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.result.source, "europepmc");
    assert.equal(result.result.resultCount, 1);
    assert.equal(result.evidence[0]?.url, "https://europepmc.org/article/PMC/123456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
