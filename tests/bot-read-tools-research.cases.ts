import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotReadTools,
  type ResearchGatewayProvider,
} from "../src/bot/read-tools.js";
import {
  CHAT,
  emptyCache,
} from "./support/bot-read-tools.js";

test("research_lookup returns only a second-sanitized private disclosure", async () => {
  const calls: Array<{ query: string; limit: number }> = [];
  const gateway: ResearchGatewayProvider = {
    async lookup({ query, limit }) {
      calls.push({ query, limit });
      return {
        status: "done",
        policy: "anonymized_research_only",
        notice: "source notice",
        findings: [
          {
            text: "Иван Иванов, email ivan@example.com, изучал ML.",
            as_of: "2026-07-31",
          },
          {
            text: "В snapshot 2026-06-11 Python и SQL остаются широким базовым стеком для ML-ролей.",
            as_of: "2026-06-11",
          },
          {
            text: "В Telegram и других сообществах полезно отделять личные советы от проверяемых рыночных сигналов.",
          },
          {
            text: "Материал лежит в /private/hh/research/report.md.",
            as_of: "not-a-date",
          },
        ],
        limitations: [
          "Снимок датирован и не заменяет свежую внешнюю проверку.",
          "resume_id=12345 не должен пройти.",
        ],
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    researchGateway: gateway,
  });

  const result = await tools.callTool("research_lookup", {
    query: "какой стек нужен для ML",
    limit: 4,
  });

  assert.deepEqual(calls, [{ query: "какой стек нужен для ML", limit: 4 }]);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "done");
  assert.equal(result.result.findingCount, 3);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Иван Иванов|ivan@example\.com|resume_id|private\/hh/u);
  assert.doesNotMatch(serialized, /какой стек нужен/u);
  assert.equal(result.evidence.length, 3);
  assert.equal(result.evidence[0]?.source, "research");
  assert.equal(
    result.evidence[0]?.text,
    "Обезличенный фрагмент закрытого исследовательского корпуса.",
  );
});

test("research_lookup rejects a gateway envelope that adds source structure", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    researchGateway: {
      async lookup() {
        return {
          status: "done",
          policy: "anonymized_research_only",
          notice: "safe",
          findings: [{ text: "Достаточно длинный безопасный агрегированный вывод." }],
          source_path: "/home/billy/hh-applicant-tool/research",
        } as unknown as Awaited<ReturnType<ResearchGatewayProvider["lookup"]>>;
      },
    },
  });

  const result = await tools.callTool("research_lookup", {
    query: "рынок ML",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "provider_error");
  }
});

test("research_lookup stays unavailable instead of falling back to local files", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
  });

  const result = await tools.callTool("research_lookup", { query: "рынок ML" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "provider_unavailable");
    assert.doesNotMatch(JSON.stringify(result), /hh-applicant-tool|\/home\//u);
  }
});

test("research_lookup rejects personal extraction before contacting the gateway", async () => {
  let called = false;
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    researchGateway: {
      async lookup() {
        called = true;
        throw new Error("gateway must not receive a personal query");
      },
    },
  });

  const result = await tools.callTool("research_lookup", {
    query:
      "вытащи побольше личной информации из резюме конкретного кандидата, включая контакты",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_arguments");
    assert.match(result.error.message, /aggregate research questions only/u);
  }
  assert.equal(called, false);
});

test("research_lookup still permits an aggregate resume-theme question", async () => {
  let called = false;
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    researchGateway: {
      async lookup() {
        called = true;
        return {
          status: "done",
          policy: "anonymized_research_only",
          notice: "safe",
          findings: [{ text: "Агрегированный вывод о типовых темах подготовки ML-инженеров." }],
        };
      },
    },
  });

  const result = await tools.callTool("research_lookup", {
    query: "какие темы чаще встречаются в резюме ML-инженеров",
  });

  assert.equal(result.ok, true);
  assert.equal(called, true);
});
