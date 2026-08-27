import assert from "node:assert/strict";
import { test } from "node:test";
import { GrammyBotTurnPublisher, type GrammyBotApiPort } from "../src/bot/grammy-publisher.js";
import type { TelegramPublication } from "../src/bot/telegram-publication.js";

const request = (publication: TelegramPublication) => ({ chatId: "-1004242", replyToMessageId: 99, publication, signal: new AbortController().signal });

test("rich publication uses native rich Bot API payload", async () => {
  const calls: unknown[] = [];
  const api: GrammyBotApiPort = { async sendRichMessage(input) { calls.push(input); return { message_id: 701 }; }, async sendMessage() { throw new Error("plain fallback must not run"); } };
  const publishRequest = request({ mode: "rich", markdown: "**привет**", plainText: "привет", maxChunkUtf16: 4_096 });
  const result = await new GrammyBotTurnPublisher(api).publish(publishRequest);
  assert.deepEqual(result, { ok: true, chunksSent: 1, telegramMessageId: 701 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { chatId: "-1004242", richMessage: { markdown: "**привет**", skip_entity_detection: true }, plainText: "привет", options: { reply_parameters: { message_id: 99, allow_sending_without_reply: false } }, signal: publishRequest.signal });
});

test("parser rejection falls back once to lossless plain chunks", async () => {
  const chunks: string[] = [];
  const api: GrammyBotApiPort = { async sendRichMessage() { return { ok: false, error_code: 400, description: "can't parse markdown" }; }, async sendMessage(_chatId, text) { chunks.push(text); return { message_id: 10 + chunks.length }; } };
  const result = await new GrammyBotTurnPublisher(api).publish(request({ mode: "rich", markdown: "bad", plainText: "x".repeat(130), maxChunkUtf16: 64 }));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [64, 64, 2]);
  assert.deepEqual(result, { ok: true, chunksSent: 3, telegramMessageId: 11 });
});
