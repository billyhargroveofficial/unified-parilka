import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ResponsesReasoningEffort } from "../src/openai-responses/contracts.js";
import { allScenarioIds } from "./responses-benchmark/scenarios.js";
import {
  BenchmarkConfigurationError,
  type BenchmarkScenarioId,
  type LiveBenchmarkOptions,
} from "./responses-benchmark/contracts.js";
import { runResponsesVsCodexBenchmark } from "./responses-benchmark/runner.js";

const EFFORTS = new Set<ResponsesReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max"]);

export interface BenchmarkCliOptions extends LiveBenchmarkOptions {
  readonly reportPath?: string;
}

export function parseBenchmarkCli(argv: readonly string[], environment: NodeJS.ProcessEnv): BenchmarkCliOptions {
  let authFile: string | undefined;
  let reportPath: string | undefined;
  let scenarios: readonly BenchmarkScenarioId[] = allScenarioIds();
  let repetitions = 1;
  let effort: ResponsesReasoningEffort = "max";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--auth-file") {
      authFile = requiredValue(value);
      index += 1;
    } else if (flag === "--scenarios") {
      scenarios = parseScenarios(requiredValue(value));
      index += 1;
    } else if (flag === "--repetitions") {
      repetitions = parseRepetitions(requiredValue(value));
      index += 1;
    } else if (flag === "--effort") {
      effort = parseEffort(requiredValue(value));
      index += 1;
    } else if (flag === "--report") {
      reportPath = requiredValue(value);
      index += 1;
    } else {
      throw new BenchmarkConfigurationError("Unknown benchmark argument.");
    }
  }
  if (!authFile) throw new BenchmarkConfigurationError("--auth-file is required.");
  const codexBin = environment.CODEX_BIN;
  if (!codexBin) throw new BenchmarkConfigurationError("CODEX_BIN is required.");
  return { authFile, codexBin, scenarios, repetitions, effort, ...(reportPath === undefined ? {} : { reportPath }) };
}

export async function main(argv = process.argv.slice(2), environment = process.env): Promise<void> {
  const options = parseBenchmarkCli(argv, environment);
  const report = await runResponsesVsCodexBenchmark(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.reportPath !== undefined) await writeFile(options.reportPath, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(json);
}

function parseScenarios(value: string): readonly BenchmarkScenarioId[] {
  const selected = value.split(",").filter(Boolean);
  if (selected.length === 0 || selected.some((item) => !allScenarioIds().includes(item as BenchmarkScenarioId))) {
    throw new BenchmarkConfigurationError("--scenarios must contain known benchmark scenario names.");
  }
  return [...new Set(selected)] as BenchmarkScenarioId[];
}

function parseRepetitions(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new BenchmarkConfigurationError("--repetitions must be an integer from 1 to 10.");
  }
  return parsed;
}

function parseEffort(value: string): ResponsesReasoningEffort {
  if (!EFFORTS.has(value as ResponsesReasoningEffort)) {
    throw new BenchmarkConfigurationError("--effort must be a supported reasoning effort.");
  }
  return value as ResponsesReasoningEffort;
}

function requiredValue(value: string | undefined): string {
  if (!value) throw new BenchmarkConfigurationError("Benchmark option requires a value.");
  return value;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.exitCode = 2; });
}
