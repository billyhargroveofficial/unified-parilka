import assert from "node:assert/strict";
import test from "node:test";
import {
  requiresBoundedHostedWebResearch,
  requiresHostedWebSearchFirstLeg,
} from "../src/bot/responses/web-intent.js";

test("explicit requests for hosted web/search/fetch require the first hosted call", () => {
  for (const text of [
    "Проверь, работает ли вебпоиск и фетч",
    "используй веб-поиск для этого",
    "можешь сделать fetch страницы?",
    "загугли свежую информацию",
  ]) {
    assert.equal(requiresHostedWebSearchFirstLeg(text), true, text);
  }
});

test("ordinary chat and local-history requests leave hosted web optional", () => {
  for (const text of [
    "привет, как дела",
    "найди в истории чата то старое сообщение",
    "что ты думаешь про баню",
    "поиск в этой переписке полезен?",
  ]) {
    assert.equal(requiresHostedWebSearchFirstLeg(text), false, text);
  }
});

test("explicit web negation is not inverted into a required hosted call", () => {
  for (const text of [
    "Веб не используй",
    "не используй интернет, проверь локальную историю",
    "без веба найди это в переписке",
    "web_search не делай; используй keyword_search",
    "не нужно использовать интернет, ответь из памяти",
    "интернет использовать не надо",
  ]) {
    assert.equal(requiresHostedWebSearchFirstLeg(text), false, text);
  }
  assert.equal(
    requiresHostedWebSearchFirstLeg("не используй поиск по истории, используй веб"),
    true,
  );
  assert.equal(
    requiresHostedWebSearchFirstLeg("веб не используй, но fetch страницы сделай"),
    true,
  );
});

test("explicit deep-research wording opts into bounded hosted research", () => {
  for (const text of [
    "Проведи deep dive research по BMW E60 в РФ",
    "Сделай дип-дайв ресерч цен на тачки в августе 2026",
    "Нужно глубокое исследование рынка квартир",
    "Проведи нереальный дип дайв ресерч и выдай лучший вариант",
    "проведи глубокий веб-ресерч по официальным источникам",
    "deep web research current Node.js LTS",
    "deep_research current GPU prices",
  ]) {
    assert.equal(requiresBoundedHostedWebResearch(text), true, text);
  }
});

test("a public arXiv paper explicitly requested for detailed study opts into bounded research", () => {
  for (const text of [
    "https://arxiv.org/abs/2608.25593 @bichiycepenstotri_bot объяснить что за пейпер и чем полезен детальное изучение",
    "https://arxiv.org/abs/2508.08077 paper: сделай детальное изучение",
    "Нужно детальное изучение этой статьи https://arxiv.org/pdf/2508.08077v2.pdf",
    "Изучи статью https://arxiv.org/abs/2508.08077 детально",
    "Сделай подробный разбор статьи https://arxiv.org/abs/2508.08077",
  ]) {
    assert.equal(requiresBoundedHostedWebResearch(text), true, text);
  }
});

test("generic detail and explicitly local or no-web research stay off the bounded path", () => {
  for (const text of [
    "Подробно расскажи про BMW",
    "Сделай детальное изучение статьи без публичной arXiv-ссылки",
    "Сделай детальное изучение статьи https://example.test/paper",
    "Изучи статью https://arxiv.org/abs/2508.08077",
    "Подбери тачку за миллион",
    "Сравни две машины",
    "Сделай дип дайв по истории этого чата",
    "Без веба сделай ресерч по приложенному документу",
    "Не делай deep research, ответь коротко",
    "Не делай дип-дайв ресерч, ответь коротко",
    "Без дип-дайв ресерча, ответь из памяти",
    "Не нужно проводить исследование, ответь из памяти",
    "Не делай глубокий веб-ресерч, ответь из памяти",
    "Without tools: не проводи deep web research",
    "Веб не используй, проведи глубокое исследование по приложенному файлу",
    "Не нужно использовать интернет, сделай deep research по своим знаниям",
    "Без веба сделай детальное изучение статьи https://arxiv.org/abs/2508.08077",
    "Сделай детальное изучение статьи из приложенного документа https://arxiv.org/abs/2508.08077",
    "Статья: не делай детальное изучение https://arxiv.org/abs/2508.08077",
    "https://arxiv.org/abs/2508.08077 — статья, не нужно её детально изучать",
    "Не анализируй статью https://arxiv.org/abs/2508.08077 подробно",
    undefined,
  ]) {
    assert.equal(requiresBoundedHostedWebResearch(text), false, String(text));
  }
});

test("an explicit positive web clause takes precedence over local research scope", () => {
  assert.equal(
    requiresBoundedHostedWebResearch("Сделай дип дайв по истории чата и проверь вывод через веб-поиск"),
    true,
  );
});
