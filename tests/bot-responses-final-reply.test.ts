import assert from "node:assert/strict";
import test from "node:test";
import { formatResponsesBotFinalReply } from "../src/bot-daemon/final-reply.js";
import {
  renderTelegramCausalAttributions,
  renderTelegramUrlCitations,
} from "../src/bot/responses-telegram/index.js";

test("Responses final reply formatter leaves an ordinary envelope byte-identical", () => {
  const modelText = "Готово 〔C1〕";
  const citations = [{ type: "url_citation" as const, title: "Источник", url: "https://example.test/doc" }];
  const causalSources = [{ label: "〔C1〕", kind: "context" as const, messageId: 7 }];
  const statusFooter = "\n\n*Статус*";

  const text = formatResponsesBotFinalReply({ modelText, citations, causalSources, statusFooter });

  assert.equal(
    text,
    `${renderTelegramCausalAttributions(modelText, causalSources)}${renderTelegramUrlCitations(citations, modelText)}${statusFooter}`,
  );
});
