import assert from "node:assert/strict";
import test from "node:test";
import { requiresHostedWebSearchFirstLeg } from "../src/bot/responses/web-intent.js";

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
