import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToReadablePlainText } from "../src/bot/telegram-markdown-plain.js";
import { createTelegramPublication, normalizeTelegramMarkdownTables } from "../src/bot/telegram-publication.js";

test("plain projection preserves visible text and citation URLs without raw Markdown", () => {
  const markdown = [
    "# **Итог**", "", "> _Это_ [источник](https://example.com/report?q=1).",
    "- ![Схема](https://example.com/diagram.png)", "", "```ts",
    "const literal = '**не стиль**';", "```", "", "| Модель | Тариф |",
    "| --- | --- |", "| Luna | fast |",
  ].join("\n");
  const expected = [
    "Итог", "", "Это источник (https://example.com/report?q=1).",
    "- Схема (https://example.com/diagram.png)", "",
    "const literal = '**не стиль**';", "", "Модель · Тариф", "- Luna · fast",
  ].join("\n");

  assert.equal(markdownToReadablePlainText(markdown), expected);
  const publication = createTelegramPublication(markdown);
  assert.equal(publication.mode, "rich");
  assert.equal(publication.plainText, expected);
  assert.ok(!publication.plainText.includes("[источник]("));
  assert.ok(publication.plainText.includes("https://example.com/report?q=1"));
});

test("plain projection is deterministic and bounded for Markdown fuzz", () => {
  const random = mulberry32(0x5eed_c0de);
  const fragments = [
    "обычный текст ", "**жирный** ", "_курсив_ ", "~~зачёркнуто~~ ",
    "[ссылка](https://example.com/a_(b)) ", "![картинка](https://example.com/i.png) ",
    "`код` ", "<https://example.com/auto> ", "[незакрытая ",
    "\\*экранировано\\* ", "snake_case и 2 ** 3 ", "| не таблица | ", "\n",
  ];

  for (let sample = 0; sample < 300; sample += 1) {
    let markdown = "";
    const count = 1 + Math.floor(random() * 80);
    for (let index = 0; index < count; index += 1) {
      markdown += fragments[Math.floor(random() * fragments.length)] ?? "";
    }
    const normalized = normalizeTelegramMarkdownTables(markdown);
    const first = markdownToReadablePlainText(normalized);
    assert.equal(first, markdownToReadablePlainText(normalized));
    assert.ok(first.length <= normalized.length);
  }

  const pathological = `${"[".repeat(16_384)}${"*".repeat(16_384)}`;
  const projected = markdownToReadablePlainText(pathological);
  assert.equal(projected, markdownToReadablePlainText(pathological));
  assert.ok(projected.length <= pathological.length);
});

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
