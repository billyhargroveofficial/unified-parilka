import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotUpdateProcessor } from "../src/bot/runtime.js";
import { TurnCoordinator } from "../src/bot/turn-coordinator.js";
import { MessageStore } from "../src/store.js";
import {
  TELEGRAM_OPTIONS,
  addressedUpdate,
  makeStore,
  message,
  messageUpdate,
  processorFor,
  BOT_ID,
  BOT_USERNAME,
} from "./support/bot-runtime.js";

test("processor commits/reserves before ACK, routes messages, and keeps edits out of folds", (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });
  let notifications = 0;
  let nowMs = 1_000;
  const processor = new BotUpdateProcessor({
    store,
    coordinator,
    workNotifier: {
      notify() {
        notifications += 1;
      },
    },
    telegram: TELEGRAM_OPTIONS,
    now: () => nowMs,
  });

  const addressed = processor.process(
    messageUpdate(100, 500, {
      text: "@ParilkaBot привет",
      entities: [
        {
          type: "mention",
          offset: 0,
          length: "@ParilkaBot".length,
        },
      ],
    }),
  );
  nowMs += 100;
  const ambient = processor.process(
    messageUpdate(101, 501, { text: "обычная реплика" }),
  );
  const watermarkBeforeEdit = coordinator.watermark;
  nowMs += 100;
  const edited = processor.process({
    update_id: 102,
    edited_message: message(501, {
      text: "@ParilkaBot отредактировано",
      entities: [
        {
          type: "mention",
          offset: 0,
          length: "@ParilkaBot".length,
        },
      ],
    }),
  });

  assert.deepEqual(addressed, {
    acknowledged: true,
    ackUpdateId: 100,
    disposition: "ingested",
    turnReserved: true,
    routed: true,
  });
  assert.equal(ambient.acknowledged, true);
  assert.equal(ambient.turnReserved, false);
  assert.equal(edited.acknowledged, true);
  assert.equal(edited.turnReserved, false);
  assert.equal(edited.routed, false);
  assert.equal(store.queryBotTurns().length, 1);
  assert.equal(store.getBotUpdate(100)?.status, "queued");
  assert.equal(store.getBotUpdate(102)?.status, "skipped");
  assert.equal(
    store.getMessagesByIds({
      chatId: TELEGRAM_OPTIONS.allowedChatId,
      messageIds: [501],
    })[0]?.text,
    "@ParilkaBot отредактировано",
  );
  assert.equal(coordinator.watermark, watermarkBeforeEdit);
  assert.equal(coordinator.watermark, 2);
  assert.equal(notifications, 1);
});

test("redelivered committed update wakes durable work without routing a duplicate fold", (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });
  let notifications = 0;
  const processor = new BotUpdateProcessor({
    store,
    coordinator,
    workNotifier: {
      notify() {
        notifications += 1;
      },
    },
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
  });
  const update = addressedUpdate(150, 550);

  const first = processor.process(update);
  const watermarkAfterCommit = coordinator.watermark;
  const redelivery = processor.process(update);

  assert.equal(first.disposition, "ingested");
  assert.equal(first.routed, true);
  assert.equal(redelivery.disposition, "duplicate");
  assert.equal(redelivery.turnReserved, true);
  assert.equal(redelivery.routed, false);
  assert.equal(coordinator.watermark, watermarkAfterCommit);
  assert.equal(coordinator.watermark, 1);
  assert.equal(store.queryBotTurns().length, 1);
  assert.equal(notifications, 2);
});

test("five-second per-sender trigger debounce survives process restart", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "parilka-runtime-cooldown-"),
  );
  const dbPath = join(directory, "cache.sqlite");
  try {
    let store = new MessageStore(dbPath);
    let nowMs = 10_000;
    let processor = processorFor(store, () => nowMs);

    const first = processor.process(addressedUpdate(200, 600));
    nowMs = 12_000;
    const throttled = processor.process(
      addressedUpdate(201, 601),
    );

    assert.equal(first.acknowledged && first.turnReserved, true);
    assert.equal(throttled.acknowledged && throttled.turnReserved, false);
    assert.equal(store.getBotUpdate(201)?.addressed, true);
    assert.equal(store.getBotUpdate(201)?.status, "skipped");
    assert.match(store.getBotUpdate(201)?.error ?? "", /cooldown/u);
    assert.equal(store.queryBotTurns().length, 1);
    store.close();

    store = new MessageStore(dbPath);
    nowMs = 15_000;
    processor = processorFor(store, () => nowMs);
    const afterRestart = processor.process(
      addressedUpdate(202, 602),
    );

    assert.equal(afterRestart.acknowledged && afterRestart.turnReserved, true);
    assert.equal(store.queryBotTurns().length, 2);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owner reply-to-bot routes as owner_follow_up, reply to another stays ambient", (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 1 });
  const processor = new BotUpdateProcessor({
    store,
    coordinator,
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
  });

  // Start a turn for the owner (senderId=42)
  coordinator.startTurn({ turnId: "turn-1", ownerSenderId: "42" });

  // Owner replies to bot → should be owner_follow_up
  processor.process({
    update_id: 301,
    message: message(701, {
      from: { id: 42, is_bot: false, username: "alice" },
      text: "да, именно так",
      reply_to_message: {
        message_id: 10,
        from: { id: Number(BOT_ID), is_bot: true, username: BOT_USERNAME },
      },
    }),
  });

  // Another user message → ambient
  processor.process({
    update_id: 302,
    message: message(702, {
      from: { id: 99, is_bot: false, username: "bob" },
      text: "а я что говорил",
    }),
  });

  // Owner replies to another user (not bot) → ambient
  processor.process({
    update_id: 303,
    message: message(703, {
      from: { id: 42, is_bot: false, username: "alice" },
      text: "согласен с бобом",
      reply_to_message: {
        message_id: 11,
        from: { id: 99, is_bot: false, username: "bob" },
      },
    }),
  });

  const fold = (() => {
    const result = coordinator.drainAtBoundary("turn-1", "model");
    assert.equal(result.status, "drained");
    return result.fold;
  })();

  assert.deepEqual(
    fold.messages.map(({ messageId, route }) => [messageId, route]),
    [
      ["-1003179772905:701", "owner_follow_up"],
      ["-1003179772905:702", "ambient"],
      ["-1003179772905:703", "ambient"],
    ],
  );
  assert.equal(fold.ownerFollowUps.length, 1);
  assert.equal(fold.ambient.length, 2);
});

test("owner next message without reply-to-bot stays ambient, does not hijack task", (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 1 });
  const processor = new BotUpdateProcessor({
    store,
    coordinator,
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
  });

  coordinator.startTurn({ turnId: "turn-1", ownerSenderId: "42" });

  // Owner sends an unrelated next message (no reply_to_message) → ambient
  processor.process({
    update_id: 401,
    message: message(801, {
      from: { id: 42, is_bot: false, username: "alice" },
      text: "кстати, совсем забыл спросить про другое",
    }),
  });

  const fold = (() => {
    const result = coordinator.drainAtBoundary("turn-1", "model");
    assert.equal(result.status, "drained");
    return result.fold;
  })();

  assert.deepEqual(
    fold.messages.map(({ messageId, route }) => [messageId, route]),
    [["-1003179772905:801", "ambient"]],
  );
  assert.equal(fold.ownerFollowUps.length, 0);
  // Ambient is preserved, not dropped
  assert.equal(fold.ambient.length, 1);
  assert.equal(fold.ambient[0]?.text, "кстати, совсем забыл спросить про другое");
});
