import assert from "node:assert/strict";
import { test } from "node:test";
import { BotApiLongPoller, BotUpdateProcessor } from "../src/bot/runtime.js";
import { TurnCoordinator } from "../src/bot/turn-coordinator.js";
import { BOT_ID, BOT_USERNAME, TELEGRAM_OPTIONS, addressedUpdate, makeStore, pollingApi } from "./support/bot-runtime.js";

test("long poller advances offset only after durable acknowledgement and confirms it on stop", async (t) => {
  const store = makeStore(t); const processor = new BotUpdateProcessor({ store, coordinator: new TurnCoordinator({ maxActiveTurns: 1 }), workNotifier: { notify() {} }, telegram: TELEGRAM_OPTIONS, now: () => 1_000 });
  const offsets: Array<number | undefined> = []; let calls = 0; let poller!: BotApiLongPoller;
  poller = new BotApiLongPoller({ api: pollingApi(async (options) => { offsets.push(options.offset); calls += 1; if (calls === 1) return [addressedUpdate(300, 700)]; if (calls === 2) poller.requestStop(); return []; }), processor, expectedBotId: BOT_ID, expectedBotUsername: BOT_USERNAME, sleep: async () => {} });
  await poller.run();
  assert.deepEqual(offsets, [undefined, 301, 301]);
  assert.equal(poller.nextOffset, 301);
});

test("durable workers become ready after identity setup, before the first long poll", async (t) => {
  const store = makeStore(t);
  let ready = false;
  let readyCalls = 0;
  let poller!: BotApiLongPoller;
  poller = new BotApiLongPoller({
    api: pollingApi(async () => {
      assert.equal(ready, true);
      poller.requestStop();
      return [];
    }),
    expectedBotId: BOT_ID,
    expectedBotUsername: BOT_USERNAME,
    processor: new BotUpdateProcessor({
      store,
      coordinator: new TurnCoordinator({ maxActiveTurns: 1 }),
      workNotifier: { notify() {} },
      telegram: TELEGRAM_OPTIONS,
    }),
  });
  await poller.run(undefined, () => {
    ready = true;
    readyCalls += 1;
  });
  assert.equal(readyCalls, 1);
});
