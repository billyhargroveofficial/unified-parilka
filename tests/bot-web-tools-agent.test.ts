import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import {
  makeAgent,
  candidate,
  mockModel,
  request,
  response,
  toolCall,
  toolResponse,
} from "./support/ai-agent.js";
import { createTurnImageTracker } from "../src/bot/agent/web-images.js";
import type { WebToolPort } from "../src/bot/web-tools/tool-definitions.js";
import { SearXNGClient } from "../src/bot/web-tools/searxng-client.js";
import { FirecrawlClient } from "../src/bot/web-tools/firecrawl-client.js";
import { downloadImages } from "../src/bot/web-tools/image-downloader.js";
import {
  buildBotSystemPrompt,
  BOT_AGENT_CONTRACT,
} from "../src/bot/prompt.js";

const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0, 0, 0, 0,
]);

function fileParts(call: ReturnType<typeof mockModel>["doGenerateCalls"][number]): Array<{
  type: "file";
  data: Uint8Array;
  mediaType: string;
}> {
  const parts: Array<{ type: string; data?: unknown; mediaType?: unknown }> = [];
  if (!call) {
    return [];
  }
  for (const message of call.prompt) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      parts.push(part as { type: string; data?: unknown; mediaType?: unknown });
    }
  }
  return parts.flatMap((part) => {
    if (part.type !== "file") {
      return [];
    }
    const data = part.data as { type?: unknown; data?: unknown } | undefined;
    return data?.type === "data" && data.data instanceof Uint8Array &&
        typeof part.mediaType === "string"
      ? [{
          type: "file" as const,
          data: data.data,
          mediaType: part.mediaType,
        }]
      : [];
  });
}

function toolNamesOf(
  call: ReturnType<typeof mockModel>["doGenerateCalls"][number],
): string[] {
  return (call?.tools ?? []).map((tool) => tool.name);
}

function offlinePort(): WebToolPort {
  const tracker = createTurnImageTracker();
  const lookup = async (): Promise<readonly { address: string; family: 4 | 6 }[]> =>
    [{ address: "93.184.216.34", family: 4 }];
  const transport = async () => ({
    status: 200,
    headers: { "content-type": "image/jpeg" },
    body: Buffer.from(JPEG_BYTES),
  });
  return {
    searxngClient: new SearXNGClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch,
    }),
    firecrawlClient: new FirecrawlClient({
      fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch,
    }),
    imageTracker: tracker,
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    downloadImages: (urls, signal) =>
      downloadImages(urls, { tracker, signal, lookup, transport }),
  };
}

test("inspect_web_images bytes reach the next model step", async () => {
  const model = mockModel([
    toolResponse([toolCall("call-1", "inspect_web_images", {
      urls: ["https://example.com/1.jpg"],
    })]),
    response([{ type: "text", text: "вижу картинку" }], "stop"),
  ]);
  const port = offlinePort();
  const fixture = makeAgent(
    [candidate("primary:vision", model, undefined, { vision: true })],
    { agentOptions: { webToolPort: port } },
  );

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "вижу картинку");
  assert.equal(model.doGenerateCalls.length, 2);
  // The tool result message carries metadata; the bytes arrive as a fresh
  // user message injected by prepareStep before the second model call.
  const parts = fileParts(model.doGenerateCalls[1]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.mediaType, "image/jpeg");
  assert.deepEqual(Array.from(parts[0]!.data), Array.from(JPEG_BYTES));
  assert.equal(port.imageTracker.committedCount, 1);
  assert.match(
    JSON.stringify(model.doGenerateCalls[1]?.prompt),
    /inspect_web_images/,
  );
});

test("text-only candidate neither sees the tool nor receives bytes", async () => {
  const model = mockModel([
    response([{ type: "text", text: "не вижу" }], "stop"),
  ]);
  const port = offlinePort();
  const fixture = makeAgent(
    [candidate("primary:text", model)],
    { agentOptions: { webToolPort: port } },
  );

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "не вижу");
  const names = toolNamesOf(model.doGenerateCalls[0]);
  assert.ok(names.includes("searxng_search"));
  assert.ok(names.includes("firecrawl_crawl"));
  assert.ok(!names.includes("inspect_web_images"));
  assert.deepEqual(fileParts(model.doGenerateCalls[0]), []);
});

