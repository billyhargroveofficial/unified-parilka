import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeFinalText } from "../src/bot/agent/final-sanitizer.js";

// ─── Final sanitizer ────────────────────────────────────────────────────────

test("sanitizer recognizes web tool failures and permits evidence URLs", () => {
  const claim = "Не смог проверить: searxng_search сегодня не работает.";
  const withFailure = sanitizeFinalText({
    text: claim,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [{ name: "searxng_search", code: "provider_error" }],
  });
  assert.match(withFailure, /не работает/u);

  const withoutFailure = sanitizeFinalText({
    text: claim,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [],
  });
  assert.doesNotMatch(withoutFailure, /не работает/u);

  const firecrawlClaim = "firecrawl_crawl упал.";
  const firecrawlSanitized = sanitizeFinalText({
    text: firecrawlClaim,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [{ name: "firecrawl_crawl", code: "provider_error" }],
  });
  assert.match(firecrawlSanitized, /упал/u);
});

test("sanitizer allows only evidence URLs when sources are requested", () => {
  const evidence = [{
    source: "web" as const,
    chat: null,
    message: null,
    speaker: { id: null, name: null },
    date: null,
    text: "Page title",
    url: "https://example.com/page",
    title: "Page title",
  }];
  const result = sanitizeFinalText({
    text: "- [Page title](https://example.com/page)\n- [Фейк](https://evil.example/x)",
    toolEvidence: evidence,
    researchMode: false,
    readToolFailures: [],
    externalSourcesRequested: true,
  });
  // Evidence URLs are permitted (in the appended sources summary); other
  // URLs are removed and their links reduced to the bare label.
  assert.match(result, /https:\/\/example\.com\/page/u);
  assert.doesNotMatch(result, /evil\.example/u);
  assert.match(result, /Фейк/u);
  assert.doesNotMatch(result, /Фейк\]\(/u);
});
