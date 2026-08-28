import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotReadTools,
  PublicWebFetchProvider,
  type WebFetchProvider,
  type WebSearchProvider,
} from "../src/bot/read-tools.js";
import {
  asFailure,
  CHAT,
  emptyCache,
} from "./support/bot-read-tools.js";

test("web_search exposes provider-neutral sources and an AbortSignal", async () => {
  let observedQuery: string | undefined;
  let observedSignal: AbortSignal | undefined;
  const provider: WebSearchProvider = {
    async search({ query, signal }) {
      observedQuery = query;
      observedSignal = signal;
      return {
        text: "Вышла новая версия.",
        sources: [
          {
            url: "https://example.com/release",
            title: "Release notes",
            snippet: "Version 2.0 was released.",
            publishedAt: "2026-07-30",
          },
        ],
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webSearch: provider,
  });

  const result = await tools.callTool("web_search", {
    query: "  новая версия  ",
  });

  assert.equal(observedQuery, "новая версия");
  assert.ok(observedSignal);
  assert.equal(observedSignal?.aborted, false);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.result, {
    query: "новая версия",
    text: "Вышла новая версия.",
    sourceCount: 1,
  });
  assert.deepEqual(result.evidence, [
    {
      source: "web",
      chat: null,
      message: null,
      speaker: { id: null, name: null },
      date: "2026-07-30",
      text: "Version 2.0 was released.",
      url: "https://example.com/release",
      title: "Release notes",
    },
  ]);
});

test("web_search enforces timeout and caller abort even when provider hangs", async () => {
  let timeoutSignalObserved = false;
  const hangingProvider: WebSearchProvider = {
    async search({ signal }) {
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
    webSearch: hangingProvider,
    webSearchTimeoutMs: 10,
  });

  const timeout = asFailure(
    await tools.callTool("web_search", { query: "hang" }),
  );
  assert.equal(timeout.error.code, "timeout");
  assert.equal(timeout.error.retryable, true);
  assert.equal(timeoutSignalObserved, true);

  const controller = new AbortController();
  controller.abort(new Error("turn ended"));
  const aborted = asFailure(
    await tools.callTool(
      "web_search",
      { query: "cancel" },
      { signal: controller.signal },
    ),
  );
  assert.equal(aborted.error.code, "aborted");
  assert.equal(aborted.error.retryable, false);

  const externalDeadlineTools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webSearch: hangingProvider,
    webSearchTimeoutMs: 1_000,
  });
  const externalTimeout = asFailure(
    await externalDeadlineTools.callTool(
      "web_search",
      { query: "sdk timeout" },
      { signal: AbortSignal.timeout(10) },
    ),
  );
  assert.equal(externalTimeout.error.code, "timeout");
  assert.equal(externalTimeout.error.retryable, true);
});

test("static_page_fetch exposes bounded page text, source evidence, and an AbortSignal", async () => {
  let observedUrl: string | undefined;
  let observedMaxChars: number | undefined;
  let observedSignal: AbortSignal | undefined;
  const provider: WebFetchProvider = {
    async fetch({ url, maxChars, signal }) {
      observedUrl = url;
      observedMaxChars = maxChars;
      observedSignal = signal;
      return {
        url,
        status: 200,
        statusText: "OK",
        contentType: "text/html",
        byteLength: 123,
        title: "Release notes",
        text: "Version 2.0 was released.",
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webFetch: provider,
  });

  const result = await tools.callTool("static_page_fetch", {
    url: "  https://example.com/release  ",
    max_chars: 800,
  });

  assert.equal(observedUrl, "https://example.com/release");
  assert.equal(observedMaxChars, 800);
  assert.ok(observedSignal);
  assert.equal(observedSignal?.aborted, false);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "done");
  assert.equal(result.tool, "static_page_fetch");
  assert.deepEqual(result.result, {
    url: "https://example.com/release",
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    byteLength: 123,
    title: "Release notes",
    text: "Version 2.0 was released.",
  });
  assert.deepEqual(result.evidence, [{
    source: "web",
    chat: null,
    message: null,
    speaker: { id: null, name: null },
    date: null,
    text: "Release notes",
    url: "https://example.com/release",
    title: "Release notes",
  }]);
});

test("no exposed web_fetch alias: the legacy name is an unknown tool", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
  });
  const legacy = asFailure(
    await tools.callTool("web_fetch", { url: "https://example.com" }),
  );
  assert.equal(legacy.error.code, "unknown_tool");
  assert.equal(legacy.error.retryable, false);
});

