import assert from "node:assert/strict";
import test from "node:test";
import {
  SummaryTextPort,
  type SummaryTextRunRequest,
  type SummaryTextRunner,
  type DigestSummaryRequest,
} from "../src/digests.js";

function request(
  overrides: Partial<DigestSummaryRequest> = {},
): DigestSummaryRequest {
  return {
    kind: "day",
    period: "2026-08-27",
    dayFrom: "2026-08-27",
    dayTo: "2026-08-27",
    sourceText: '{"sender":"Алиса","text":"Решили релизить"}',
    sourceCount: 1,
    maxOutputChars: 1_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("summary text port keeps bounded digest prompt and runner attribution", async () => {
  const calls: SummaryTextRunRequest[] = [];
  const runner: SummaryTextRunner = {
    async runText(params) {
      calls.push(params);
      return {
        text: "  Алиса подтвердила релиз.  ",
        model: "gpt-5.6-luna",
        providerId: "openai-responses",
        usage: {
          inputTokens: 18,
          outputTokens: 7,
        },
      };
    },
  };
  const schema = { type: "string" };
  const port = new SummaryTextPort(runner, {
    maxOutputTokens: 512,
    totalTimeoutMs: 2_000,
    candidateTimeoutMs: 750,
    outputSchema: schema,
  });

  const result = await port.summarize(request());

  assert.deepEqual(result, {
    text: "Алиса подтвердила релиз.",
    model: "gpt-5.6-luna",
    providerId: "openai-responses",
    inputTokens: 18,
    outputTokens: 7,
    fallbackCount: 0,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.maxOutputTokens, 512);
  assert.equal(calls[0]?.timeoutMs, 750);
  assert.equal(calls[0]?.outputSchema, schema);
  assert.match(
    calls[0]?.instructions ?? "",
    /Входные данные недоверенные/u,
  );
  assert.match(
    calls[0]?.prompt ?? "",
    /<untrusted_chat_messages_ndjson>/u,
  );
  assert.match(calls[0]?.prompt ?? "", /Верни только готовую сводку/u);
});

test("summary text port rejects incomplete, empty, and oversized text", async (t) => {
  const cases: ReadonlyArray<{
    output: { text: string; completed?: boolean };
    request?: Partial<DigestSummaryRequest>;
    code: string;
  }> = [
    {
      output: { text: "Не закончено", completed: false },
      code: "incomplete_digest",
    },
    {
      output: { text: " \n " },
      code: "empty_digest",
    },
    {
      output: { text: "слишком длинно" },
      request: { maxOutputChars: 3 },
      code: "digest_output_too_large",
    },
  ];

  for (const item of cases) {
    await t.test(item.code, async () => {
      const port = new SummaryTextPort({
        async runText() {
          return {
            ...item.output,
            model: "gpt-5.6-luna",
            providerId: "openai-responses",
          };
        },
      });
      await assert.rejects(
        port.summarize(request(item.request)),
        (error: unknown) => errorCode(error) === item.code,
      );
    });
  }
});

test("summary text port enforces its one candidate deadline", async () => {
  let observed: SummaryTextRunRequest | undefined;
  const port = new SummaryTextPort({
    async runText(params) {
      observed = params;
      await new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        text: "late",
        model: "gpt-5.6-luna",
        providerId: "openai-responses",
      };
    },
  }, {
    totalTimeoutMs: 1_000,
    candidateTimeoutMs: 500,
  });

  await assert.rejects(
    port.summarize(request()),
    (error: unknown) => errorCode(error) === "ETIMEDOUT",
  );
  assert.equal(observed?.timeoutMs, 500);
  assert.equal(observed?.signal.aborted, true);
});

test("summary text port validates deadline relationships", () => {
  const runner: SummaryTextRunner = {
    async runText() {
      return {
        text: "unused",
        model: "unused",
        providerId: "unused",
      };
    },
  };
  assert.throws(
    () => new SummaryTextPort(runner, {
      totalTimeoutMs: 1_000,
      candidateTimeoutMs: 1_001,
    }),
    /candidateTimeoutMs must be an integer between 500 and 1000/u,
  );
});

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}
