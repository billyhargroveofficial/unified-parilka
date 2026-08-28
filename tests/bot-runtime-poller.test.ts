import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotApiLongPoller,
  BotApiRuntime,
  BotUpdateProcessor,
  BotWorkerPump,
  type BotRuntimeStore,
  type GrammyLongPollingApiPort,
} from "../src/bot/runtime.js";
import { TurnCoordinator } from "../src/bot/turn-coordinator.js";
import type { BotUpdateIngestResult } from "../src/store.js";
import {
  BOT_ID,
  BOT_USERNAME,
  TELEGRAM_OPTIONS,
  addressedUpdate,
  makeStore,
  messageUpdate,
  pollingApi,
  processorFor,
} from "./support/bot-runtime.js";

test("long poll offset advances only after durable processing and is confirmed on stop", async (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });
  const processor = new BotUpdateProcessor({
    store,
    coordinator,
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
  });
  const offsets: Array<number | undefined> = [];
  let poller!: BotApiLongPoller;
  let calls = 0;
  const api: GrammyLongPollingApiPort = {
    async getMe() {
      return {
        id: Number(BOT_ID),
        is_bot: true,
        username: BOT_USERNAME,
      };
    },
    async deleteWebhook(options) {
      assert.deepEqual(options, { drop_pending_updates: false });
      return true;
    },
    async getUpdates(options) {
      offsets.push(options.offset);
      calls += 1;
      if (calls === 1) {
        return [
          addressedUpdate(300, 700),
          messageUpdate(301, 701, { text: "контекст" }),
        ];
      }
      if (calls === 2) {
        poller.requestStop();
      }
      return [];
    },
  };
  poller = new BotApiLongPoller({
    api,
    processor,
    expectedBotId: BOT_ID,
    expectedBotUsername: BOT_USERNAME,
    sleep: async () => {},
  });

  await poller.run();

  assert.deepEqual(offsets, [undefined, 302, 302]);
  assert.equal(store.getBotUpdate(300)?.status, "queued");
  assert.equal(store.getBotUpdate(301)?.status, "skipped");
  assert.equal(store.queryBotTurns().length, 1);
  assert.equal(coordinator.watermark, 2);
  assert.equal(poller.nextOffset, 302);
});

test("migration offset skips only legacy-confirmed updates on the first poll", async () => {
  const offsets: Array<number | undefined> = [];
  let poller!: BotApiLongPoller;
  const processor = new BotUpdateProcessor({
    store: {
      ingestBotUpdate() {
        throw new Error("not expected");
      },
      getBotUpdate() {
        return undefined;
      },
      getBotTurnByTrigger() {
        return undefined;
      },
      recordBotUpdateFailure() {
        throw new Error("not expected");
      },
    },
    coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
  });
  const api = pollingApi(async (options) => {
    offsets.push(options.offset);
    poller.requestStop();
    return [];
  });
  poller = new BotApiLongPoller({
    api,
    processor,
    expectedBotId: BOT_ID,
    expectedBotUsername: BOT_USERNAME,
    initialOffset: 987_654,
  });

  await poller.run();

  assert.deepEqual(offsets, [987_654, 987_654]);
  assert.equal(poller.nextOffset, 987_654);
  assert.throws(
    () =>
      new BotApiLongPoller({
        api,
        processor,
        expectedBotId: BOT_ID,
        expectedBotUsername: BOT_USERNAME,
        initialOffset: Number.MAX_SAFE_INTEGER,
      }),
    /initialOffset/u,
  );
});

test("pinned bot identity is verified before any queued worker can run", async () => {
  let deleteWebhookCalls = 0;
  let pollCalls = 0;
  let workerCalls = 0;
  const processor = new BotUpdateProcessor({
    store: {
      ingestBotUpdate() {
        throw new Error("not expected");
      },
      getBotUpdate() {
        return undefined;
      },
      getBotTurnByTrigger() {
        return undefined;
      },
      recordBotUpdateFailure() {
        throw new Error("not expected");
      },
    },
    coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
  });
  const poller = new BotApiLongPoller({
    api: {
      async getMe() {
        return {
          id: Number(BOT_ID) + 1,
          is_bot: true,
          username: BOT_USERNAME,
        };
      },
      async deleteWebhook() {
        deleteWebhookCalls += 1;
        return true;
      },
      async getUpdates() {
        pollCalls += 1;
        return [];
      },
    },
    processor,
    expectedBotId: BOT_ID,
    expectedBotUsername: BOT_USERNAME,
  });
  const workers = new BotWorkerPump({
    workers: [
      {
        async runOnce() {
          workerCalls += 1;
          return { status: "idle" };
        },
      },
    ],
  });
  const runtime = new BotApiRuntime({
    poller,
    workers,
    shutdownTimeoutMs: 1_000,
  });

  await assert.rejects(runtime.run(), /BOT_IDENTITY_MISMATCH/u);
  assert.equal(deleteWebhookCalls, 0);
  assert.equal(pollCalls, 0);
  assert.equal(workerCalls, 0);
});

