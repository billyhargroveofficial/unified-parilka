import assert from "node:assert/strict";
import { test } from "node:test";
import { botMemoryWriteAllowedForText } from "../src/bot/memory-policy.js";

test("bare imperatives open the write gate for reply-turn context", () => {
  const allowed = [
    // bare imperatives
    "запиши",
    "запиши это",
    "записывай",
    "записывай это",
    "сохрани",
    "сохрани это",
    "сохраняй",
    "сохраняй это",
    "запомни",
    "запомни это",
    "запоминай",
    "запоминай это",
    // with Telegram mention
    "@bot запиши",
    "@bichiycepenstotri_bot запиши",
    "@bot запиши это",
    "@bot сохрани",
    "@bot запиши, пожалуйста",
    // with confirmation particles
    "да запиши",
    "да, запиши",
    "да запиши это",
    "ок сохрани",
    "ок, сохрани",
    "ок, сохрани это",
    "ага запиши",
    "ага, запиши",
    "ладно сохрани",
    "ладно, сохрани это",
    "ну запиши",
    "ну, запиши",
    "ну, запиши это",
    // with please
    "пожалуйста запиши",
    "пожалуйста, запиши",
    "пожалуйста, запиши это",
    "запиши пожалуйста",
    "запиши, пожалуйста",
    "запиши это, пожалуйста",
    "запиши пожалуйста это",
    "запиши, пожалуйста, это",
    "сохрани пожалуйста это",
    "сохрани, пожалуйста, это",
    "запомни пожалуйста это",
    "запоминай пожалуйста это",
    "сохрани плз",
    "запиши плиз",
    "запомни плиз это",
    // English bare forms
    "save",
    "save this",
    "save this please",
    "please save",
    "please save this",
  ];

  for (const text of allowed) {
    assert.equal(botMemoryWriteAllowedForText(text), true, `allowed: "${text}"`);
  }
});

test("existing full-form commands still open the gate", () => {
  const allowed = [
    "запомни это в память на будущее",
    "запоминай это в память на будущее",
    "запоминай это в урок",
    "создай чатовый навык для релизов",
    "сохрани это в память",
    "запиши это в урок",
    "запиши в навык",
    "добавь это в навык",
    "обнови навык релиза",
    "обнови чатовый навык",
    "remember this",
    "remember",
    "save this memory",
    "save memory",
    "update lesson",
    "create skill",
    "create a skill",
    "save this lesson",
  ];

  for (const text of allowed) {
    assert.equal(botMemoryWriteAllowedForText(text), true, `allowed: "${text}"`);
  }
});

test("negated commands never open the gate", () => {
  const denied = [
    "не запиши",
    "не записывай",
    "не сохраняй",
    "не сохрани",
    "не запоминай",
    "не надо записывать",
    "не нужно сохранять",
    "не надо запоминать это",
    "не записывай это пожалуйста",
    "don't remember",
    "do not save",
    "don't save this",
    "do not create skill",
  ];

  for (const text of denied) {
    assert.equal(botMemoryWriteAllowedForText(text), false, `denied: "${text}"`);
  }
});

test("meta-discourse about the command does not open the gate", () => {
  const denied = [
    "слово запиши само по себе ничего не сохраняет",
    "он сказал запиши",
    "она сказала сохрани это",
    "объясни команду запиши",
    "я не помню команду запиши",
    "как работает сохрани",
    "что делает команда запиши",
    "запиши это не команда",
    "используй запиши для сохранения",
    "напиши запиши в чат",
    "скажи запиши боту",
    "команда запиши это сохраняет данные",
    "надо написать запиши",
    "отправь ему запиши",
  ];

  for (const text of denied) {
    assert.equal(botMemoryWriteAllowedForText(text), false, `denied: "${text}"`);
  }
});

test("ordinary messages and substring accidents do not open the gate", () => {
  const denied = [
    "поищи, что чат говорил о памяти",
    "расскажи про сохранение данных",
    "сохранились ли данные?",
    "привет",
    "как дела",
    "",
    "   ",
    "мне нужно что-то запишить",
    "перезапиши файл",
    "дозапиши данные",
    "сохранились изменения",
    "запомнился момент",
    "на сохранение",
    "за сохранение",
  ];

  for (const text of denied) {
    assert.equal(botMemoryWriteAllowedForText(text), false, `denied: "${text}"`);
  }
});

test("imperative with trailing punctuation is accepted", () => {
  const allowed = [
    "запиши!",
    "запиши?",
    "запиши.",
    "запиши это!",
    "сохрани.",
    "сохрани это?",
    "да, запиши!",
    "ок, сохрани это.",
    "запиши, пожалуйста!",
    "save this.",
    "save this!",
  ];

  for (const text of allowed) {
    assert.equal(botMemoryWriteAllowedForText(text), true, `allowed: "${text}"`);
  }
});

test("excess text after a bare imperative does not open the gate through the bare pattern", () => {
  // These must NOT match the bare imperative — they rely on the full-form
  // pattern (which also doesn't match them) or are genuinely not write requests.
  const denied = [
    "запиши всё что было",
    "запиши мне данные",
    "сохрани файл",
    "сохрани настройки",
    "запиши это в базу",
    "save the whales",
    "save money",
  ];

  for (const text of denied) {
    assert.equal(botMemoryWriteAllowedForText(text), false, `denied: "${text}"`);
  }
});

test("infinitive and non-imperative forms never open the gate", () => {
  const denied = [
    "как запомнить это",
    "объясни как запомнить",
    "нужно запомнить это",
    "надо запомнить это",
    "хочу запомнить",
    "как запоминать",
    "как сохранить данные",
    "попробуй запомнить это",
    "стоит ли запоминать",
    "мне надо сохранить это",
    "давай запомним это",
    "как мне записать",
    "где сохранить",
  ];

  for (const text of denied) {
    assert.equal(botMemoryWriteAllowedForText(text), false, `denied: "${text}"`);
  }
});

test("imperfective negated forms are caught by defense-in-depth NEGATED", () => {
  // Even though the bare imperative ^ anchor would reject these anyway,
  // the NEGATED pattern should catch them upstream for clarity.
  const denied = [
    "не записывай",
    "не сохраняй",
    "не запоминай",
  ];

  for (const text of denied) {
    assert.equal(botMemoryWriteAllowedForText(text), false, `denied: "${text}"`);
  }
});
