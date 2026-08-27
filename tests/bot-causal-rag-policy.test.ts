import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CausalRagContextBuilder,
  hasHistoryIntent,
  hasTemporalIntent,
  type CausalRagCache,
} from "../src/bot/causal-rag/index.js";
import { MAX_CHAT_SKILLS, type StoredChatSkill, type StoredMessage } from "../src/store.js";

const CHAT = "-100123";

test("history policy stays conservative and a reply is an explicit history signal", () => {
  assert.equal(hasHistoryIntent("как сварить чай?", false), false);
  assert.equal(hasHistoryIntent("что это такое?", false), false);
  assert.equal(hasHistoryIntent("найди свежую документацию", false), false);
  assert.equal(hasHistoryIntent("напомни, что решили", false), true);
  assert.equal(hasHistoryIntent("кто писал про это раньше", false), true);
  assert.equal(hasHistoryIntent("короткий вопрос", true), true);
  assert.equal(hasTemporalIntent("что было вчера?"), true);
  assert.equal(hasTemporalIntent("короткий вопрос"), false);
});

test("builder always emits bounded direct context and starts hybrid search only for history intent", async () => {
  const calls: Array<{ beforeId: number; query: string }> = [];
  const builder = new CausalRagContextBuilder({
    cache: cache({
      async search(params) {
        calls.push({ beforeId: params.beforeId, query: params.query });
        return { messages: [message(2, "старое решение", "Борис")], mode: "hybrid" };
      },
    }),
  });
  const base = {
    chatId: CHAT,
    triggerMessageId: 10,
    context: [message(7, "последняя реплика", "Алиса"), message(10, "trigger", "Иван")],
  };

  const ordinary = await builder.build({ ...base, triggerText: "как дела?" });
  assert.match(ordinary.packet, /последняя реплика/);
  assert.equal(ordinary.historyAttempted, false);
  assert.deepEqual(calls, []);

  const historical = await builder.build({ ...base, triggerText: "напомни, что решили" });
  assert.equal(historical.historyAttempted, true);
  assert.equal(historical.historyDegraded, false);
  assert.deepEqual(calls, [{ beforeId: 10, query: "напомни, что решили" }]);
  assert.match(historical.packet, /старое решение/);
  assert.match(historical.packet, /〔H1〕/);
});

test("a causal reply target and recent context are both injected before deeper retrieval", async () => {
  const builder = new CausalRagContextBuilder({ cache: cache() });
  const result = await builder.build({
    chatId: CHAT,
    triggerMessageId: 10,
    triggerText: "а что насчёт этого?",
    replyTarget: message(4, "реплика, на которую ответили", "Борис"),
    context: [message(8, "последняя обычная реплика", "Алиса")],
  });
  assert.equal(result.historyAttempted, true, "reply enables deeper retrieval");
  assert.match(result.packet, /реплика, на которую ответили/);
  assert.match(result.packet, /последняя обычная реплика/);
  assert.match(result.packet, /〔C1〕/);
  assert.match(result.packet, /〔C2〕/);
});

test("skill index excludes future/null/cross-chat rows before taking its bounded visible slice", async () => {
  let requestedLimit: number | undefined;
  const builder = new CausalRagContextBuilder({
    cache: cache(),
    skillIndex: {
      listChatSkills(_chatId, limit) {
        requestedLimit = limit;
        return [
          skill("future", "must not appear", 12),
          skill("unattributed", "must not appear", undefined),
          { ...skill("other", "must not appear", 1), chatId: "-100other" },
          ...Array.from({ length: 8 }, (_value, index) =>
            skill(`visible-${String(index + 1)}`, `description ${String(index + 1)}`, index + 1)),
          skill("overflow", "must stay outside the eight-entry index", 1),
        ];
      },
    },
  });

  const result = await builder.build({
    chatId: CHAT,
    triggerMessageId: 10,
    triggerText: "как дела?",
    context: [],
  });

  assert.equal(requestedLimit, MAX_CHAT_SKILLS);
  assert.match(result.packet, /Индекс сохранённых навыков чата/u);
  assert.match(result.packet, /visible-1: description 1/u);
  assert.match(result.packet, /visible-8: description 8/u);
  assert.doesNotMatch(result.packet, /future|unattributed|other|overflow/u);
  assert.doesNotMatch(result.packet, /instructions/u);
});

function cache(overrides: Partial<CausalRagCache> = {}): CausalRagCache {
  return {
    async search() {
      return { messages: [], mode: "keyword" };
    },
    getDigests() {
      return { digests: [] };
    },
    ...overrides,
  };
}

function message(messageId: number, text: string, senderName: string): StoredMessage {
  return {
    chatId: CHAT,
    messageId,
    senderId: `sender-${messageId}`,
    senderName,
    date: "2026-08-27T08:00:00.000Z",
    text,
  };
}

function skill(
  name: string,
  description: string,
  sourceMessageId: number | undefined,
): StoredChatSkill {
  return {
    chatId: CHAT,
    key: name,
    name,
    description,
    instructions: "instructions must not be injected",
    ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
