import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT, message, makeFixture } from "./support/bot-worker.js";

test("duplicate update and duplicate trigger reserve exactly one durable turn", (t) => {
  const fixture = makeFixture(t);
  const duplicate = fixture.store.ingestBotUpdate({ updateId: 77, rawJson: "{\"update_id\":77}", chat: CHAT, message: message(1_000, "@bot trigger", "owner"), addressed: true, nowMs: fixture.clock.now });
  const duplicateTrigger = fixture.store.ingestBotUpdate({ updateId: 78, rawJson: "{\"update_id\":78}", chat: CHAT, message: message(1_000, "@bot trigger", "owner"), addressed: true, nowMs: fixture.clock.now });
  assert.equal(duplicate.disposition, "duplicate"); assert.equal(duplicateTrigger.turn?.id, fixture.turnId); assert.equal(fixture.store.queryBotTurns().length, 1);
});

test("sent terminal turn cannot be claimed or mutated again", (t) => {
  const fixture = makeFixture(t); const claimed = fixture.store.claimNextBotTurn({ workerId: "owner", chatId: CHAT.chatId, leaseMs: 1_000, nowMs: fixture.clock.now })!;
  assert.equal(fixture.store.saveBotTurnDraft(claimed.id, "owner", "ответ", fixture.clock.now), true);
  assert.equal(fixture.store.markBotTurnSending(claimed.id, "owner", fixture.clock.now), true);
  assert.equal(fixture.store.markBotTurnSent(claimed.id, 900, fixture.clock.now), true);
  assert.equal(fixture.store.markBotTurnSent(claimed.id, 901, fixture.clock.now), false);
  assert.equal(fixture.store.claimNextBotTurn({ workerId: "other", chatId: CHAT.chatId, leaseMs: 1_000, nowMs: fixture.clock.now + 2_000 }), undefined);
});
