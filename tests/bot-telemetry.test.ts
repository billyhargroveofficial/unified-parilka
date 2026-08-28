import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TurnUsageAccumulator,
  buildTelemetryFooter,
  type TurnTelemetry,
} from "../src/bot/telemetry.js";

function telemetry(overrides: Partial<TurnTelemetry>): TurnTelemetry {
  return Object.freeze({
    finalModelId: "qwen/qwen3.8-max",
    finalProviderId: "qwen",
    reasoningMode: undefined,
    steps: Object.freeze([]),
    totalInputTokens: undefined,
    totalOutputTokens: undefined,
    totalTokens: undefined,
    contextUsedTokens: undefined,
    contextWindowTokens: undefined,
    toolCalls: 0,
    durationMs: 0,
    incomplete: false,
    ...overrides,
  });
}

test("footer shows last-step occupancy over declared window, not cumulative totals", () => {
  const footer = buildTelemetryFooter(
    telemetry({
      contextUsedTokens: 15_200,
      contextWindowTokens: 1_000_000,
      // Cumulative counters must never leak into the rendered pair.
      totalInputTokens: 87_000,
      totalOutputTokens: 219,
      totalTokens: 87_219,
      toolCalls: 2,
      durationMs: 63_000,
    }),
  );

  assert.equal(
    footer,
    "qwen3.8-max 🧠 · 15.2k/1.0m · 2 tool calls · 1м 3с",
  );
});

test("footer never renders output tokens or an uppercase million suffix", () => {
  const footer = buildTelemetryFooter(
    telemetry({
      contextUsedTokens: 1_000_000,
      contextWindowTokens: 2_500_000,
      totalOutputTokens: 999_999,
    }),
  );

  assert.match(footer, /1\.0m\/2\.5m/u);
  assert.doesNotMatch(footer, /M/u);
  assert.doesNotMatch(footer, /999|out|reasoning|total/u);
});

test("footer renders missing occupancy or window as ?", () => {
  assert.match(
    buildTelemetryFooter(telemetry({})),
    /🧠 · \?\/\? · 0 tool calls/u,
  );
  assert.match(
    buildTelemetryFooter(
      telemetry({ contextWindowTokens: 1_000_000 }),
    ),
    /🧠 · \?\/1\.0m/u,
  );
  assert.match(
    buildTelemetryFooter(telemetry({ contextUsedTokens: 500 })),
    /🧠 · 500\/\?/u,
  );
});

test("multiple steps are not summed for context usage; totals stay internal", () => {
  const acc = new TurnUsageAccumulator();
  acc.recordStep({
    modelId: "m1",
    providerId: "p1",
    inputTokens: 7_000,
    outputTokens: 300,
    totalTokens: 7_300,
  });
  acc.recordStep({
    modelId: "m1",
    providerId: "p1",
    inputTokens: 7_400,
    outputTokens: 250,
    totalTokens: 7_650,
  });
  acc.setFinalModel("m-final", "p-final", 1_000_000);
  acc.setExecutionStats({ toolCalls: 2, durationMs: 3_000 });

  const telemetry = acc.build();

  assert.equal(telemetry.contextUsedTokens, 7_400);
  assert.equal(telemetry.contextWindowTokens, 1_000_000);
  // Aggregate diagnostics remain available but separate.
  assert.equal(telemetry.totalInputTokens, 14_400);
  assert.equal(telemetry.totalOutputTokens, 550);
  assert.equal(telemetry.totalTokens, 14_950);
  assert.equal(telemetry.incomplete, false);
  assert.equal(telemetry.finalModelId, "m-final");
  assert.equal(telemetry.finalProviderId, "p-final");
  assert.equal(telemetry.toolCalls, 2);
  assert.equal(telemetry.durationMs, 3_000);
});

test("a smaller last step after compaction lowers the displayed usage", () => {
  const acc = new TurnUsageAccumulator();
  acc.recordStep({
    modelId: "m1",
    providerId: "p1",
    inputTokens: 812_000,
    outputTokens: 1_200,
    totalTokens: 813_200,
  });
  acc.recordStep({
    modelId: "m1",
    providerId: "p1",
    inputTokens: 15_200,
    outputTokens: 400,
    totalTokens: 15_600,
  });
  acc.setFinalModel("m1", "p1", 1_000_000);
  acc.setExecutionStats({ toolCalls: 1, durationMs: 1_000 });

  const footer = buildTelemetryFooter(acc.build());

  assert.match(footer, /15\.2k\/1\.0m/u);
  assert.doesNotMatch(footer, /812|827/u);
});

test("accumulator marks incomplete when usage missing and keeps unknown occupancy", () => {
  const acc = new TurnUsageAccumulator();
  acc.recordStep({
    modelId: "m1",
    providerId: "p1",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
  acc.recordStep({
    modelId: "m2",
    providerId: "p2",
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: 25,
  });
  acc.setFinalModel("m-final", "p-final");

  const telemetry = acc.build();

  assert.equal(telemetry.incomplete, true);
  assert.equal(telemetry.contextUsedTokens, undefined);
  assert.equal(telemetry.contextWindowTokens, undefined);
  assert.equal(telemetry.totalInputTokens, 10);
  assert.equal(telemetry.totalOutputTokens, 5);
  assert.equal(telemetry.totalTokens, 40);
});

test("final context window rejects non-positive or unsafe declarations", () => {
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const acc = new TurnUsageAccumulator();
    acc.setFinalModel("m", "p", invalid);
    assert.equal(acc.build().contextWindowTokens, undefined, String(invalid));
  }

  const valid = new TurnUsageAccumulator();
  valid.setFinalModel("m", "p", 1_000_000);
  assert.equal(valid.build().contextWindowTokens, 1_000_000);
});
