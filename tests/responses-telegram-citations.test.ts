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

test("keeps a long but bounded HTTPS destination", () => {
  const url = `https://example.com/${"a".repeat(4_000)}`;
  const footer = renderTelegramUrlCitations([{ type: "url_citation", url, title: "Длинный источник" }]);

  assert.equal(footer, `\n\nИсточники:\n- [Длинный источник](${url})`);
});

test("omits a footer citation already linked in final Markdown but retains missing ones", () => {
  const footer = renderTelegramUrlCitations([
    { type: "url_citation", url: "https://developers.openai.com/api/docs/models/gpt-5.6-luna?utm_source=openai", title: "GPT-5.6 Luna" },
    { type: "url_citation", url: "https://example.com/extra", title: "Дополнительно" },
  ], "Официальная [документация](https://developers.openai.com/api/docs/models/gpt-5.6-luna?utm_source=openai).");

  assert.equal(footer, "\n\nИсточники:\n- [Дополнительно](https://example.com/extra)");
});

test("collapses tracking variants and a bare final URL into distinct page citations", () => {
  const footer = renderTelegramUrlCitations([
    { type: "url_citation", url: "https://nodejs.org/en/download?utm_source=feed", title: "nodejs.org" },
    { type: "url_citation", url: "https://nodejs.org/en/download?fbclid=tracking", title: "nodejs.org" },
    { type: "url_citation", url: "https://nodejs.org/en/about/previous-releases", title: "nodejs.org" },
    { type: "url_citation", url: "https://nodejs.org/en/about/eol", title: "nodejs.org" },
  ], "Официальный источник: https://nodejs.org/en/download.");

  assert.equal(
    footer,
    "\n\nИсточники:\n- [nodejs.org — /en/about/previous-releases](https://nodejs.org/en/about/previous-releases)\n- [nodejs.org — /en/about/eol](https://nodejs.org/en/about/eol)",
  );
});

test("preserves distinct semantic query pages and bounds the citation footer", () => {
  const footer = renderTelegramUrlCitations([
    { type: "url_citation", url: "https://example.com/article?id=2", title: "example.com" },
    { type: "url_citation", url: "https://example.com/article?id=3", title: "example.com" },
    { type: "url_citation", url: "https://example.com/a", title: "A" },
    { type: "url_citation", url: "https://example.com/b", title: "B" },
    { type: "url_citation", url: "https://example.com/c", title: "C" },
  ]);

  assert.equal(
    footer,
    "\n\nИсточники:\n- [example.com — /article?id=2](https://example.com/article?id=2)\n- [example.com — /article?id=3](https://example.com/article?id=3)\n- [A](https://example.com/a)\n- [B](https://example.com/b)",
  );
  assert.doesNotMatch(footer, /example\.com\/c/u);
});

test("trims typographic prose punctuation after a bare final URL", () => {
  const footer = renderTelegramUrlCitations([
    { type: "url_citation", url: "https://example.com/article", title: "Статья" },
  ], "Читай «https://example.com/article».");

  assert.equal(footer, "");
});

test("keeps query order and fragments as part of citation identity", () => {
  const footer = renderTelegramUrlCitations([
    { type: "url_citation", url: "https://example.com/doc?a=1&b=2", title: "example.com" },
    { type: "url_citation", url: "https://example.com/doc?b=2&a=1", title: "example.com" },
    { type: "url_citation", url: "https://example.com/doc#one", title: "example.com" },
    { type: "url_citation", url: "https://example.com/doc#two", title: "example.com" },
  ]);

  assert.match(footer, /\/doc\?a=1&b=2/u);
  assert.match(footer, /\/doc\?b=2&a=1/u);
  assert.match(footer, /\/doc#one/u);
  assert.match(footer, /\/doc#two/u);
});
