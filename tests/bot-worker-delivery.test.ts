import assert from "node:assert/strict";
import { test } from "node:test";
import type { TelegramPublisherResult } from "../src/bot/worker.js";
import {
  final,
  makeFixture,
  waitUntil,
} from "./support/bot-worker.js";

for (const rejectionCase of [
  {
    name: "definitive retryable Telegram rejection returns turn to failed",
    retryable: true,
    expectedStatus: "failed",
  },
  {
    name: "definitive permanent Telegram rejection dead-letters turn",
    retryable: false,
    expectedStatus: "dead_letter",
  },
] as const) {
  test(rejectionCase.name, async (t) => {
    const fixture = makeFixture(t);
    const worker = fixture.worker({
      agent: async () => final("Ответ для Telegram"),
      publisher: async () => ({
        ok: false,
        chunksSent: 0,
        error: {
          kind: "telegram_rejected",
          code: "BAD_REQUEST",
          retryable: rejectionCase.retryable,
        },
      }),
    });

    const result = await worker.runOnce();

    assert.deepEqual(result, {
      status: "dispatch_rejected",
      turnId: fixture.turnId,
      retryable: rejectionCase.retryable,
    });
    assert.equal(
      fixture.store.getBotTurn(fixture.turnId)?.status,
      rejectionCase.expectedStatus,
    );
  });
}

const ambiguousCases: Array<{
  name: string;
  text: string;
  result?: TelegramPublisherResult;
  throws?: boolean;
}> = [
  {
    name: "network failure before an acknowledgement is lost_ack",
    text: "Короткий ответ",
    result: {
      ok: false,
      chunksSent: 0,
      error: { kind: "network", code: "ECONNRESET" },
    },
  },
  {
    name: "publisher timeout before an acknowledgement is lost_ack",
    text: "Короткий ответ",
    result: {
      ok: false,
      chunksSent: 0,
      error: { kind: "timeout" },
    },
  },
  {
    name: "rejection after one chunk of a multi-chunk answer is lost_ack",
    text: "я".repeat(5_000),
    result: {
      ok: false,
      chunksSent: 1,
      error: {
        kind: "telegram_rejected",
        code: "SECOND_CHUNK_REJECTED",
        retryable: true,
      },
    },
  },
  {
    name: "publisher throw after sending transition is lost_ack",
    text: "Короткий ответ",
    throws: true,
  },
];

for (const ambiguousCase of ambiguousCases) {
  test(ambiguousCase.name, async (t) => {
    const fixture = makeFixture(t);
    const worker = fixture.worker({
      agent: async () => final(ambiguousCase.text),
      publisher: async () => {
        if (ambiguousCase.throws) {
          throw new Error("socket closed after request write");
        }
        return ambiguousCase.result!;
      },
    });

    const result = await worker.runOnce();

    assert.deepEqual(result, {
      status: "lost_ack",
      turnId: fixture.turnId,
    });
    assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "lost_ack");
  });
}

test("publisher deadline aborts a hung request and leaves an unknown-safe row", async (t) => {
  const fixture = makeFixture(t);
  let publishSignal: AbortSignal | undefined;
  const worker = fixture.worker({
    agent: async () => final("Ответ, который мог уйти в сеть"),
    publisher: ({ signal }) => {
      publishSignal = signal;
      return new Promise<TelegramPublisherResult>(() => {});
    },
  });

  const running = worker.runOnce();
  await waitUntil(
    () => fixture.store.getBotTurn(fixture.turnId)?.status === "sending",
  );
  fixture.scheduler.fireTimeouts();

  assert.deepEqual(await running, {
    status: "lost_ack",
    turnId: fixture.turnId,
  });
  assert.equal(publishSignal?.aborted, true);
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.status, "lost_ack");
});