test("vision fallback receives already-downloaded turn images", async () => {
  const failing = mockModel([
    toolResponse([toolCall("call-1", "inspect_web_images", {
      urls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
    })]),
    Object.assign(new Error("provider failure"), { statusCode: 500 }),
  ]);
  const fallback = mockModel([
    response([{ type: "text", text: "fallback видит" }], "stop"),
  ]);
  const port = offlinePort();
  const fixture = makeAgent(
    [
      candidate("primary:vision", failing, undefined, { vision: true }),
      candidate("fallback:vision", fallback, undefined, { vision: true }),
    ],
    { agentOptions: { webToolPort: port } },
  );

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "fallback видит");
  assert.equal(port.imageTracker.committedCount, 2);
  // The fallback attempt starts its own generateText: its first prepareStep
  // injects every turn-level image.
  const parts = fileParts(fallback.doGenerateCalls[0]);
  assert.equal(parts.length, 2);
  assert.deepEqual(Array.from(parts[0]!.data), Array.from(JPEG_BYTES));
});

test("text-only fallback never sees the tool or bytes after a vision download", async () => {
  const failing = mockModel([
    toolResponse([toolCall("call-1", "inspect_web_images", {
      urls: ["https://example.com/1.jpg"],
    })]),
    Object.assign(new Error("provider failure"), { statusCode: 500 }),
  ]);
  const textOnly = mockModel([
    response([{ type: "text", text: "text-only финиш" }], "stop"),
  ]);
  const port = offlinePort();
  const fixture = makeAgent(
    [
      candidate("primary:vision", failing, undefined, { vision: true }),
      candidate("fallback:text", textOnly),
    ],
    { agentOptions: { webToolPort: port } },
  );

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "text-only финиш");
  assert.equal(port.imageTracker.committedCount, 1);
  // Tool visibility follows the current candidate capability: the text-only
  // fallback has no inspect tool and receives no file bytes. Carried image
  // metadata text may still be present in the fallback messages.
  const names = toolNamesOf(textOnly.doGenerateCalls[0]);
  assert.ok(!names.includes("inspect_web_images"));
  assert.deepEqual(fileParts(textOnly.doGenerateCalls[0]), []);
  assert.match(
    JSON.stringify(textOnly.doGenerateCalls[0]?.prompt),
    /inspect_web_images/,
  );
});

test("system prompt names the web tools in tool list, sources and research", () => {
  const prompt = buildBotSystemPrompt({
    botUsername: "@bichiycepenstotri_bot",
    botName: "БычийЦепень103",
    modelLabel: "provider/model-v2",
    now: new Date("2026-07-29T21:30:00.000Z"),
    approximateMemberCount: 539,
  });
  for (const name of BOT_AGENT_CONTRACT.toolNames) {
    assert.ok(prompt.includes(`\`${name}\``), name);
  }
  assert.match(prompt, /searxng_search/u);
  assert.match(prompt, /firecrawl_crawl/u);
  assert.match(prompt, /inspect_web_images/u);
  assert.match(prompt, /не больше 6 картинок/u);
  assert.match(prompt, /category=images/u);

  const withSources = buildBotSystemPrompt({
    botUsername: "testbot",
    botName: "Test",
    modelLabel: "provider/model-v2",
    now: new Date("2026-07-29T21:30:00.000Z"),
    externalSourcesRequested: true,
  });
  assert.match(withSources, /searxng_search, firecrawl_crawl/u);

  const research = buildBotSystemPrompt({
    botUsername: "testbot",
    botName: "Test",
    modelLabel: "provider/model-v2",
    now: new Date("2026-07-29T21:30:00.000Z"),
    researchMode: "research",
  });
  assert.match(research, /searxng_search/u);
  assert.match(research, /firecrawl_crawl/u);
});
