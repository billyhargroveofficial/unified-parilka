import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeFinalText } from "../src/bot/agent/final-sanitizer.js";
import { ReadToolEvidence } from "../src/bot/read-tools/contracts.js";

const allowedEvidence: ReadToolEvidence[] = [
  {
    source: "paper",
    chat: null,
    message: null,
    speaker: { id: null, name: null },
    date: "2026",
    title:
      "A randomized sleep phase advance protocol for circadian realignment",
    url: "https://example.org/paper/phase-advance",
    text: "A short abstract.",
  },
];

test("удаляет явно выдуманные ссылки с author+et al.", () => {
  const draft = [
    "Чек по источникам:",
    "Monterastelli et al. 2026 (вечерний свет убирает phase advance).",
    "Soehner & McClung 2026 (обзор).",
    "А это практический совет по сну.",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: true,
    readToolFailures: [],
  });
  assert.equal(final.includes("Monterastelli"), false);
  assert.equal(final.includes("Soehner"), false);
  assert.equal(final.includes("А это практический совет"), true);
});

test("externalSourcesRequested=false убирает подтверждённые и неподтверждённые источники", () => {
  const draft = [
    "Тут есть ссылка на пример:",
    "[paper](https://example.org/paper/phase-advance)",
    "И ложная ссылка: https://fake.example.ru/study",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: allowedEvidence,
    researchMode: true,
    readToolFailures: [],
    externalSourcesRequested: false,
  });
  assert.equal(final.includes("https://fake.example.ru/study"), false);
  assert.equal(final.includes("https://example.org/paper/phase-advance"), false);
  assert.equal(final.includes("paper"), true);
  assert.equal(final.includes("Подтвержденные источники"), false);
});

test("externalSourcesRequested=true сохраняет подтверждённые источники и убирает неподтверждённые", () => {
  const draft = [
    "Тут есть ссылка на пример:",
    "[paper](https://example.org/paper/phase-advance)",
    "И ложная ссылка: https://fake.example.ru/study",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: allowedEvidence,
    researchMode: true,
    readToolFailures: [],
    externalSourcesRequested: true,
  });
  assert.equal(final.includes("https://fake.example.ru/study"), false);
  assert.equal(final.includes("https://example.org/paper/phase-advance"), true);
  assert.equal(final.includes("Подтвержденные источники"), true);
});

test("в обычном режиме не меняет нормальный текст без источников", () => {
  const draft = "Никаких источников не нужно, просто совет.";
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [],
  });
  assert.equal(final, draft);
});

test("убирает ложное сообщение о поломанном веб-поиске, если не было ошибки", () => {
  const draft = [
    "Веб-поиск сегодня лег, но paper_search отработал.",
    "Сейчас даю практический план.",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: allowedEvidence,
    researchMode: true,
    readToolFailures: [],
  });
  assert.equal(final.includes("Веб-поиск сегодня лег"), false);
  assert.equal(final.includes("Сейчас даю практический план"), true);
});

test("сохраняет обычный ответ с URL", () => {
  const draft = "документация: https://nodejs.org/api";
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [],
  });
  assert.equal(final, draft);
});

test("сохраняет обычный ответ с markdown-ссылкой", () => {
  const draft = "[docs](https://nodejs.org)";
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [],
  });
  assert.equal(final, draft);
});

test("сохраняет обычный ответ с author-year цитатой", () => {
  const draft = "(Smith & Jones 2019)";
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [],
  });
  assert.equal(final, draft);
});

test("в research-режиме без evidence удаляет URL", () => {
  const draft = "документация: https://nodejs.org/api";
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: true,
    readToolFailures: [],
  });
  assert.equal(final.includes("https://nodejs.org/api"), false);
});

test("в research-режиме с web evidence externalSourcesRequested=false удаляет все URL", () => {
  const evidence: ReadToolEvidence[] = [
    {
      source: "web",
      chat: null,
      message: null,
      speaker: { id: null, name: null },
      date: "2024",
      title: "Node.js docs",
      url: "https://nodejs.org/api",
      text: "Documentation.",
    },
  ];
  const draft = [
    "Подтверждённая: https://nodejs.org/api",
    "Неподтверждённая: https://fake.example.ru/study",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: evidence,
    researchMode: true,
    readToolFailures: [],
    externalSourcesRequested: false,
  });
  assert.equal(final.includes("https://nodejs.org/api"), false);
  assert.equal(final.includes("https://fake.example.ru/study"), false);
});

