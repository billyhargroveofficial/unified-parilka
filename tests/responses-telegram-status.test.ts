import assert from "node:assert/strict";
import test from "node:test";
import { renderResponsesStatusFooter } from "../src/bot/responses-telegram/status.js";

test("renders the compact native-rich Luna status from actual response usage and weekly quota", () => {
  assert.equal(
    renderResponsesStatusFooter({
      inputTokens: 12_345,
      nowMs: 1_700_000_000_000,
      usage: { secondary: { usedPercent: 29.4, windowSeconds: 604_800, resetAtMs: 1_700_496_800_000 } },
    }),
    "\n\n*GPT-5.6 Luna Fast · ctx 12k/272k ● 7d 29% 5d18h*",
  );
});

test("uses a primary-only seven-day window from the live subscription payload", () => {
  assert.equal(
    renderResponsesStatusFooter({
      nowMs: 1_700_000_000_000,
      usage: { primary: { usedPercent: 31, windowSeconds: 604_800, resetAtMs: 1_700_496_800_000 } },
    }),
    "\n\n*GPT-5.6 Luna Fast · ctx ?/272k ● 7d 31% 5d18h*",
  );
});

test("does not mislabel a known non-weekly window as seven days", () => {
  assert.equal(
    renderResponsesStatusFooter({
      nowMs: 1_700_000_000_000,
      usage: { primary: { usedPercent: 31, windowSeconds: 18_000, resetAtMs: 1_700_003_600_000 } },
    }),
    "\n\n*GPT-5.6 Luna Fast · ctx ?/272k ● 7d —*",
  );
});

test("uses the legacy secondary bucket only when its duration is unavailable", () => {
  assert.equal(
    renderResponsesStatusFooter({
      nowMs: 1_700_000_000_000,
      usage: { secondary: { usedPercent: 29, resetAtMs: 1_700_496_800_000 } },
    }),
    "\n\n*GPT-5.6 Luna Fast · ctx ?/272k ● 7d 29% 5d18h*",
  );
});

test("does not invent unavailable context or subscription data", () => {
  assert.equal(
    renderResponsesStatusFooter({ nowMs: 1_700_000_000_000 }),
    "\n\n*GPT-5.6 Luna Fast · ctx ?/272k ● 7d —*",
  );
});
