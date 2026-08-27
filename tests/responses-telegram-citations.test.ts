import assert from "node:assert/strict";
import test from "node:test";
import { renderTelegramUrlCitations } from "../src/bot/responses-telegram/index.js";

test("renders deduplicated HTTPS url citations as Rich Message links", () => {
  const footer = renderTelegramUrlCitations([
    { type: "url_citation", url: "https://example.com/news", title: "Новости" },
    { type: "url_citation", url: "https://example.com/news", title: "Повтор" },
    { type: "url_citation", url: "https://openai.com/", title: "OpenAI" },
  ]);

  assert.equal(
    footer,
    "\n\nИсточники:\n- [Новости](https://example.com/news)\n- [OpenAI](https://openai.com/)",
  );
});

test("rejects non-HTTPS, credentialed, and malformed citation destinations", () => {
  const footer = renderTelegramUrlCitations([
    { type: "url_citation", url: "http://example.com", title: "HTTP" },
    { type: "url_citation", url: "https://user:pass@example.com", title: "Credentials" },
    { type: "url_citation", url: "not a url", title: "Bad" },
    { type: "url_citation", url: "ftp://example.com", title: "FTP" },
  ]);

  assert.equal(footer, "");
});

test("escapes titles and markdown destination delimiters", () => {
  const footer = renderTelegramUrlCitations([
    {
      type: "url_citation",
      url: "https://example.com/a(b)\\c",
      title: "A ] (unsafe) \\ title",
    },
  ]);

  assert.equal(
    footer,
    "\n\nИсточники:\n- [A \\] \\(unsafe\\) \\\\ title](https://example.com/a%28b%29/c)",
  );
  assert.doesNotMatch(footer, /\]\(unsafe\)/u);
});

test("uses a bounded numbered fallback title", () => {
  const footer = renderTelegramUrlCitations([
    { type: "url_citation", url: "https://example.com/a" },
    { type: "url_citation", url: "https://example.com/b", title: "   " },
  ]);

  assert.equal(
    footer,
    "\n\nИсточники:\n- [Источник 1](https://example.com/a)\n- [Источник 2](https://example.com/b)",
  );
});

test("omits a footer citation already linked in final Markdown but retains missing ones", () => {
  const footer = renderTelegramUrlCitations([
    { type: "url_citation", url: "https://developers.openai.com/api/docs/models/gpt-5.6-luna?utm_source=openai", title: "GPT-5.6 Luna" },
    { type: "url_citation", url: "https://example.com/extra", title: "Дополнительно" },
  ], "Официальная [документация](https://developers.openai.com/api/docs/models/gpt-5.6-luna?utm_source=openai).");

  assert.equal(footer, "\n\nИсточники:\n- [Дополнительно](https://example.com/extra)");
});
