import assert from "node:assert/strict";
import { test } from "node:test";
import { SearXNGClient } from "../src/bot/web-tools/searxng-client.js";
import { FirecrawlClient } from "../src/bot/web-tools/firecrawl-client.js";
import { createTurnImageTracker } from "../src/bot/agent/web-images.js";
import { createBotToolSet } from "../src/bot/agent/tool-set.js";
import { createWebToolPort, fitSerializedOutput } from "../src/bot/web-tools/tool-definitions.js";
import type { WebToolPort } from "../src/bot/web-tools/tool-definitions.js";
import type { WebToolResult } from "../src/bot/web-tools/tool-definitions.js";
import type { BotToolSetExecutionCompleted } from "../src/bot/agent/tool-set.js";
import type { BotReadTools } from "../src/bot/read-tools.js";

// ─── Fake helpers ───────────────────────────────────────────────────────────

const PUBLIC_LOOKUP = async (): Promise<readonly { address: string; family: 4 | 6 }[]> =>
  [{ address: "93.184.216.34", family: 4 }];

interface FakeRoute {
  method: string;
  path: string;
  status: number;
  body: string;
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
    return new Response(route.body, {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
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

function fakeReadTools(): BotReadTools {
  return {} as BotReadTools;
}

interface ExecutableTestTool {
  execute: (
    input: Record<string, unknown>,
    execution: { toolCallId: string },
  ) => Promise<WebToolResult>;
  toModelOutput: (options: {
    toolCallId: string;
    input: Record<string, unknown>;
    output: WebToolResult;
  }) =>
    | { type: string; value: string }
    | Promise<{ type: string; value: string }>;
}

function makeToolSet(
  port: WebToolPort,
  visionAvailable: boolean,
): {
  tools: Record<string, ExecutableTestTool>;
  toolOrder: readonly string[];
  completed: BotToolSetExecutionCompleted[];
} {
  const completed: BotToolSetExecutionCompleted[] = [];
  const { tools, toolOrder } = createBotToolSet({
    readTools: fakeReadTools(),
    memoryTools: undefined,
    memoryWriteAllowed: false,
    audioTranscriptionAvailable: false,
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    chatId: "-1004242",
    sourceMessageId: 1,
    visionAvailable,
    webToolPort: port,
    onExecutionStarted: () => {},
    onExecutionCompleted: (input) => completed.push(input),
  });
  return {
    tools: tools as unknown as Record<string, ExecutableTestTool>,
    toolOrder,
    completed,
  };
}

// ─── Output carry budgets ───────────────────────────────────────────────────

test("firecrawl success output stays under the 48k carry budget", async () => {
  const longUrl = `https://example.com/${"a".repeat(2000)}`;
  const pages = Array.from({ length: 5 }, (_, i) => ({
    markdown: "y".repeat(8_000),
    metadata: { sourceURL: longUrl },
    images: Array.from({ length: 20 }, (_, j) =>
      `https://img.example.com/${i}/${"b".repeat(2000)}/${j}.png`),
  }));
  const client = new FirecrawlClient({
    lookup: PUBLIC_LOOKUP,
    pollIntervalMs: 5,
    fetchImpl: fakeFetch(firecrawlRoutes(JSON.stringify({
      status: "completed",
      completed: 5,
      total: 5,
      data: pages,
    }))),
  });
  const result = await client.crawl(
    { url: "https://example.com/docs" },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const crafted = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    firecrawlClient: client,
    searxngClient: new SearXNGClient({
      fetchImpl: fakeFetch([{ method: "GET", path: "/search", status: 200, body: "{}" }]),
    }),
  });
  const craftedSet = makeToolSet(crafted, false);
  const craftedOutput = await craftedSet.tools.firecrawl_crawl!.execute(
    { url: "https://example.com/docs" },
    { toolCallId: "call-5" },
  );
  assert.equal(craftedOutput.ok, true);
  if (!craftedOutput.ok) return;
  const serialized = JSON.stringify(craftedOutput);
  assert.ok(
    serialized.length < 48_000,
    `serialized firecrawl output is ${serialized.length} chars`,
  );
  // Useful page text survives the deterministic shrink.
  assert.match(serialized, /"markdown":"y+/u);
  assert.equal(craftedOutput.result.truncated, true);
  // Projected metadata stays consistent after pages were dropped.
  assert.equal(
    craftedOutput.result.pageCount,
    (craftedOutput.result.pages as unknown[]).length,
  );
  // Evidence shrinks in lockstep with the surviving pages.
  assert.equal(craftedOutput.evidence.length, (craftedOutput.result.pages as unknown[]).length);
  assert.equal(craftedOutput.status, "done"); // pages survived, no empty status
  assert.equal("status" in craftedOutput.result, false); // no fabricated result.status
});

test("fitSerializedOutput keeps status/count/evidence consistent when all pages drop", () => {
  // Long URLs inflate both the page projections and their evidence so the
  // 2k budget really forces pages down to zero.
  const longUrl = `https://example.com/${"a".repeat(2_000)}`;
  const output: WebToolResult = {
    ok: true,
    tool: "firecrawl_crawl",
    status: "done",
    result: {
      jobId: "job-1",
      pageCount: 2,
      completed: 2,
      total: 2,
      truncated: false,
      pages: [
        { url: longUrl, markdown: "y".repeat(600), truncated: false },
        { url: longUrl, markdown: "z".repeat(600), truncated: false },
      ],
    },
    evidence: [
      {
        source: "web",
        chat: null,
        message: null,
        speaker: { id: null, name: null },
        date: null,
        text: longUrl,
        url: longUrl,
      },
      {
        source: "web",
        chat: null,
        message: null,
        speaker: { id: null, name: null },
        date: null,
        text: longUrl,
        url: longUrl,
      },
    ],
  };
  const fitted = fitSerializedOutput(output, 2_000);
  assert.equal(fitted.ok, true);
  if (!fitted.ok) return;
  // Both pages were really dropped: no pages, no evidence, honest metadata.
  assert.equal(fitted.status, "empty");
  assert.equal(fitted.result.pageCount, 0);
  assert.equal((fitted.result.pages as unknown[]).length, 0);
  assert.equal(fitted.evidence.length, 0);
  assert.equal(fitted.result.truncated, true);
  // No fabricated per-result status field.
  assert.equal("status" in fitted.result, false);
  assert.ok(JSON.stringify(fitted).length <= 2_000);
});

test("searxng output fits the 16k carry budget without output_too_large", async () => {
  const longUrl = `https://example.com/${"a".repeat(2000)}`;
  const results = Array.from({ length: 10 }, (_, i) => ({
    title: `Result ${i}`,
    url: longUrl,
    content: "snippet ".repeat(40),
    img_src: `https://img.example.com/${i}/${"b".repeat(2000)}.png`,
    thumbnail: `https://thumb.example.com/${i}/${"c".repeat(2000)}.jpg`,
  }));
  const client = new SearXNGClient({
    fetchImpl: fakeFetch([{
      method: "GET",
      path: "/search",
      status: 200,
      body: JSON.stringify({ results }),
    }]),
  });
  const crafted = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    searxngClient: client,
    firecrawlClient: new FirecrawlClient({
      lookup: PUBLIC_LOOKUP,
      fetchImpl: fakeFetch([]),
      pollIntervalMs: 5,
    }),
  });
  const { tools } = makeToolSet(crafted, false);
  const output = await tools.searxng_search!.execute(
    { query: "x", limit: 10 },
    { toolCallId: "call-6" },
  );
  assert.equal(output.ok, true);
  if (!output.ok) return;
  const serialized = JSON.stringify(output);
  assert.ok(
    serialized.length < 16_000,
    `serialized searxng output is ${serialized.length} chars`,
  );
  // The shrink kept useful results and consistent accounting.
  assert.equal(output.result.truncated, true);
  const fittedResults = output.result.results as unknown[];
  assert.equal(output.result.resultCount, fittedResults.length);
  assert.ok(fittedResults.length >= 1);
  assert.equal(fittedResults.length, output.evidence.length);
  const modelOutput = await tools.searxng_search!.toModelOutput({
    toolCallId: "call-6",
    input: { query: "x", limit: 10 },
    output,
  });
  assert.doesNotMatch(modelOutput.value, /output_too_large/u);
});
