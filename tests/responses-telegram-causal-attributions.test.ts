import assert from "node:assert/strict";
import test from "node:test";
import { renderTelegramCausalAttributions } from "../src/bot/responses-telegram/index.js";
import type { CausalRagSource } from "../src/bot/causal-rag/index.js";

const sources: readonly CausalRagSource[] = [
  { label: "〔C1〕", kind: "context", messageId: 7 },
  { label: "〔H1〕", kind: "history", messageId: 6 },
  { label: "〔D1〕", kind: "digest", dayFrom: "2026-08-25", dayTo: "2026-08-25" },
];

test("causal labels become generic host-rendered attributions", () => {
  const rendered = renderTelegramCausalAttributions(
    "Решение уже было принято 〔C1〕, а детали есть в истории 〔H1〕 и сводке 〔D1〕.",
    sources,
  );

  assert.equal(
    rendered,
    "Решение уже было принято , а детали есть в истории  и сводке .\n\nИспользованный контекст:\n- Ближайшая переписка\n- Найденные фрагменты истории\n- Краткие сводки истории",
  );
  assert.doesNotMatch(rendered, /〔[CHD]\d+〕/u);
  assert.doesNotMatch(rendered, /\b(?:6|7)\b/u);
  assert.doesNotMatch(rendered, /2026-08-25/u);
});

test("forged, malformed, and unmentioned labels are stripped without attribution", () => {
  const rendered = renderTelegramCausalAttributions(
    "〔C999〕 〔H0〕 〔D2〕 〔X1〕",
    [
      ...sources,
      // Structural typing is deliberately not treated as provenance.
      { label: "〔C999〕", kind: "history", messageId: 8 },
      { label: "〔D2〕", kind: "digest", dayFrom: "not-a-date", dayTo: "not-a-date" },
    ],
  );

  assert.equal(rendered, "   〔X1〕");
  assert.doesNotMatch(rendered, /Использованный контекст/u);
  assert.doesNotMatch(rendered, /〔[CHD]\d+〕/u);
});

test("does not append a provenance footer when the model did not cite causal labels", () => {
  assert.equal(
    renderTelegramCausalAttributions("Обычный ответ", sources),
    "Обычный ответ",
  );
});
