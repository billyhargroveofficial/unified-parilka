import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { citationsFromWebEvidence } from "../src/openai-responses/response-output.js";

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