test("в research-режиме с web evidence externalSourcesRequested=true сохраняет подтверждённые URL", () => {
  const evidence: ReadToolEvidence[] = [
    {
      source: "web",
      chat: null,
      message: null,
      speaker: { id: null, name: null },
      date: "2024",
      title: "Node.js docs",
      url: "https://nodejs.org/api",
      text: "Documentation.",
    },
  ];
  const draft = [
    "Подтверждённая: https://nodejs.org/api",
    "Неподтверждённая: https://fake.example.ru/study",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: evidence,
    researchMode: true,
    readToolFailures: [],
    externalSourcesRequested: true,
  });
  assert.equal(final.includes("https://nodejs.org/api"), true);
  assert.equal(final.includes("https://fake.example.ru/study"), false);
});

test("удаляет ложную строку об ошибке поиска в обоих режимах", () => {
  const draft = [
    "Веб-поиск сегодня лег, но paper_search отработал.",
    "Сейчас даю практический план.",
  ].join("\n");
  const normalFinal = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [],
  });
  const researchFinal = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: true,
    readToolFailures: [],
  });
  assert.equal(normalFinal.includes("Веб-поиск сегодня лег"), false);
  assert.equal(normalFinal.includes("Сейчас даю практический план"), true);
  assert.equal(researchFinal.includes("Веб-поиск сегодня лег"), false);
  assert.equal(researchFinal.includes("Сейчас даю практический план"), true);
});

test("сохраняет сообщение о сломанном поиске, если это реально зафиксировано", () => {
  const draft = [
    "Веб-поиск сегодня лег.",
    "paper_search отработал с результатами.",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: allowedEvidence,
    researchMode: true,
    readToolFailures: [{ name: "web_search", code: "provider_error" }],
  });
  assert.equal(final.includes("Веб-поиск сегодня лег"), true);
  assert.equal(final.includes("paper_search отработал с результатами"), true);
});

test("не удаляет содержательные строки про Firecrawl и Markdown", () => {
  const draft = [
    "Firecrawl crawled the page and converted it into clean Markdown.",
    "Firecrawl конвертирует сайты в чистый Markdown — вот результат.",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [],
  });
  assert.equal(final.includes("converted it into clean Markdown"), true);
  assert.equal(final.includes("конвертирует сайты в чистый Markdown"), true);
});

test("удаляет заявления о падении Firecrawl без зафиксированной ошибки", () => {
  const claims = [
    "Firecrawl is down, so the page could not be crawled.",
    "firecrawl failed to fetch the page.",
    "Firecrawl is offline right now.",
  ];
  for (const claim of claims) {
    const final = sanitizeFinalText({
      text: claim,
      toolEvidence: [],
      researchMode: false,
      readToolFailures: [],
    });
    assert.equal(final, "", `должно быть удалено: ${claim}`);
  }
});

test("сохраняет заявления о падении Firecrawl при зафиксированной ошибке", () => {
  const claims = [
    "Firecrawl is down, so the page could not be crawled.",
    "firecrawl failed to fetch the page.",
    "Firecrawl is offline right now.",
  ];
  for (const claim of claims) {
    const final = sanitizeFinalText({
      text: claim,
      toolEvidence: [],
      researchMode: false,
      readToolFailures: [{ name: "firecrawl_crawl", code: "provider_error" }],
    });
    assert.equal(final.includes(claim), true, `должно сохраниться: ${claim}`);
  }
});

test("удаляет ложное заявление о падении static_page_fetch без зафиксированной ошибки", () => {
  const claims = [
    "static_page_fetch не работает, страница не открылась.",
    "static_page_fetch failed to load the page.",
    "static_page_fetch сегодня лёг.",
  ];
  for (const claim of claims) {
    const final = sanitizeFinalText({
      text: claim,
      toolEvidence: [],
      researchMode: false,
      readToolFailures: [],
    });
    assert.equal(final, "", `должно быть удалено: ${claim}`);
  }
});

test("сохраняет заявление о падении static_page_fetch при зафиксированной ошибке", () => {
  const claims = [
    "static_page_fetch не работает, страница не открылась.",
    "static_page_fetch failed to load the page.",
    "static_page_fetch сегодня лёг.",
  ];
  for (const claim of claims) {
    const final = sanitizeFinalText({
      text: claim,
      toolEvidence: [],
      researchMode: false,
      readToolFailures: [{ name: "static_page_fetch", code: "provider_error" }],
    });
    assert.equal(final.includes(claim), true, `должно сохраниться: ${claim}`);
  }
});
