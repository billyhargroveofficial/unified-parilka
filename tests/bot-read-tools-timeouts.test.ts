import assert from "node:assert/strict";
import { test } from "node:test";
import { callCacheSearch } from "../src/bot/read-tools/timeouts.js";
import { ReadToolExecutionError } from "../src/bot/read-tools/payload.js";

test("callCacheSearch times out after chatSearchTimeoutMs with retryable timeout", async () => {
  let signalReceived: AbortSignal | undefined;
  const start = Date.now();
  try {
    await callCacheSearch({
      operation(signal) {
        signalReceived = signal;
        // hang forever — never resolves
        return new Promise(() => {});
      },
      timeoutMs: 50,
    });
    assert.fail("expected timeout");
  } catch (error) {
    assert.ok(error instanceof ReadToolExecutionError);
    if (error instanceof ReadToolExecutionError) {
      assert.equal(error.code, "timeout");
      assert.equal(error.retryable, true);
    }
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `timeout should fire quickly, took ${elapsed}ms`);
  assert.ok(signalReceived, "adapter should receive a signal");
  assert.equal(signalReceived?.aborted, true, "adapter signal should be aborted after timeout");
});

test("callCacheSearch propagates external AbortSignal.timeout as timeout", async () => {
  let signalReceived: AbortSignal | undefined;
  const external = AbortSignal.timeout(50);
  try {
    await callCacheSearch({
      operation(signal) {
        signalReceived = signal;
        return new Promise(() => {});
      },
      timeoutMs: 10_000,
      externalSignal: external,
    });
    assert.fail("expected external timeout");
  } catch (error) {
    assert.ok(error instanceof ReadToolExecutionError);
    if (error instanceof ReadToolExecutionError) {
      assert.equal(error.code, "timeout");
      assert.equal(error.retryable, true);
    }
  }
  assert.ok(signalReceived?.aborted, "adapter signal should be aborted");
});

test("callCacheSearch propagates ordinary external abort as aborted (non-retryable)", async () => {
  let signalReceived: AbortSignal | undefined;
  const controller = new AbortController();
  // fire an ordinary abort after a short delay
  setTimeout(() => controller.abort(new Error("caller cancelled")), 50);
  try {
    await callCacheSearch({
      operation(signal) {
        signalReceived = signal;
        return new Promise(() => {});
      },
      timeoutMs: 10_000,
      externalSignal: controller.signal,
    });
    assert.fail("expected abort");
  } catch (error) {
    assert.ok(error instanceof ReadToolExecutionError);
    if (error instanceof ReadToolExecutionError) {
      assert.equal(error.code, "aborted");
      assert.equal(error.retryable, false);
    }
  }
  assert.ok(signalReceived?.aborted, "adapter signal should be aborted");
});

test("callCacheSearch returns the result when operation completes before timeout", async () => {
  const result = await callCacheSearch({
    operation() {
      return [{ messageId: 1, chatId: "c", text: "ok", date: "2026-08-08", senderId: "u1", senderName: undefined }];
    },
    timeoutMs: 500,
  });
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal((result as Array<{ messageId: number }>)[0]!.messageId, 1);
});
