import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type {
  BenchmarkArmReport,
  BenchmarkItemCategory,
  BenchmarkScenario,
  BenchmarkUsage,
  BenchmarkWebAction,
  LiveBenchmarkOptions,
} from "./contracts.js";
import { BENCHMARK_MODEL, BENCHMARK_SERVICE_TIER, BENCHMARK_TIMEOUT_MS } from "./contracts.js";
import { acceptedOutcome } from "./acceptance.js";
import { BoundedJsonlObserver, TimingRecorder } from "./timing.js";

const VERSION_TIMEOUT_MS = 5_000;
const MAX_VERSION_CHARS = 128;

export function nativeCodexArgs(effort: LiveBenchmarkOptions["effort"], emptyCwd: string): readonly string[] {
  return [
    "--search",
    "-a", "never",
    "-s", "read-only",
    "-C", emptyCwd,
    "-m", BENCHMARK_MODEL,
    "-c", `model_reasoning_effort=${JSON.stringify(effort)}`,
    "-c", `service_tier=${JSON.stringify(BENCHMARK_SERVICE_TIER)}`,
    "exec",
    "--ephemeral",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
  ];
}

/** Pass no ambient credentials or configuration through to native Codex. */
export function nativeCodexEnvironment(authFile: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { CODEX_HOME: dirname(authFile) };
  for (const name of ["HOME", "PATH", "LANG", "LC_ALL", "TZ"] as const) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** Return only a numeric CLI version; raw child output never leaves this scope. */
export async function nativeCodexVersion(
  codexBin: string,
  authFile: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const settle = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(codexBin, ["--version"], {
      env: nativeCodexEnvironment(authFile),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      settle(undefined);
    }, VERSION_TIMEOUT_MS);
    watchdog.unref();
    child.stdout.on("data", (chunk: Uint8Array) => {
      if (text.length >= MAX_VERSION_CHARS) return;
      text += new TextDecoder().decode(chunk.subarray(0, MAX_VERSION_CHARS - text.length));
    });
    child.stderr.on("data", () => {});
    child.once("error", () => {
      clearTimeout(watchdog);
      settle(undefined);
    });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      settle(code === 0 ? numericCodexVersion(text) : undefined);
    });
  });
}

export function numericCodexVersion(value: string): string | undefined {
  return /\b\d+(?:\.\d+){1,3}\b/u.exec(value)?.[0];
}

/**
 * The CLI receives the fixture prompt over stdin, never argv. Its stdout is
 * reduced immediately to allowlisted timing types; stderr is drained only.
 */
export async function runNativeCodexArm(
  options: Pick<LiveBenchmarkOptions, "authFile" | "codexBin" | "effort">,
  scenario: BenchmarkScenario,
): Promise<BenchmarkArmReport> {
  const emptyCwd = await mkdtemp(join(tmpdir(), "parilka-responses-benchmark-"));
  try {
    return await runInEmptyCwd(options, scenario, emptyCwd);
  } finally {
    await rm(emptyCwd, { recursive: true, force: true });
  }
}

function runInEmptyCwd(
  options: Pick<LiveBenchmarkOptions, "authFile" | "codexBin" | "effort">,
  scenario: BenchmarkScenario,
  emptyCwd: string,
): Promise<BenchmarkArmReport> {
  return new Promise((resolve) => {
    const timing = new TimingRecorder();
    timing.event("started");
    const child = spawn(options.codexBin, nativeCodexArgs(options.effort, emptyCwd), {
      cwd: emptyCwd,
      env: nativeCodexEnvironment(options.authFile),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const itemCategories: Partial<Record<BenchmarkItemCategory, number>> = {};
    const webActions: Partial<Record<BenchmarkWebAction, number>> = {};
    let hostedWebCalls = 0;
    let usage: BenchmarkUsage | undefined;
    let terminalCompleted = false;
    let terminalFailed = false;
    let commandExecutionObserved = false;
    const output = new BoundedJsonlObserver((observation) => {
      timing.event(observation.kind);
      if (observation.kind === "native_turn_completed") {
        terminalCompleted = true;
        usage = observation.usage;
      }
      if (observation.kind === "native_turn_failed") terminalFailed = true;
      if (observation.itemCategory === "command_execution") commandExecutionObserved = true;
      if (observation.kind !== "native_item_completed" || observation.itemCategory === undefined) return;
      increment(itemCategories, observation.itemCategory);
      if (observation.itemCategory !== "web_search") return;
      hostedWebCalls += 1;
      increment(webActions, observation.webAction ?? "other");
    });
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, BENCHMARK_TIMEOUT_MS);
    watchdog.unref();
    child.stdout.on("data", (chunk: Uint8Array) => output.push(chunk));
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(scenario.prompt);
    child.once("error", () => {
      clearTimeout(watchdog);
      output.finish();
      timing.event("failed");
      resolve(nativeReport("failed"));
    });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      output.finish();
      const outcome = timedOut ? "timed_out" : code === 0 && terminalCompleted && !terminalFailed ? "completed" : "failed";
      timing.event(outcome);
      resolve(acceptedReport(outcome));
    });

    function nativeReport(outcome: BenchmarkArmReport["outcome"]): BenchmarkArmReport {
      return {
        outcome,
        durationMs: timing.durationMs(),
        hostedWebCalls,
        ...(usage === undefined ? {} : { usage, usageScope: "aggregate" as const }),
        ...(Object.keys(itemCategories).length === 0 ? {} : { itemCategories }),
        ...(Object.keys(webActions).length === 0 ? {} : { webActions }),
        actionFidelity: "limited",
        events: timing.events(),
        droppedTimingEvents: timing.droppedEvents(),
      };
    }

    function acceptedReport(outcome: BenchmarkArmReport["outcome"]): BenchmarkArmReport {
      if (commandExecutionObserved && itemCategories.command_execution === undefined) itemCategories.command_execution = 1;
      let report = nativeReport(outcome);
      const accepted = acceptedOutcome(scenario, "native_codex", report);
      if (accepted !== outcome) {
        timing.event(accepted);
        report = nativeReport(accepted);
      }
      return report;
    }
  });
}

function increment<Key extends string>(counts: Partial<Record<Key, number>>, key: Key): void {
  counts[key] = (counts[key] ?? 0) + 1;
}
