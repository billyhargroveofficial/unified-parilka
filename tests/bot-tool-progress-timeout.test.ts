import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ToolProgressPublisher,
  type ToolProgressBotApiPort,
  type ToolProgressScheduler,
} from "../src/bot/tool-progress.js";

function timedPublisher(
  scheduler: ToolProgressScheduler,
  botApi: ToolProgressBotApiPort,
) {
  const states: Array<{ messageId?: number; state?: string }> = [];
  return {
    publisher: new ToolProgressPublisher({
      turnId: 7,
      workerId: "w1",
      chatId: "-1004242",
      signal: new AbortController().signal,
      botApi,
      store: {
        saveBotTurnProgress(_turnId, _workerId, progress) {
          states.push(progress);
          return true;
        },
        clearBotTurnProgress() { return true; },
      },
      minVisibleMs: 0,
      operationTimeoutMs: 1,
      now: () => 0,
      scheduler,
    }),
    states,
  };
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function manualClock(): { scheduler: ToolProgressScheduler; advance: (ms: number) => void } {
  let nowMs = 0;
  let nextId = 0;
  const timers = new Map<number, { dueAtMs: number; callback: () => void }>();
  return {
    scheduler: {
      setTimeout(callback, delayMs) {
        const id = nextId++;
        timers.set(id, { dueAtMs: nowMs + delayMs, callback });
        return id;
      },
      clearTimeout(handle) { timers.delete(handle as number); },
    },
    advance(ms) {
      nowMs += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.dueAtMs <= nowMs) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test("a never-settling progress send cannot hold finish or create a second bubble", async () => {
  const clock = manualClock();
  const calls: string[] = [];
  const { publisher, states } = timedPublisher(clock.scheduler, {
    async sendMessage() { calls.push("send"); return new Promise(() => {}); },
    async editMessageText() { calls.push("edit"); return { ok: true }; },
    async deleteMessage() { calls.push("delete"); return { ok: true }; },
  });

  publisher.onToolStarted({ toolName: "day_digest", callId: "first" });
  await drain();
  const finish = publisher.finish(new AbortController().signal);
  publisher.onToolStarted({ toolName: "keyword_search", callId: "late" });
  clock.advance(1);
  await finish;

  assert.deepEqual(calls, ["send"]);
  assert.equal(publisher.state, "unknown");
  assert.equal(states.at(-1)?.state, "unknown");
});

test("a never-settling progress edit cannot hold finish and leaves its fence retryable", async () => {
  const clock = manualClock();
  const calls: string[] = [];
  const { publisher, states } = timedPublisher(clock.scheduler, {
    async sendMessage() { calls.push("send"); return { ok: true, messageId: 9 }; },
    async editMessageText() { calls.push("edit"); return new Promise(() => {}); },
    async deleteMessage() { calls.push("delete"); return { ok: true }; },
  });

  publisher.onToolStarted({ toolName: "day_digest", callId: "first" });
  await drain();
  publisher.onToolStarted({ toolName: "keyword_search", callId: "second" });
  await drain();
  const finish = publisher.finish(new AbortController().signal);
  clock.advance(1);
  await finish;

  assert.deepEqual(calls, ["send", "edit", "delete"]);
  assert.equal(publisher.state, "none");
  assert.ok(states.some((state) => state.messageId === 9 && state.state === "unknown"));
});
