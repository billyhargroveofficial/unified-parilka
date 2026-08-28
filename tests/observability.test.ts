import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { LogLevel } from "telegram/extensions/Logger.js";
import { coordinatorTraceOptions } from "../src/bot-daemon/trace.js";
import type { BotMediaToolsPort } from "../src/bot/media-tools.js";
import type { TelegramMediaTarget } from "../src/bot/media/contracts.js";
import { StderrGramJsLogger } from "../src/gramjs-logger.js";
import { createLogger } from "../src/observability/logger.js";
import {
  providerIdentityUrl,
  redactLogValue,
  redactUrl,
  safeError,
} from "../src/observability/redaction.js";
import {
  candidate,
  makeAgent,
  mockModel,
  request,
  response,
  storedMessage,
  toolCall,
  toolResponse,
} from "./support/ai-agent.js";

test("projects a production coordinator ID into durable numeric correlation", () => {
  const records: Array<Record<string, unknown>> = [];
  const trace = coordinatorTraceOptions({
    info(record) {
      records.push({ ...record });
    },
    warn() {},
    error() {},
  });

  assert.ok("onTrace" in trace);
  trace.onTrace?.({
    event: "turn.started",
    turnId: "42",
    ownerSenderId: "7",
    startWatermark: 0,
  });
  trace.onTrace?.({
    event: "turn.started",
    turnId: "generic-test-id",
    ownerSenderId: "7",
    startWatermark: 1,
  });

  assert.deepEqual(records, [
    {
      event: "turn.started",
      turnId: 42,
      coordinatorTurnId: "42",
      ownerSenderId: "7",
      startWatermark: 0,
    },
    {
      event: "turn.started",
      turnId: "generic-test-id",
      ownerSenderId: "7",
      startWatermark: 1,
    },
  ]);
});

