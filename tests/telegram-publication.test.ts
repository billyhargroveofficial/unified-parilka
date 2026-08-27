import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelegramPublication,
  normalizeTelegramMarkdownTables,
  TELEGRAM_RICH_TEXT_LIMIT_UTF8,
  utf8Length,
} from "../src/bot/telegram-publication.js";

test("keeps a long model reply on the native rich path", () => {
  const text = `# Заголовок\n\n${"длинный абзац ".repeat(500)}`;
  const publication = createTelegramPublication(text);

  assert.ok(utf8Length(text) > 4_096);
  assert.ok(utf8Length(text) <= TELEGRAM_RICH_TEXT_LIMIT_UTF8);
  assert.equal(publication.mode, "rich");
  assert.equal(publication.markdown, text);
});

test("uses classic plain fallback only beyond the rich-message limit", () => {
  const text = "x".repeat(TELEGRAM_RICH_TEXT_LIMIT_UTF8 + 1);
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "plain");
  assert.equal(publication.plainText, text);
});

test("local audio publication stays plain", () => {
  const text = "Расшифровка голосового сообщения.";
  const publication = createTelegramPublication(text, "local_audio");

  assert.equal(publication.mode, "plain");
  assert.equal(publication.plainText, text);
});

test("production-shaped orphan separator with nine columns becomes multiline record blocks", () => {
  const text = [
    `|${":---|"}${"---|".repeat(8)}`,
    "| a1 | a2 | a3 | a4 | a5 | a6 | a7 | a8 | a9 |",
    "| b1 | b2 | b3 | b4 | b5 | b6 | b7 | b8 | b9 |",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(
    publication.markdown,
    [
      "**1.**",
      "- a1",
      "- a2",
      "- a3",
      "- a4",
      "- a5",
      "- a6",
      "- a7",
      "- a8",
      "- a9",
      "",
      "**2.**",
      "- b1",
      "- b2",
      "- b3",
      "- b4",
      "- b5",
      "- b6",
      "- b7",
      "- b8",
      "- b9",
    ].join("\n"),
  );
  assert.equal(
    publication.plainText,
    [
      "1.",
      "- a1",
      "- a2",
      "- a3",
      "- a4",
      "- a5",
      "- a6",
      "- a7",
      "- a8",
      "- a9",
      "",
      "2.",
      "- b1",
      "- b2",
      "- b3",
      "- b4",
      "- b5",
      "- b6",
      "- b7",
      "- b8",
      "- b9",
    ].join("\n"),
  );
  assert.ok(!publication.markdown.includes("|"));
  assert.ok(!publication.markdown.includes("---"));
  assert.equal(
    normalizeTelegramMarkdownTables(publication.markdown),
    publication.markdown,
  );
});

test("orphan separator after prose keeps the prose and drops the raw alignment row", () => {
  const text = [
    "Итоги заезда:",
    "|:---|---|",
    "| one | two |",
    "| three | four |",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(
    publication.markdown,
    ["Итоги заезда:", "- one · two", "- three · four"].join("\n"),
  );
});

test("a lone orphan separator keeps its cell text and is idempotent", () => {
  const standalone = createTelegramPublication("| :--- | ---: |");

  assert.equal(standalone.mode, "rich");
  assert.equal(standalone.markdown, "- :--- · ---:");
  assert.ok(!standalone.markdown.includes("|"));
  assert.equal(
    normalizeTelegramMarkdownTables(standalone.markdown),
    standalone.markdown,
  );

  const inProse = createTelegramPublication(
    ["Сводка:", "|:---|---|", "Финал."].join("\n"),
  );

  assert.equal(inProse.mode, "rich");
  assert.equal(
    inProse.markdown,
    ["Сводка:", "- :--- · ---", "Финал."].join("\n"),
  );
});

test("one blank line between header and separator stays one invalid block", () => {
  const text = [
    "Сравнение:",
    "| h1 | h2 |",
    "",
    "| --- | --- |",
    "| d1 | d2 |",
    "| e1 | e2 |",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(
    publication.markdown,
    ["Сравнение:", "- h1 · h2", "- d1 · d2", "- e1 · e2"].join("\n"),
  );
  assert.ok(!publication.markdown.includes("|"));
  assert.equal(
    normalizeTelegramMarkdownTables(publication.markdown),
    publication.markdown,
  );
});

test("spaced header with wide rows feeds header and data through the fallback in order", () => {
  const text = [
    "| h1 | h2 | h3 | h4 | h5 |",
    "",
    "| --- | --- |",
    "| a1 | a2 | a3 | a4 | a5 |",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(
    publication.markdown,
    [
      "**1.**",
      "- h1",
      "- h2",
      "- h3",
      "- h4",
      "- h5",
      "",
      "**2.**",
      "- a1",
      "- a2",
      "- a3",
      "- a4",
      "- a5",
    ].join("\n"),
  );
  assert.ok(!publication.markdown.includes("|"));
  assert.equal(
    normalizeTelegramMarkdownTables(publication.markdown),
    publication.markdown,
  );
});

test("two blank lines before the separator stay outside the block boundary", () => {
  const text = [
    "| h1 | h2 |",
    "",
    "",
    "| --- | --- |",
    "| d1 | d2 |",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(
    publication.markdown,
    ["| h1 | h2 |", "", "", "- d1 · d2"].join("\n"),
  );
});

test("a separator after a kept table never peels the table rows back off", () => {
  const text = [
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "| --- | --- |",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(
    publication.markdown,
    ["| a | b |", "| --- | --- |", "| 1 | 2 |", "", "- --- · ---"].join("\n"),
  );
});

test("an independent one-blank block after a kept table is still detected", () => {
  const text = [
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "Дальше черновик сломан:",
    "| h1 | h2 |",
    "",
    "| --- | --- |",
    "| d1 | d2 |",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(
    publication.markdown,
    [
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Дальше черновик сломан:",
      "- h1 · h2",
      "- d1 · d2",
    ].join("\n"),
  );
  assert.equal(
    normalizeTelegramMarkdownTables(publication.markdown),
    publication.markdown,
  );
});

test("valid compact GFM tables with 2-4 columns stay byte-identical", () => {
  const text = [
    "# Сравнение",
    "",
    "| Модель | Цена |",
    "| :--- | ---: |",
    "| A | 10 |",
    "",
    "| Модель | Цена | Наличие | Гарантия |",
    "| --- | --- | --- | --- |",
    "| A | 10 | да | 1 год |",
    "| B | 20 | нет | 2 года |",
    "",
    "Финал.",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(publication.markdown, text);
  assert.equal(
    publication.plainText,
    [
      "Сравнение",
      "",
      "Модель · Цена",
      "- A · 10",
      "",
      "Модель · Цена · Наличие · Гарантия",
      "- A · 10 · да · 1 год",
      "- B · 20 · нет · 2 года",
      "",
      "Финал.",
    ].join("\n"),
  );
});

test("valid wide tables become labeled mobile-friendly record blocks", () => {
  const text = [
    "Смотрим конфиги:",
    "",
    "| Имя | Цена | CPU | RAM | Диск |",
    "| --- | --- | --- | --- | --- |",
    "| A | 10 | x | 8 | 512 |",
    "| B | 20 | y | 16 | 1024 |",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(
    publication.markdown,
    [
      "Смотрим конфиги:",
      "",
      "**1.**",
      "- Имя: A",
      "- Цена: 10",
      "- CPU: x",
      "- RAM: 8",
      "- Диск: 512",
      "",
      "**2.**",
      "- Имя: B",
      "- Цена: 20",
      "- CPU: y",
      "- RAM: 16",
      "- Диск: 1024",
    ].join("\n"),
  );
  assert.equal(
    publication.plainText,
    [
      "Смотрим конфиги:",
      "",
      "1.",
      "- Имя: A",
      "- Цена: 10",
      "- CPU: x",
      "- RAM: 8",
      "- Диск: 512",
      "",
      "2.",
      "- Имя: B",
      "- Цена: 20",
      "- CPU: y",
      "- RAM: 16",
      "- Диск: 1024",
    ].join("\n"),
  );
  assert.ok(!publication.markdown.includes("|"));
});

test("ragged and short-dash tables degrade to compact bullets without invented labels", () => {
  const ragged = [
    "| h1 | h2 | h3 |",
    "| --- | --- |",
    "| a | b | c |",
  ].join("\n");
  const raggedPublication = createTelegramPublication(ragged);

  assert.equal(raggedPublication.mode, "rich");
  assert.equal(
    raggedPublication.markdown,
    ["- h1 · h2 · h3", "- a · b · c"].join("\n"),
  );
  assert.equal(
    normalizeTelegramMarkdownTables(raggedPublication.markdown),
    raggedPublication.markdown,
  );

  const shortDashes = [
    "| h1 | h2 |",
    "| -- | -- |",
    "| 1 | 2 |",
  ].join("\n");
  const shortDashPublication = createTelegramPublication(shortDashes);

  assert.equal(shortDashPublication.mode, "rich");
  assert.equal(
    shortDashPublication.markdown,
    ["- h1 · h2", "- 1 · 2"].join("\n"),
  );
});

test("headerless fallback keeps short rows compact and blocks wide rows", () => {
  const text = [
    "| --- | --- | --- | --- | --- |",
    "| short | row |",
    "| c1 | c2 | c3 | c4 | c5 |",
    "| tail | row | here |",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(
    publication.markdown,
    [
      "- short · row",
      "",
      "**1.**",
      "- c1",
      "- c2",
      "- c3",
      "- c4",
      "- c5",
      "",
      "- tail · row · here",
    ].join("\n"),
  );
  assert.ok(!publication.markdown.includes("|"));
  assert.equal(
    normalizeTelegramMarkdownTables(publication.markdown),
    publication.markdown,
  );
});

test("Markdown fallback keeps code and prose visible while removing presentation syntax", () => {
  const text = [
    "```sql",
    "SELECT '|' FROM t;",
    "| --- | --- |",
    "```",
    "",
    "> | a | b |",
    "> | --- | --- |",
    "",
    "Формат a | b не таблица, а `|код|` тем более.",
  ].join("\n");
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "rich");
  assert.equal(publication.markdown, text);
  assert.equal(
    publication.plainText,
    [
      "SELECT '|' FROM t;",
      "| --- | --- |",
      "",
      "| a | b |",
      "| --- | --- |",
      "",
      "Формат a | b не таблица, а |код| тем более.",
    ].join("\n"),
  );
});

test("escaped pipes never split prose into table cells", () => {
  const text = "Это просто \\| не таблица \\| совсем.";

  assert.equal(normalizeTelegramMarkdownTables(text), text);
});

test("rich byte limit applies to the normalized text", () => {
  // A giant orphan separator is dropped when data rows follow it, so the raw
  // draft crosses the rich limit while the normalized text stays within it.
  const separatorLine = `|${"---|".repeat(8400)}`;
  const text = `Итог:\n${separatorLine}\n| a |`;

  assert.ok(utf8Length(text) > TELEGRAM_RICH_TEXT_LIMIT_UTF8);
  const publication = createTelegramPublication(text);
  assert.equal(publication.mode, "rich");
  assert.equal(publication.markdown, "Итог:\n- a");
  assert.equal(publication.plainText, "Итог:\n- a");
});

test("normalization that crosses the byte limit falls back to plain", () => {
  const table = [
    "| Имя | Цена |",
    "| --- | --- |",
    "| A | 10 |",
  ].join("\n");
  const text = `${"абзац текста ".repeat(2600)}\n${table}`;

  assert.ok(utf8Length(text) > TELEGRAM_RICH_TEXT_LIMIT_UTF8);
  const publication = createTelegramPublication(text);
  assert.equal(publication.mode, "plain");
  assert.ok(publication.plainText.endsWith("Имя · Цена\n- A · 10"));
});
