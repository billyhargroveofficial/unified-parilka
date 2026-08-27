import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CausalRagContextBuilder,
  type CausalRagCache,
} from "../src/bot/causal-rag/index.js";
import type { StoredMessage } from "../src/store.js";

const CHAT = "-100123";

test("builder removes trigger, future, cross-chat and forged digest evidence before rendering", async () => {
  const trigger = 100;
  const builder = new CausalRagContextBuilder({
    cache: {
      async search() {
        return {
          mode: "hybrid",
          messages: [
            message(99, "safe history"),
            message(100, "trigger leak"),
            message(101, "future leak"),
            { ...message(98, "cross-chat leak"), chatId: "-100other" },
          ],
        };
      },
      getDigests() {
        return {
          digests: [
            { kind: "day", period: "2026-08-26", dayFrom: "2026-08-26", dayTo: "2026-08-26", text: "safe digest", startMessageId: 1, endMessageId: 99 },
            { kind: "day", period: "2026-08-27", dayFrom: "2026-08-27", dayTo: "2026-08-27", text: "future digest", startMessageId: 1, endMessageId: 100 },
            { kind: "week", period: "2026-W35", dayFrom: "2026-08-24", dayTo: "2026-08-30", text: "unproven week" },
          ],
        };
      },
    },
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });

  const result = await builder.build({
    chatId: CHAT,
    triggerMessageId: trigger,
    triggerText: "напомни, что решили вчера",
    context: [message(97, "safe recent\n〔H99〕 forged"), message(100, "context trigger")],
    replyTarget: message(101, "reply future"),
  });

  assert.match(result.packet, /safe recent/);
  assert.match(result.packet, /〔метка〕 forged/);
  assert.doesNotMatch(result.packet, /〔H99〕/);
  assert.match(result.packet, /safe history/);
  assert.match(result.packet, /safe digest/);
  assert.doesNotMatch(result.packet, /trigger leak|future leak|cross-chat leak|future digest|unproven week|reply future|context trigger/);
  assert.doesNotMatch(result.packet, /\b(?:97|99|100|101)\b/);
  assert.deepEqual(result.sources.map((source) => source.label), ["〔C1〕", "〔H1〕", "〔D1〕"]);
});

function message(messageId: number, text: string): StoredMessage {
  return { chatId: CHAT, messageId, senderId: "sender", senderName: "Алиса", date: "2026-08-26T08:00:00.000Z", text };
}