test("emits paired metadata-only tool lifecycle records", async () => {
  const model = mockModel([
    toolResponse([
      toolCall("private-tool-call", "rag_bm25_search", {
        query: "PRIVATE_TOOL_QUERY",
        limit: 1,
      }),
    ]),
    response([{ type: "text", text: "готово" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);

  await fixture.agent.run(request());

  const started = fixture.logs.find(
    (record) => record.event === "bot.agent.tool_started",
  );
  const completed = fixture.logs.find(
    (record) => record.event === "bot.agent.tool",
  );
  assert.deepEqual(started, {
    event: "bot.agent.tool_started",
    turnId: 1,
    updateId: 2,
    candidate: "primary:test",
    attempt: 1,
    tool: "rag_bm25_search",
    kind: "read",
    sequence: 1,
  });
  assert.ok(completed);
  for (const field of [
    "turnId",
    "updateId",
    "candidate",
    "attempt",
    "tool",
    "kind",
    "sequence",
  ] as const) {
    assert.equal(completed[field], started?.[field]);
  }
  assert.equal(Number.isInteger(completed.sequence), true);
  assert.ok(
    Number(completed.sequence) >= 1 &&
      Number(completed.sequence) <= Number.MAX_SAFE_INTEGER,
  );
  assert.equal(completed.ok, true);
  assert.equal(completed.status, "empty");
  assert.equal("errorCode" in completed, false);
  assert.equal(typeof completed.durationMs, "number");

  const lifecycle = JSON.stringify([started, completed]);
  for (const marker of [
    "private-tool-call",
    "PRIVATE_TOOL_QUERY",
    "toolCallId",
    "callId",
    "input",
    "output",
    "query",
  ]) {
    assert.equal(lifecycle.includes(marker), false, `must not log ${marker}`);
  }
});

test("aligns local audio lifecycle records without logging its transcript", async () => {
  const target: TelegramMediaTarget = {
    kind: "voice",
    fileId: "PRIVATE_AUDIO_FILE_ID",
    mediaType: "audio/ogg",
    source: "trigger",
    message: storedMessage(100, "[голосовое]", "42", "Коля"),
  };
  const mediaTools: BotMediaToolsPort = {
    findPhoto: () => undefined,
    findAudio: () => target,
    async resolveVision() {
      throw new Error("vision must not run for direct audio");
    },
    async transcribeAudio() {
      throw new Error("model audio path must not run for direct audio");
    },
    async transcribeAudioDirect() {
      return {
        ok: true,
        source: "trigger",
        transcript: "PRIVATE_AUDIO_TRANSCRIPT",
      };
    },
  };
  const fixture = makeAgent(
    [candidate("primary:test", mockModel([]))],
    { mediaTools },
  );

  await fixture.agent.run(request({
    trigger: storedMessage(100, "расшифруй голосовое", "42", "Коля"),
  }));

  const lifecycle = fixture.logs.filter(
    (record) =>
      record.event === "bot.agent.tool_started" ||
      record.event === "bot.agent.tool",
  );
  assert.equal(lifecycle.length, 2, "one local execution has one start/end pair");
  assert.deepEqual(lifecycle[0], {
    event: "bot.agent.tool_started",
    turnId: 1,
    updateId: 2,
    candidate: "local:flov",
    attempt: 1,
    tool: "audio_transcribe",
    kind: "audio",
    sequence: 1,
  });
  assert.ok(lifecycle[1]);
  for (const field of [
    "turnId",
    "updateId",
    "candidate",
    "attempt",
    "tool",
    "kind",
    "sequence",
  ] as const) {
    assert.equal(lifecycle[1][field], lifecycle[0]?.[field]);
  }
  assert.equal(lifecycle[1].ok, true);
  assert.equal(lifecycle[1].status, "done");
  assert.equal(typeof lifecycle[1].durationMs, "number");
  assert.doesNotMatch(
    JSON.stringify(lifecycle),
    /PRIVATE_AUDIO_(?:FILE_ID|TRANSCRIPT)/u,
  );
});

test("redacts nested credentials and credential-bearing URLs", () => {
  const value = redactLogValue({
    apiKey: "sk-live-secret",
    nested: {
      telegram_session: "session-secret",
      endpoint: "https://alice:password@example.test/v1?api_key=abc&model=x#fragment",
    },
  }) as Record<string, unknown>;

  assert.equal(value.apiKey, "[REDACTED]");
  assert.deepEqual(value.nested, {
    telegram_session: "[REDACTED]",
    endpoint: "https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/v1?api_key=%5BREDACTED%5D&model=x",
  });
  assert.equal(JSON.stringify(value).includes("sk-live-secret"), false);
  assert.equal(JSON.stringify(value).includes("session-secret"), false);
  assert.equal(JSON.stringify(value).includes("password"), false);
});

test("provider identity excludes credentials and sensitive query while preserving endpoint identity", () => {
  assert.equal(
    providerIdentityUrl("https://alice:secret@example.test/v1/?region=eu&api_key=one#two"),
    "https://example.test/v1/?region=eu",
  );
});

test("redactUrl preserves harmless query parameters", () => {
  assert.equal(
    redactUrl("https://example.test/v1?model=qwen&token=secret"),
    "https://example.test/v1?model=qwen&token=%5BREDACTED%5D",
  );
});

test("safeError keeps typed operational fields but drops stacks and arbitrary data", () => {
  const error = Object.assign(new Error("provider failed"), {
    code: "ETIMEDOUT",
    category: "provider",
    retryable: true,
    apiKey: "must-not-leak",
  });

  assert.deepEqual(safeError(error), {
    name: "Error",
    message: "provider failed",
    code: "ETIMEDOUT",
    category: "provider",
    retryable: true,
  });
});

test("redacts credentials embedded inside otherwise ordinary error strings", () => {
  const value = redactLogValue(
    "request to https://alice:password@example.test/v1?token=secret failed " +
      "with Bearer abcdefghijklmnopqrstuvwxyz and " +
      "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd",
  );

  assert.equal(typeof value, "string");
  assert.equal(String(value).includes("password"), false);
  assert.equal(String(value).includes("secret"), false);
  assert.equal(
    String(value).includes("abcdefghijklmnopqrstuvwxyz"),
    false,
  );
  assert.equal(
    String(value).includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd"),
    false,
  );
  assert.match(String(value), /\[REDACTED\]/u);
});

test("legacy GramJS logger redacts bounded stderr messages", () => {
  const originalError = console.error;
  let output = "";
  console.error = (...args: unknown[]) => {
    output += args.map((value) => String(value)).join(" ");
  };
  try {
    new StderrGramJsLogger().log(
      LogLevel.ERROR,
      "request https://user:password@example.test/?token=secret failed with Bearer abcdefghijklmnopqrstuvwxyz",
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(output.includes("password"), false);
  assert.equal(output.includes("token=secret"), false);
  assert.equal(output.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(output, /\[REDACTED\]/u);
});

test("logger emits JSON to the supplied stderr-like stream with redaction", () => {
  let output = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const logger = createLogger(
    { service: "bot", commit: "deadbeef" },
    { destination, level: "info" },
  );

  logger.info(
    {
      turnId: "turn-1",
      api_key: "secret",
      config: { session: "session-secret" },
    },
    "turn finished",
  );

  const record = JSON.parse(output.trim()) as Record<string, unknown>;
  assert.equal(record.service, "bot");
  assert.equal(record.commit, "deadbeef");
  assert.equal(record.turnId, "turn-1");
  assert.equal(record.api_key, "[REDACTED]");
  assert.deepEqual(record.config, { session: "[REDACTED]" });
  assert.equal(record.msg, "turn finished");
});

test("redacts camelCase keys and embedded hex32 secrets", () => {
  assert.deepEqual(redactLogValue({ botToken: "secret123" }), {
    botToken: "[REDACTED]",
  });
  assert.deepEqual(redactLogValue({ accessToken: "secret123" }), {
    accessToken: "[REDACTED]",
  });
  assert.deepEqual(redactLogValue({ providerApiKey: "secret123" }), {
    providerApiKey: "[REDACTED]",
  });
  assert.deepEqual(redactLogValue({ api_key: "secret123" }), {
    api_key: "[REDACTED]",
  });
  assert.deepEqual(redactLogValue({ tokenCount: 5 }), {
    tokenCount: 5,
  });
  assert.deepEqual(redactLogValue({ tokenizer: "gpt" }), {
    tokenizer: "gpt",
  });
  assert.deepEqual(redactLogValue({ sessionDuration: 100 }), {
    sessionDuration: 100,
  });
  assert.equal(
    String(redactLogValue("hash = abcdef0123456789abcdef0123456789")).includes(
      "[REDACTED]",
    ),
    true,
  );
});

test("safeError includes sanitized stack for unclassified errors", () => {
  const result = safeError(new TypeError("x"));
  assert.equal(typeof result.stack, "string");
  assert.ok(result.stack?.includes("TypeError"));
});

test("safeError drops stack for classified errors", () => {
  const result = safeError(
    Object.assign(new Error("y"), {
      category: "transport",
      code: "ETIMEDOUT",
    }),
  );
  assert.equal("stack" in result, false);
});

test("safeError sanitizes stack credential-bearing URLs", () => {
  const result = safeError(
    new Error("connect https://user:pass@host.com"),
  );
  assert.ok(result.stack);
  assert.equal(result.stack?.includes("user:pass"), false);
});
