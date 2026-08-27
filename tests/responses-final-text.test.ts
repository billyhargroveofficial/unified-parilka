import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponsesFinalText } from "../src/bot/responses/final-text.js";

test("removes only an accidental one-field answer envelope", () => {
  assert.equal(normalizeResponsesFinalText('{"answer":"**Чистый** ответ"}'), "**Чистый** ответ");
  assert.equal(
    normalizeResponsesFinalText('```json\n{"answer":"[Источник](https://example.test)"}\n```'),
    "[Источник](https://example.test)",
  );
  assert.equal(
    normalizeResponsesFinalText('{"answer":"данные","confidence":0.9}'),
    '{"answer":"данные","confidence":0.9}',
  );
  assert.equal(normalizeResponsesFinalText("  Обычный Markdown  "), "Обычный Markdown");
});

test("removes opaque subscription citation placeholders from visible text", () => {
  assert.equal(
    normalizeResponsesFinalText("Факт. citeturn2search0turn3search1\n\nИтог."),
    "Факт.\n\nИтог.",
  );
  assert.equal(
    normalizeResponsesFinalText('{"answer":"Факт fileciteturn0file0"}'),
    "Факт",
  );
});