test("static_page_fetch clamps an injected provider to the requested visible-text budget", async () => {
  const provider: WebFetchProvider = {
    async fetch({ url }) {
      return {
        url,
        status: 200,
        contentType: "text/plain",
        byteLength: 3_000,
        text: "x".repeat(3_000),
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webFetch: provider,
  });

  const result = await tools.callTool("static_page_fetch", {
    url: "https://example.com/article",
    max_chars: 500,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(String(result.result.text).length, 500);
  assert.match(String(result.result.text), /…$/u);
});

test("static_page_fetch enforces timeout and caller abort even when the page provider hangs", async () => {
  let timeoutSignalObserved = false;
  const hangingProvider: WebFetchProvider = {
    async fetch({ signal }) {
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
    webFetch: hangingProvider,
    webFetchTimeoutMs: 10,
  });

  const timeout = asFailure(
    await tools.callTool("static_page_fetch", { url: "https://example.com" }),
  );
  assert.equal(timeout.error.code, "timeout");
  assert.equal(timeout.error.retryable, true);
  assert.equal(timeoutSignalObserved, true);

  const controller = new AbortController();
  controller.abort(new Error("turn ended"));
  const aborted = asFailure(
    await tools.callTool(
      "static_page_fetch",
      { url: "https://example.com" },
      { signal: controller.signal },
    ),
  );
  assert.equal(aborted.error.code, "aborted");
  assert.equal(aborted.error.retryable, false);
});

test("built-in static_page_fetch DNS-pins public HTTPS pages, strips HTML, and never follows redirects", async () => {
  let transportCalls = 0;
  const provider = new PublicWebFetchProvider({
    lookup: async (hostname) => {
      assert.equal(hostname, "example.com");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    transport: async ({ url, address }) => {
      transportCalls += 1;
      assert.equal(url.hostname, "example.com");
      assert.deepEqual(address, { address: "93.184.216.34", family: 4 });
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(
          "<html><head><title>Good &amp; useful</title><style>HIDDEN_STYLE</style></head><body><h1>Heading</h1><p>Visible&nbsp;text</p><script>DO_NOT_LEAK</script></body></html>",
        ),
      };
    },
  });
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webFetch: provider,
  });

  const page = await tools.callTool("static_page_fetch", {
    url: "https://example.com/article",
    max_chars: 500,
  });

  assert.equal(page.ok, true);
  if (!page.ok) {
    return;
  }
  assert.equal(transportCalls, 1);
  assert.equal(page.result.title, "Good & useful");
  assert.match(String(page.result.text), /Heading[\s\S]+Visible text/u);
  assert.doesNotMatch(String(page.result.text), /HIDDEN_STYLE|DO_NOT_LEAK/u);

  const redirectProvider = new PublicWebFetchProvider({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => {
      transportCalls += 1;
      return {
        status: 302,
        headers: { location: "https://www.example.com/next" },
        body: Buffer.alloc(0),
      };
    },
  });
  const redirectTools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webFetch: redirectProvider,
  });
  const redirect = await redirectTools.callTool("static_page_fetch", {
    url: "https://example.com/article",
  });

  assert.equal(redirect.ok, true);
  if (!redirect.ok) {
    return;
  }
  assert.equal(redirect.status, "empty");
  assert.equal(redirect.result.redirectUrl, "https://www.example.com/next");
  assert.equal(transportCalls, 2);
});

test("built-in static_page_fetch rejects literal and DNS-resolved private targets before transport", async () => {
  let transported = false;
  const provider = new PublicWebFetchProvider({
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    transport: async () => {
      transported = true;
      throw new Error("must not connect");
    },
  });
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webFetch: provider,
  });

  const resolvedPrivate = asFailure(
    await tools.callTool("static_page_fetch", { url: "https://example.com" }),
  );
  assert.equal(resolvedPrivate.error.code, "unsafe_url");
  assert.equal(resolvedPrivate.error.retryable, false);
  assert.equal(transported, false);

  const literalPrivate = asFailure(
    await tools.callTool("static_page_fetch", { url: "https://127.0.0.1" }),
  );
  assert.equal(literalPrivate.error.code, "unsafe_url");
  assert.equal(transported, false);

  const literalIpv6Private = asFailure(
    await tools.callTool("static_page_fetch", { url: "https://[::1]" }),
  );
  assert.equal(literalIpv6Private.error.code, "unsafe_url");
  assert.equal(transported, false);
});

test("built-in static_page_fetch rejects special IPv6 DNS records but permits public IPv6", async () => {
  for (const address of ["2001:0000::1", "2002::1"]) {
    let transported = false;
    const provider = new PublicWebFetchProvider({
      lookup: async () => [{ address, family: 6 }],
      transport: async () => {
        transported = true;
        throw new Error("must not connect");
      },
    });
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      webFetch: provider,
    });

    const failure = asFailure(
      await tools.callTool("static_page_fetch", { url: "https://example.com" }),
    );
    assert.equal(failure.error.code, "unsafe_url");
    assert.equal(failure.error.retryable, false);
    assert.equal(transported, false, address);
  }

  let observedAddress: string | undefined;
  const publicProvider = new PublicWebFetchProvider({
    lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }],
    transport: async ({ address }) => {
      observedAddress = address.address;
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("public IPv6 page"),
      };
    },
  });
  const publicTools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webFetch: publicProvider,
  });
  const page = await publicTools.callTool("static_page_fetch", {
    url: "https://example.com/ipv6",
  });

  assert.equal(page.ok, true);
  assert.equal(observedAddress, "2606:4700:4700::1111");
});

test("built-in static_page_fetch fails closed for unallocated IPv6 prefixes", async () => {
  for (const address of ["2004::1", "3000::1", "3ffe::1"]) {
    let transported = false;
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      webFetch: new PublicWebFetchProvider({
        lookup: async () => [{ address, family: 6 }],
        transport: async () => {
          transported = true;
          throw new Error("must not connect");
        },
      }),
    });
    const failure = asFailure(
      await tools.callTool("static_page_fetch", { url: "https://example.com" }),
    );
    assert.equal(failure.error.code, "unsafe_url");
    assert.equal(transported, false, address);
  }

  const allocated = [
    "2001:4860::8888",
    "2404::1",
    "2606:4700::1111",
    "2a00:1450::1",
    "2c0f::1",
  ];
  const transported: string[] = [];
  for (const address of allocated) {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      webFetch: new PublicWebFetchProvider({
        lookup: async () => [{ address, family: 6 }],
        transport: async ({ address: resolved }) => {
          transported.push(resolved.address);
          return {
            status: 200,
            headers: { "content-type": "text/plain" },
            body: Buffer.from("public IPv6 page"),
          };
        },
      }),
    });
    const page = await tools.callTool("static_page_fetch", {
      url: "https://example.com/ipv6",
    });
    assert.equal(page.ok, true, address);
  }
  assert.deepEqual(transported, allocated);
});
