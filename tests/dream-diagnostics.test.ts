import assert from "node:assert/strict";
import { test } from "node:test";
import { safeDreamErrorCode } from "../src/dream/diagnostics.js";
import {
  DREAM_CHAT_ID,
  DREAM_YESTERDAY,
  capturingDreamLogger,
  dreamFakeTextRunner,
  dreamFixtureStore,
  dreamNow,
  makeDreamConsolidator,
  seedDreamInteraction,
  seedDreamTwoBatches,
} from "./support/dream.js";
import { runDreamPass } from "../src/digest-cli/dream-pass.js";
import { createLogger } from "../src/observability/logger.js";
import { Writable } from "node:stream";

test("safeDreamErrorCode prefers ETIMEDOUT over nested AbortError DOM code 20", () => {
  // Production wraps AbortSignal abort (DOMException AbortError, numeric code 20).
  const abort = Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
    code: 20,
  });
  const timedOut = Object.assign(
    new Error("Dream review candidate timed out.", { cause: abort }),
    { code: "ETIMEDOUT" },
  );
  const routing = routedError("transport", timedOut);
  assert.equal(
    safeDreamErrorCode(routing),
    "candidates_exhausted:transport:ETIMEDOUT",
  );
  assert.ok(!safeDreamErrorCode(routing).endsWith(":20"));
});

test("safeDreamErrorCode prefers outer ETIMEDOUT over nested ABORT_ERR", () => {
  const abort = Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
  const timedOut = Object.assign(
    new Error("Dream review candidate timed out.", { cause: abort }),
    { code: "ETIMEDOUT" },
  );
  const routing = routedError("transport", timedOut);
  assert.equal(
    safeDreamErrorCode(routing),
    "candidates_exhausted:transport:ETIMEDOUT",
  );
  assert.ok(!safeDreamErrorCode(routing).includes("ABORT_ERR"));
});

test("safeDreamErrorCode keeps invalid_output shortening diagnostic", () => {
  const routing = routedError(
    "invalid_output",
    Object.assign(new Error("still too large"), {
      name: "BotAgentProtocolError",
      code: "shortening_output_too_large",
      modelFallback: true,
    }),
  );
  assert.equal(
    safeDreamErrorCode(routing),
    "candidates_exhausted:invalid_output:shortening_output_too_large",
  );
});

test("safeDreamErrorCode falls back to pure numeric only when no semantic code", () => {
  const routing = routedError(
    "transport",
    Object.assign(new Error("aborted"), {
      name: "AbortError",
      code: 20,
    }),
  );
  assert.equal(safeDreamErrorCode(routing), "candidates_exhausted:transport:20");
});

test("dream progress logs success sequence without content leakage", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-obs-");
  const { logger, events } = capturingDreamLogger();
  try {
    seedDreamInteraction(store, {
      day: DREAM_YESTERDAY,
      triggerId: 1,
      answerId: 2,
      answerText: "secret bot answer text must not appear in logs",
    });
    store.upsertChatMemory({
      chatId: DREAM_CHAT_ID,
      memoryText: "secret memory block",
      lastConsolidatedMessageId: 1,
    });

    const result = await makeDreamConsolidator(
      dreamFakeTextRunner({ text: "ok", toolCalls: 2, finishReason: "stop" }),
      {
        logger,
        runReview: async () => ({
          applied: true,
          model: "provider/model",
          providerId: "provider",
          fallbackCount: 0,
          toolCalls: 2,
          finishReason: "stop",
          final: "rebuilt memory",
        }),
      },
    ).run(store, { chatId: DREAM_CHAT_ID });

    assert.equal(result.status, "success");
    // Bootstrap processes 7 days; filter the reviewed day with interactions.
    const dayEvents = events.filter((e) => e.fields.day === DREAM_YESTERDAY);
    assert.deepEqual(
      dayEvents.map((e) => e.event),
      [
        "bot.dream.day_started",
        "bot.dream.batch_started",
        "bot.dream.batch_completed",
        "bot.dream.day_completed",
      ],
    );

    const started = dayEvents[0]!.fields;
    assert.equal(started.chatId, DREAM_CHAT_ID);
    assert.equal(started.day, DREAM_YESTERDAY);
    assert.equal(started.interactionCount, 1);
    assert.equal(started.batchCount, 1);
    assert.equal(started.incompleteCount, 0);

    const batchStarted = dayEvents[1]!.fields;
    assert.equal(batchStarted.batchIndex, 1);
    assert.equal(batchStarted.batchCount, 1);
    assert.equal(typeof batchStarted.inputChars, "number");
    assert.ok((batchStarted.inputChars as number) > 0);
    assert.equal(batchStarted.interactionCount, 1);

    const batchDone = dayEvents[2]!.fields;
    assert.equal(batchDone.batchIndex, 1);
    assert.equal(batchDone.toolCalls, 2);
    assert.equal(batchDone.finalChars, "rebuilt memory".length);
    assert.equal(batchDone.shortened, false);
    assert.equal(batchDone.model, "provider/model");
    assert.equal(batchDone.providerId, "provider");

    const dayDone = dayEvents[3]!.fields;
    assert.equal(dayDone.day, DREAM_YESTERDAY);
    assert.equal(dayDone.interactionCount, 1);
    assert.equal(dayDone.batchCount, 1);
    assert.equal(dayDone.model, "provider/model");
    assert.equal(dayDone.providerId, "provider");

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes("secret"));
    assert.ok(!serialized.includes("rebuilt memory"));
    assert.ok(!serialized.includes("must not appear"));
  } finally {
    cleanup();
  }
});

