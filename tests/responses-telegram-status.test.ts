import assert from "node:assert/strict";
import test from "node:test";
import { renderResponsesStatusFooter } from "../src/bot/responses-telegram/status.js";

test("renders the compact native-rich Luna status from actual response usage and weekly quota", () => {
  assert.equal(
    renderResponsesStatusFooter({
      inputTokens: 12_345,
      toolCalls: 3,
      durationMs: 4_832,
      nowMs: 1_700_000_000_000,
      usage: { secondary: { usedPercent: 29.4, windowSeconds: 604_800, resetAtMs: 1_700_496_800_000 } },
    }),
    "\n\n*GPT-5.6 Luna Fast max · ctx 12k/272k · tools 3 · 4.8s ● 7d 29% 5d18h*",
  );
});

test("uses a primary-only seven-day window from the live subscription payload", () => {
  assert.equal(
    renderResponsesStatusFooter({
      toolCalls: 0,
      durationMs: 915,
      nowMs: 1_700_000_000_000,
      usage: { primary: { usedPercent: 31, windowSeconds: 604_800, resetAtMs: 1_700_496_800_000 } },
    }),
    "\n\n*GPT-5.6 Luna Fast max · ctx ?/272k · tools 0 · 915ms ● 7d 31% 5d18h*",
  );
});

test("does not mislabel a known non-weekly window as seven days", () => {
  assert.equal(
    renderResponsesStatusFooter({
      toolCalls: 1,
      durationMs: 72_400,
      nowMs: 1_700_000_000_000,
      usage: { primary: { usedPercent: 31, windowSeconds: 18_000, resetAtMs: 1_700_003_600_000 } },
    }),
    "\n\n*GPT-5.6 Luna Fast max · ctx ?/272k · tools 1 · 1m12s ● 7d —*",
  );
});

test("uses the legacy secondary bucket only when its duration is unavailable", () => {
  assert.equal(
    renderResponsesStatusFooter({
      toolCalls: 2,
      durationMs: 12_200,
      nowMs: 1_700_000_000_000,
      usage: { secondary: { usedPercent: 29, resetAtMs: 1_700_496_800_000 } },
    }),
    "\n\n*GPT-5.6 Luna Fast max · ctx ?/272k · tools 2 · 12s ● 7d 29% 5d18h*",
  );
});

test("does not invent unavailable context or subscription data", () => {
  assert.equal(
    renderResponsesStatusFooter({
      toolCalls: 0,
      durationMs: 0,
      nowMs: 1_700_000_000_000,
    }),
    "\n\n*GPT-5.6 Luna Fast max · ctx ?/272k · tools 0 · 0ms ● 7d —*",
  );
});
