import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectWebLifecycle, directRequest, runDirectResponsesArm } from "../scripts/responses-benchmark/direct.js";
import { nativeCodexArgs, nativeCodexEnvironment, numericCodexVersion } from "../scripts/responses-benchmark/native.js";
import { acceptedOutcome } from "../scripts/responses-benchmark/acceptance.js";
import { assertLiveBenchmarkFiles, assertLiveBenchmarkOptIn, benchmarkArmOrder } from "../scripts/responses-benchmark/runner.js";
import { scenarioById } from "../scripts/responses-benchmark/scenarios.js";
import { BoundedJsonlObserver, nativeTimingKind, nativeTimingObservation, TimingRecorder } from "../scripts/responses-benchmark/timing.js";
import { BenchmarkConfigurationError } from "../scripts/responses-benchmark/contracts.js";
import { parseBenchmarkCli } from "../scripts/benchmark-responses-vs-codex.js";

test("benchmark CLI requires opt-in, explicit auth, and CODEX_BIN", () => {
  assert.throws(() => assertLiveBenchmarkOptIn({}), BenchmarkConfigurationError);
  assert.doesNotThrow(() => assertLiveBenchmarkOptIn({ PARILKA_LIVE_BENCHMARK: "1" }));
  assert.throws(() => parseBenchmarkCli([], { CODEX_BIN: "/opt/codex" }), /auth-file/u);
  assert.throws(() => parseBenchmarkCli(["--auth-file", "/tmp/auth.json"], {}), /CODEX_BIN/u);
  assert.deepEqual(parseBenchmarkCli([
    "--auth-file", "/tmp/auth.json", "--scenarios", "web,research,web", "--repetitions", "2", "--effort", "max",
  ], { CODEX_BIN: "/opt/codex" }), {
    authFile: "/tmp/auth.json", codexBin: "/opt/codex", scenarios: ["web", "research"], repetitions: 2, effort: "max",
  });
});

test("native command is headless, read-only, ephemeral, and never carries the prompt", () => {
  const args = nativeCodexArgs("max", "/tmp/empty");
  assert.deepEqual(args, [
    "--search", "-a", "never", "-s", "read-only", "-C", "/tmp/empty", "-m", "gpt-5.6-luna",
    "-c", 'model_reasoning_effort="max"', "-c", 'service_tier="priority"', "exec", "--ephemeral", "--json",
    "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
  ]);
  assert.equal(args.some((argument) => argument.includes("HTTP 404")), false);
  assert.equal(numericCodexVersion("codex-cli 0.150.1"), "0.150.1");
  assert.equal(numericCodexVersion("not a version"), undefined);
  assert.deepEqual(nativeCodexEnvironment("/safe/auth.json", {
    HOME: "/home/test", PATH: "/bin", LANG: "C", LC_ALL: "C", TZ: "UTC", LEAK: "no",
  }), { CODEX_HOME: "/safe", HOME: "/home/test", PATH: "/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" });
});

test("native observer only emits a strict timing allowlist and bounds untrusted output", () => {
  assert.equal(nativeTimingKind('{"type":"turn.started","item":{"id":"secret-id"}}'), "native_turn_started");
  assert.equal(nativeTimingKind('{"type":"item.updated","text":"do not retain"}'), undefined);
  assert.deepEqual(nativeTimingObservation('{"type":"item.completed","item":{"type":"web_search","id":"secret-id","action":{"type":"open_page","url":"https://never.report"}},"usage":{"input_tokens":10,"cached_input_tokens":2,"cache_write_input_tokens":7,"output_tokens":3,"reasoning_output_tokens":1}}'), {
    kind: "native_item_completed", itemCategory: "web_search", webAction: "open_page",
  });
  assert.deepEqual(nativeTimingObservation('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"cache_write_input_tokens":7,"output_tokens":3,"reasoning_output_tokens":1}}'), {
    kind: "native_turn_completed",
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 },
  });
  assert.equal(nativeTimingObservation('{"type":"turn.failed"}')?.kind, "native_turn_failed");
  assert.equal(nativeTimingObservation('{"type":"item.completed","item":{"type":"web_search","action":{"type":"open"}}}')?.webAction, "open_page");
  assert.equal(nativeTimingObservation('{"type":"item.completed","item":{"type":"web_search","action":{"type":"find"}}}')?.webAction, "find_in_page");
  assert.equal(nativeTimingKind("not json"), undefined);
  const events: string[] = [];
  const observer = new BoundedJsonlObserver((observation) => events.push(observation.kind), 32);
  observer.push(Buffer.from('{"type":"thread.started"}\n{"type":"item.completed"}\n'));
  observer.push(Buffer.from("x".repeat(64)));
  observer.push(Buffer.from("\n{\"type\":\"turn.completed\"}\n"));
  observer.push(Buffer.alloc(1_000_000, 120));
  observer.push(Buffer.from("\n{\"type\":\"turn.failed\"}\n"));
  observer.finish();
  assert.deepEqual(events, ["native_thread_started", "native_item_completed", "native_turn_completed", "native_turn_failed"]);
});