test("runtime stops polling first and waits for an in-flight worker probe", async () => {
  let workerFinished = false;
  let workerCalls = 0;
  let pollCalls = 0;
  const processor = new BotUpdateProcessor({
    store: {
      ingestBotUpdate() {
        throw new Error("not expected");
      },
      getBotUpdate() {
        return undefined;
      },
      getBotTurnByTrigger() {
        return undefined;
      },
      recordBotUpdateFailure() {
        throw new Error("not expected");
      },
    },
    coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
  });
  let runtime!: BotApiRuntime;
  const poller = new BotApiLongPoller({
    api: pollingApi(async () => {
      pollCalls += 1;
      if (pollCalls === 2) {
        runtime.requestStop();
      }
      return [];
    }),
    processor,
    expectedBotId: BOT_ID,
    expectedBotUsername: BOT_USERNAME,
  });
  const workers = new BotWorkerPump({
    workers: [
      {
        async runOnce() {
          workerCalls += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          workerFinished = true;
          return { status: "idle" };
        },
      },
    ],
  });
  runtime = new BotApiRuntime({
    poller,
    workers,
    shutdownTimeoutMs: 1_000,
  });

  const result = await runtime.run();

  assert.deepEqual(result, { drained: true, activeWorkers: 0 });
  assert.equal(workerFinished, true);
  assert.equal(workerCalls, 1);
  assert.equal(poller.running, false);
});

test("fatal polling conflict waits in-flight work but does not drain new queued turns", async () => {
  let workerCalls = 0;
  let pollCalls = 0;
  const processor = new BotUpdateProcessor({
    store: {
      ingestBotUpdate() {
        throw new Error("not expected");
      },
      getBotUpdate() {
        return undefined;
      },
      getBotTurnByTrigger() {
        return undefined;
      },
      recordBotUpdateFailure() {
        throw new Error("not expected");
      },
    },
    coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
  });
  const poller = new BotApiLongPoller({
    api: pollingApi(async () => {
      pollCalls += 1;
      if (pollCalls === 1) {
        return [];
      }
      throw { error_code: 409 };
    }),
    processor,
    expectedBotId: BOT_ID,
    expectedBotUsername: BOT_USERNAME,
    sleep: async () => {},
  });
  const workers = new BotWorkerPump({
    workers: [
      {
        async runOnce() {
          workerCalls += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { status: "idle" };
        },
      },
    ],
  });
  const runtime = new BotApiRuntime({
    poller,
    workers,
    shutdownTimeoutMs: 1_000,
  });

  await assert.rejects(runtime.run(), /POLL_FATAL_409/u);
  assert.equal(workerCalls, 1);
});

test("a storage failure is retried without sending a larger offset", async () => {
  let ingestCalls = 0;
  const fakeStore: BotRuntimeStore = {
    getBotUpdate() {
      return undefined;
    },
    getBotTurnByTrigger() {
      return undefined;
    },
    ingestBotUpdate(params): BotUpdateIngestResult {
      ingestCalls += 1;
      if (ingestCalls === 1) {
        throw Object.assign(new Error("private sqlite detail"), {
          code: "SQLITE_BUSY",
        });
      }
      return {
        disposition: "ingested",
        ackUpdateId: params.updateId,
        update: {
          updateId: params.updateId,
          rawJson: params.rawJson,
          status: "skipped",
          addressed: false,
          chatId: params.chat.chatId,
          triggerMessageId: params.message.messageId,
          attempts: 0,
          maxAttempts: 3,
          receivedAtMs: params.nowMs ?? 0,
          updatedAtMs: params.nowMs ?? 0,
          completedAtMs: params.nowMs ?? 0,
        },
      };
    },
    recordBotUpdateFailure() {
      throw new Error("not expected");
    },
  };
  const processor = new BotUpdateProcessor({
    store: fakeStore,
    coordinator: new TurnCoordinator({ maxActiveTurns: 3 }),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
  });
  const offsets: Array<number | undefined> = [];
  let poller!: BotApiLongPoller;
  let calls = 0;
  const update = messageUpdate(400, 800, { text: "ambient" });
  const api = pollingApi(async (options) => {
    offsets.push(options.offset);
    calls += 1;
    if (calls <= 2) {
      return [update];
    }
    if (calls === 3) {
      poller.requestStop();
    }
    return [];
  });
  poller = new BotApiLongPoller({
    api,
    processor,
    expectedBotId: BOT_ID,
    expectedBotUsername: BOT_USERNAME,
    sleep: async () => {},
  });

  await poller.run();

  assert.equal(ingestCalls, 2);
  assert.deepEqual(offsets, [undefined, undefined, 401, 401]);
});

test("deterministically rejected updates dead-letter before they are acknowledged", async (t) => {
  const store = makeStore(t);
  const processor = processorFor(store);
  const offsets: Array<number | undefined> = [];
  let poller!: BotApiLongPoller;
  let calls = 0;
  const wrongChat = messageUpdate(450, 850, {
    chat: { id: -100999, type: "supergroup", title: "not allowed" },
    text: "private wrong-chat text",
  });
  const api = pollingApi(async (options) => {
    offsets.push(options.offset);
    calls += 1;
    if (calls <= 3) {
      return [wrongChat];
    }
    if (calls === 4) {
      poller.requestStop();
    }
    return [];
  });
  poller = new BotApiLongPoller({
    api,
    processor,
    expectedBotId: BOT_ID,
    expectedBotUsername: BOT_USERNAME,
    sleep: async () => {},
  });

  await poller.run();

  const stored = store.getBotUpdate(450);
  assert.equal(stored?.status, "dead_letter");
  assert.equal(stored?.attempts, 3);
  assert.doesNotMatch(stored?.rawJson ?? "", /private wrong-chat text/u);
  assert.deepEqual(offsets, [undefined, undefined, undefined, 451, 451]);
});
