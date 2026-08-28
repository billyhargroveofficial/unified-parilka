import assert from "node:assert/strict";
import { test } from "node:test";
import { SearXNGClient } from "../src/bot/web-tools/searxng-client.js";
import { FirecrawlClient } from "../src/bot/web-tools/firecrawl-client.js";
import { createTurnImageTracker } from "../src/bot/agent/web-images.js";
import { createBotToolSet } from "../src/bot/agent/tool-set.js";
import type { BotToolSetExecutionCompleted } from "../src/bot/agent/tool-set.js";
import { createWebToolPort } from "../src/bot/web-tools/tool-definitions.js";
import type { WebToolPort } from "../src/bot/web-tools/tool-definitions.js";
import type { WebToolResult } from "../src/bot/web-tools/tool-definitions.js";
import type { BotReadTools } from "../src/bot/read-tools.js";

const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0, 0, 0, 0,
]);
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

function testPort(): WebToolPort {
  return createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    searxngClient: new SearXNGClient({
      fetchImpl: fakeFetch([{ method: "GET", path: "/search", status: 200, body: "{}" }]),
    }),
    firecrawlClient: new FirecrawlClient({
      lookup: PUBLIC_LOOKUP,
      fetchImpl: fakeFetch([]),
      pollIntervalMs: 5,
    }),
    downloadImages: async (urls) => ({
      images: urls.map((url) => ({
        data: JPEG_BYTES,
        mediaType: "image/jpeg" as const,
        sourceUrl: url,
      })),
      skipped: 0,
      remaining: Math.max(0, 6 - urls.length),
      errors: [],
    }),
  });
}

// ─── Tool definitions ───────────────────────────────────────────────────────

test("tool visibility depends on candidate vision capability", () => {
  const vision = makeToolSet(testPort(), true);
  assert.ok(vision.toolOrder.includes("searxng_search"));
  assert.ok(vision.toolOrder.includes("firecrawl_crawl"));
  assert.ok(vision.toolOrder.includes("inspect_web_images"));

  const textOnly = makeToolSet(testPort(), false);
  assert.ok(textOnly.toolOrder.includes("searxng_search"));
  assert.ok(textOnly.toolOrder.includes("firecrawl_crawl"));
  assert.ok(!textOnly.toolOrder.includes("inspect_web_images"));
});

test("the model-facing tool registry exposes static_page_fetch and not web_fetch", () => {
  const { tools, toolOrder } = makeToolSet(testPort(), false);
  assert.ok("static_page_fetch" in tools);
  assert.equal("web_fetch" in tools, false);
  assert.ok(toolOrder.includes("static_page_fetch"));
  assert.equal(toolOrder.includes("web_fetch"), false);
});

test("injected port cannot expose inspect_web_images to a text-only candidate", () => {
  // The port has no vision state at all; the candidate capability drives
  // visibility, so even a mismatched candidate list stays correct.
  const textOnly = makeToolSet(testPort(), false);
  assert.ok(!textOnly.toolOrder.includes("inspect_web_images"));
  const vision = makeToolSet(testPort(), true);
  assert.ok(vision.toolOrder.includes("inspect_web_images"));
});

test("inspect_web_images returns metadata + evidence, never bytes", async () => {
  const port = testPort();
  const { tools } = makeToolSet(port, true);
  const output = await tools.inspect_web_images!.execute(
    { urls: ["https://example.com/1.jpg"] },
    { toolCallId: "call-1" },
  );
  assert.equal(output.ok, true);
  if (output.ok) {
    assert.equal(output.result.downloaded, 1);
    assert.equal(output.evidence.length, 1);
    assert.equal(output.evidence[0]!.source, "web");
    assert.equal(output.evidence[0]!.url, "https://example.com/1.jpg");
    const serialized = JSON.stringify(output);
    assert.equal("_images" in output, false);
    assert.doesNotMatch(serialized, /"data":\[/u);
  }
  const modelOutput = await tools.inspect_web_images!.toModelOutput({
    toolCallId: "call-1",
    input: { urls: ["https://example.com/1.jpg"] },
    output,
  });
  assert.equal(modelOutput.type, "text");
});

test("searxng and firecrawl tools produce web evidence", async () => {
  const port = testPort();
  const { tools } = makeToolSet(port, false);
  const searxng = await tools.searxng_search!.execute(
    { query: "тест" },
    { toolCallId: "call-2" },
  );
  assert.equal(searxng.ok, true);
  if (searxng.ok) assert.equal(searxng.status, "empty");

  const firecrawl = await tools.firecrawl_crawl!.execute(
    { url: "https://example.com/docs" },
    { toolCallId: "call-3" },
  );
  assert.equal(firecrawl.ok, false);
  if (!firecrawl.ok) assert.equal(firecrawl.error.code, "provider_error");
});

test("unexpected downloader throws become typed failures without leaks", async () => {
  const port = testPort();
  const throwingPort: WebToolPort = {
    ...port,
    downloadImages: async () => {
      throw new Error("secret upstream detail: https://example.com/x?token=SECRET");
    },
  };
  const { tools, completed } = makeToolSet(throwingPort, true);
  const output = await tools.inspect_web_images!.execute(
    { urls: ["https://example.com/1.jpg"] },
    { toolCallId: "call-9" },
  );
  assert.equal(output.ok, false);
  if (!output.ok) {
    assert.equal(output.error.code, "provider_error");
    assert.doesNotMatch(output.error.message, /SECRET/u);
    assert.doesNotMatch(output.error.message, /example\.com/u);
  }
  // Accounting still completed with the typed failure.
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.name, "inspect_web_images");
  assert.equal(completed[0]!.output.ok, false);
});
