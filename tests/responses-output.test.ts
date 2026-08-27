import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { citationsFromWebEvidence, webSearchItem } from "../src/openai-responses/response-output.js";

test("preserves hosted query batch cardinality for safe progress projection", () => {
  const item = webSearchItem({
    type: "web_search_call", id: "web-batch", status: "completed",
    action: { type: "search", queries: ["first", "second", "third"] },
  } as unknown as ResponseOutputItem);

  assert.deepEqual(item, {
    callId: "web-batch",
    action: "search",
    input: { query: "first / second / third" },
    batchSize: 3,
    ok: true,
  });
});

test("prefers provider query batches over a legacy duplicate query field", () => {
  const item = webSearchItem({
    type: "web_search_call", id: "web-batch", status: "completed",
    action: { type: "search", query: "legacy", queries: ["first", "second"] },
  } as unknown as ResponseOutputItem);

  assert.equal(item?.batchSize, 2);
  assert.deepEqual(item?.input, { query: "first / second" });
});

test("derives bounded HTTPS fallback citations from completed web evidence", () => {
  const items = [
    {
      type: "web_search_call", id: "web-1", status: "completed",
      action: {
        type: "search", queries: ["cars"], sources: [
          { type: "url", url: "https://market.example/cars?a=1" },
          { type: "url", url: "http://unsafe.example/cars" },
        ],
      },
    },
    {
      type: "web_search_call", id: "web-2", status: "completed",
      action: { type: "open_page", url: "https://service.example/risks" },
    },
    {
      type: "web_search_call", id: "web-failed", status: "failed",
      action: { type: "open_page", url: "https://failed.example/" },
    },
    { type: "web_search_call", id: "bad-null", status: "completed", action: null },
    { type: "web_search_call", id: "bad-sources", status: "completed", action: { type: "search", sources: {} } },
    {
      type: "web_search_call", id: "bad-members", status: "completed",
      action: { type: "search", sources: [null, { type: "url", url: 7 }] },
    },
  ] as unknown as ResponseOutputItem[];

  assert.deepEqual(citationsFromWebEvidence(items), [
    { startIndex: 0, endIndex: 0, title: "market.example", url: "https://market.example/cars?a=1" },
    { startIndex: 0, endIndex: 0, title: "service.example", url: "https://service.example/risks" },
  ]);
});