test("direct arm registers no local functions and reports only timing plus count", async () => {
  const timing = new TimingRecorder();
  const lifecycle = new DirectWebLifecycle();
  const request = directRequest("max", scenarioById("web"), timing, (event) => lifecycle.observe(event));
  assert.deepEqual(request.localFunctions, []);
  assert.equal(request.hostedWebSearchPolicy, "required_first_leg");
  assert.equal(scenarioById("fetch").hostedWebPolicy, "required_first_leg");
  await request.progress?.onProgress({ type: "thinking_started", callId: "never-reported" });
  await request.progress?.onProgress({ type: "hosted_web_started", callId: "never-reported", action: "search" });
  await request.progress?.onProgress({ type: "hosted_web_action", callId: "never-reported", action: "open_page" });
  await request.progress?.onProgress({ type: "hosted_web_completed", callId: "never-reported", ok: true });
  await request.progress?.onProgress({ type: "hosted_web_completed", callId: "never-reported", ok: true });
  assert.deepEqual(lifecycle.webActions(1), { open_page: 1 });
  const observed: unknown[] = [];
  const report = await runDirectResponsesArm({ authFile: "/tmp/auth.json", effort: "max" }, scenarioById("ordinary"), {
    async run(input) {
      observed.push(input);
      return {
        hostedWebCalls: 0,
        usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 },
      } as never;
    },
  });
  assert.equal(observed.length, 1);
  assert.deepEqual(report.events.map((event) => event.kind), ["started", "completed"]);
  assert.equal(report.hostedWebCalls, 0);
  assert.deepEqual(report.usage, { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 });
  assert.equal(report.usageScope, "final_leg");
  assert.equal(report.droppedTimingEvents, 0);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("auth.json"), false);
  assert.equal(serialized.includes("HTTP 404"), false);
  assert.equal(serialized.includes("never-reported"), false);
});

test("timing records at most 128 events and exposes only a dropped count", () => {
  const timing = new TimingRecorder();
  for (let index = 0; index < 130; index += 1) timing.event("thinking_started");
  assert.equal(timing.events().length, 128);
  assert.equal(timing.droppedEvents(), 2);
});

test("scenario acceptance distinguishes invalid evidence from native action uncertainty", () => {
  const report = (hostedWebCalls: number, webActions: Record<string, number>, actionFidelity: "exact" | "limited" = "exact") => ({
    outcome: "completed" as const, durationMs: 1, hostedWebCalls, webActions, actionFidelity, events: [], droppedTimingEvents: 0,
  });
  assert.equal(acceptedOutcome(scenarioById("web"), "direct_responses", report(1, { search: 1 })), "completed");
  assert.equal(acceptedOutcome(scenarioById("fetch"), "direct_responses", report(2, { search: 1, open_page: 1 })), "completed");
  assert.equal(acceptedOutcome(scenarioById("fetch"), "native_codex", report(2, { search: 1, other: 1 }, "limited")), "unverifiable");
  assert.equal(acceptedOutcome(scenarioById("research"), "direct_responses", report(4, { search: 3, find_in_page: 1 })), "completed");
  assert.equal(acceptedOutcome(scenarioById("research"), "native_codex", report(4, { search: 1, other: 3 }, "limited")), "unverifiable");
  assert.equal(acceptedOutcome(scenarioById("research"), "direct_responses", report(4, { search: 4 })), "invalid");
  assert.equal(acceptedOutcome(scenarioById("ordinary"), "native_codex", {
    ...report(0, {}, "limited"), itemCategories: { command_execution: 1 },
  }), "invalid");
});

test("runner alternates AB and BA orders and rejects insecure auth modes", async () => {
  assert.deepEqual(benchmarkArmOrder(1), ["direct_responses", "native_codex"]);
  assert.deepEqual(benchmarkArmOrder(2), ["native_codex", "direct_responses"]);
  const directory = await mkdtemp(join(tmpdir(), "parilka-benchmark-test-"));
  const authFile = join(directory, "auth.json");
  const codexBin = join(directory, "codex");
  try {
    await writeFile(authFile, "{}", { mode: 0o600 });
    await writeFile(codexBin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await assertLiveBenchmarkFiles({ authFile, codexBin });
    await chmod(authFile, 0o640);
    await assert.rejects(assertLiveBenchmarkFiles({ authFile, codexBin }), BenchmarkConfigurationError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
