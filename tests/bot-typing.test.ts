import assert from "node:assert/strict";
import test from "node:test";
import { startTypingHeartbeat } from "../src/bot/typing.js";

class ManualScheduler {
  callback: (() => void) | undefined;

  setInterval(callback: () => void): unknown {
    this.callback = callback;
    return callback;
  }

  clearInterval(handle: unknown): void {
    if (handle === this.callback) this.callback = undefined;
  }

  tick(): void {
    this.callback?.();
  }
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("typing heartbeat sends immediately, repeats, and logs only its first success", async () => {
  const scheduler = new ManualScheduler();
  const actions: string[] = [];
  const telemetry: string[] = [];
  const heartbeat = startTypingHeartbeat({
    port: {
      async sendChatAction(chatId) {
        actions.push(chatId);
      },
    },
    chatId: "-1004242",
    intervalMs: 4_000,
    scheduler,
    signal: new AbortController().signal,
    onFirstSuccess: () => { telemetry.push("sent"); },
    onFirstFailure: (code) => { telemetry.push(`failed:${code}`); },
  });

  await drain();
  scheduler.tick();
  await drain();
  heartbeat.stop();
  scheduler.tick();
  await drain();

  assert.deepEqual(actions, ["-1004242", "-1004242"]);
  assert.deepEqual(telemetry, ["sent"]);
});

test("typing heartbeat reports only its first safe failure code", async () => {
  const scheduler = new ManualScheduler();
  const telemetry: string[] = [];
  const heartbeat = startTypingHeartbeat({
    port: {
      async sendChatAction() {
        throw Object.assign(new Error("never log this message"), {
          code: "TELEGRAM_429",
        });
      },
    },
    chatId: "-1004242",
    intervalMs: 4_000,
    scheduler,
    signal: new AbortController().signal,
    onFirstFailure: (code) => { telemetry.push(code); },
  });

  await drain();
  scheduler.tick();
  await drain();
  heartbeat.stop();

  assert.deepEqual(telemetry, ["TELEGRAM_429"]);
});
