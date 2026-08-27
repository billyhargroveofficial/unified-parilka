import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { BenchmarkArm, BenchmarkMethodology, BenchmarkReport, LiveBenchmarkOptions } from "./contracts.js";
import { BENCHMARK_MODEL, BENCHMARK_SERVICE_TIER, BENCHMARK_TIMEOUT_MS, BenchmarkConfigurationError } from "./contracts.js";
import { runDirectResponsesArm } from "./direct.js";
import { nativeCodexVersion, runNativeCodexArm } from "./native.js";
import { scenarioById } from "./scenarios.js";

export function assertLiveBenchmarkOptIn(environment: NodeJS.ProcessEnv): void {
  if (environment.PARILKA_LIVE_BENCHMARK !== "1") {
    throw new BenchmarkConfigurationError("Live benchmark is disabled; set PARILKA_LIVE_BENCHMARK=1.");
  }
}

/** Auth is explicit and must be a normal auth.json file; no default is used. */
export async function assertLiveBenchmarkFiles(options: Pick<LiveBenchmarkOptions, "authFile" | "codexBin">): Promise<void> {
  if (!isAbsolute(options.authFile) || basename(options.authFile) !== "auth.json") {
    throw new BenchmarkConfigurationError("An explicit absolute auth.json file is required.");
  }
  if (!isAbsolute(options.codexBin)) {
    throw new BenchmarkConfigurationError("CODEX_BIN must be an explicit absolute executable path.");
  }
  try {
    const auth = await lstat(options.authFile);
    const currentUid = process.getuid?.();
    if (!auth.isFile() || auth.isSymbolicLink() || (auth.mode & 0o777) !== 0o600 ||
      (currentUid !== undefined && auth.uid !== currentUid)) throw new Error("invalid");
    await access(options.authFile, constants.R_OK);
    const codex = await lstat(options.codexBin);
    if (!codex.isFile() || codex.isSymbolicLink()) throw new Error("invalid");
    await access(options.codexBin, constants.X_OK);
  } catch {
    throw new BenchmarkConfigurationError("The explicit benchmark auth file or CODEX_BIN is unavailable.");
  }
}

export async function runResponsesVsCodexBenchmark(options: LiveBenchmarkOptions): Promise<BenchmarkReport> {
  assertLiveBenchmarkOptIn(process.env);
  await assertLiveBenchmarkFiles(options);
  const nativeCliVersion = await nativeCodexVersion(options.codexBin, options.authFile);
  const runs = [];
  for (const scenarioId of options.scenarios) {
    const scenario = scenarioById(scenarioId);
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      const order = benchmarkArmOrder(repetition);
      let directResponses;
      let nativeCodex;
      for (const arm of order) {
        if (arm === "direct_responses") directResponses = await runDirectResponsesArm(options, scenario);
        else nativeCodex = await runNativeCodexArm(options, scenario);
      }
      runs.push({ scenario: scenario.id, repetition, order, directResponses: directResponses!, nativeCodex: nativeCodex! });
    }
  }
  return {
    schemaVersion: 1,
    model: BENCHMARK_MODEL,
    serviceTier: BENCHMARK_SERVICE_TIER,
    effort: options.effort,
    timeoutMs: BENCHMARK_TIMEOUT_MS,
    scenarios: options.scenarios,
    repetitions: options.repetitions,
    methodology: benchmarkMethodology(nativeCliVersion),
    runs,
  };
}

export function benchmarkMethodology(nativeCliVersion?: string): BenchmarkMethodology {
  return {
    directArm: "fresh_minimal_direct_responses_transport_client_per_arm_no_telegram",
    nativeArm: "fresh_codex_exec_process_and_cwd_per_arm",
    connectionMode: "fresh_direct_transport_client_per_arm_vs_native_fresh_process",
    armOrder: "alternating_fresh_logical_executions_distribution_only",
    nativeActionFidelity: "limited_cli_jsonl_omits_open_find_semantics",
    ...(nativeCliVersion === undefined ? {} : { nativeCliVersion }),
  };
}

export function benchmarkArmOrder(repetition: number): readonly BenchmarkArm[] {
  return repetition % 2 === 1
    ? ["direct_responses", "native_codex"]
    : ["native_codex", "direct_responses"];
}