test("dream progress logs batch failure with safe ETIMEDOUT code", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-obs-fail-");
  const { logger, events } = capturingDreamLogger();
  try {
    seedDreamTwoBatches(store);
    const abort = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
      code: 20,
    });
    const timedOut = Object.assign(
      new Error("Dream review candidate timed out.", { cause: abort }),
      { code: "ETIMEDOUT" },
    );
    const routingError = () => routedError("transport", timedOut);

    let call = 0;
    const result = await makeDreamConsolidator(
      dreamFakeTextRunner({ text: "ok", toolCalls: 0, finishReason: "stop" }),
      {
      maxInputChars: 90_000,
      logger,
      runReview: async () => {
        call += 1;
        if (call === 1) {
          return {
            applied: true,
            model: "provider/model",
            providerId: "provider",
            fallbackCount: 0,
            toolCalls: 0,
            finishReason: "stop",
            final: "batch one memory",
          };
        }
        throw routingError();
      },
    }).run(store, { chatId: DREAM_CHAT_ID });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error, "candidates_exhausted:transport:ETIMEDOUT");
    }

    const dayEvents = events.filter((e) => e.fields.day === DREAM_YESTERDAY);
    const names = dayEvents.map((e) => e.event);
    assert.ok(names.includes("bot.dream.day_started"));
    assert.ok(names.includes("bot.dream.batch_started"));
    assert.ok(names.includes("bot.dream.batch_completed"));
    assert.ok(names.includes("bot.dream.batch_failed"));
    assert.ok(!names.includes("bot.dream.day_completed"));

    const failed = dayEvents.find((e) => e.event === "bot.dream.batch_failed");
    assert.ok(failed);
    assert.equal(failed!.level, "warn");
    assert.equal(failed!.fields.batchIndex, 2);
    assert.equal(failed!.fields.batchCount, 2);
    assert.equal(typeof failed!.fields.inputChars, "number");
    assert.equal(
      failed!.fields.errorCode,
      "candidates_exhausted:transport:ETIMEDOUT",
    );
    assert.equal("error" in failed!.fields, false);
    assert.ok(!JSON.stringify(failed!.fields).includes("batch one memory"));
  } finally {
    cleanup();
  }
});

test("runDreamPass injects logger into DreamConsolidator", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-pass-log-");
  const { logger, events } = capturingDreamLogger();
  try {
    seedDreamInteraction(store, {
      day: DREAM_YESTERDAY,
      triggerId: 1,
      answerId: 2,
    });
    const result = await runDreamPass(
      store,
      {
        chatId: DREAM_CHAT_ID,
        apply: true,
        botId: "100000000",
        modelTotalTimeoutMs: 300_000,
        modelCandidateTimeoutMs: 60_000,
        memoryMaxChars: 2_000,
        now: dreamNow,
      },
      dreamFakeTextRunner({ text: "ok", toolCalls: 0, finishReason: "stop" }),
      logger,
    );
    assert.equal(result.status, "success");
    assert.ok(events.some((e) => e.event === "bot.dream.day_started"));
    assert.ok(events.some((e) => e.event === "bot.dream.day_completed"));
  } finally {
    cleanup();
  }
});

test("runDreamPass without logger stays silent", async () => {
  const { store, cleanup } = dreamFixtureStore("parilka-dream-pass-quiet-");
  try {
    seedDreamInteraction(store, {
      day: DREAM_YESTERDAY,
      triggerId: 1,
      answerId: 2,
    });
    const result = await runDreamPass(
      store,
      {
        chatId: DREAM_CHAT_ID,
        apply: true,
        botId: "100000000",
        modelTotalTimeoutMs: 300_000,
        modelCandidateTimeoutMs: 60_000,
        memoryMaxChars: 2_000,
        now: dreamNow,
      },
      dreamFakeTextRunner({ text: "ok", toolCalls: 0, finishReason: "stop" }),
    );
    assert.equal(result.status, "success");
  } finally {
    cleanup();
  }
});

// Real runDigestCli(..., deps) wiring — the injected logger receiving
// bot.dream.day_started/day_completed through an actual Dream pass on a
// migrated database — is covered in tests/digest-cli-dream.test.ts.

function routedError(reason: string, cause: Error): Error {
  return Object.assign(new Error("Dream run failed.", { cause }), {
    code: "candidates_exhausted",
    attempts: [{ decision: { reason } }],
  });
}

test("createLogger serializes Dream errorCode as a direct machine string", () => {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ service: "cli" }, { destination });
  const machine = "candidates_exhausted:transport:ETIMEDOUT";
  logger.warn({
    event: "bot.dream.batch_failed",
    chatId: DREAM_CHAT_ID,
    day: DREAM_YESTERDAY,
    batchIndex: 3,
    batchCount: 3,
    inputChars: 40_000,
    errorCode: machine,
  });
  // Contrast: field name "error" would become a NonError object via Pino serializer.
  logger.warn({
    event: "bot.dream.batch_failed_contrast",
    error: machine,
  });

  assert.equal(lines.length >= 2, true);
  const good = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(good.event, "bot.dream.batch_failed");
  assert.equal(good.errorCode, machine);
  assert.equal(typeof good.errorCode, "string");
  assert.equal("error" in good, false);
  assert.ok(!JSON.stringify(good).includes("NonError"));
  assert.ok(!JSON.stringify(good).includes("Dream review candidate timed out"));
  assert.ok(!JSON.stringify(good).includes("Provider"));

  const contrast = JSON.parse(lines[1]!) as Record<string, unknown>;
  assert.equal(typeof contrast.error, "object");
  assert.notEqual(contrast.error, machine);
});
