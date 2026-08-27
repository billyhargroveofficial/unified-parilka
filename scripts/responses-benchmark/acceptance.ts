import type { BenchmarkArm, BenchmarkArmReport, BenchmarkOutcome, BenchmarkScenario } from "./contracts.js";

/**
 * Completion means the process returned; acceptance additionally checks that
 * the requested observable evidence was actually present in the safe report.
 */
export function acceptedOutcome(
  scenario: BenchmarkScenario,
  arm: BenchmarkArm,
  report: BenchmarkArmReport,
): BenchmarkOutcome {
  if (report.outcome !== "completed") return report.outcome;
  if ((report.itemCategories?.command_execution ?? 0) > 0) return "invalid";
  const webCalls = report.hostedWebCalls ?? 0;
  const search = report.webActions?.search ?? 0;
  const openedOrFound = (report.webActions?.open_page ?? 0) + (report.webActions?.find_in_page ?? 0);
  if (scenario.id === "ordinary") return "completed";
  if (scenario.id === "web") return search >= 1 ? "completed" : "invalid";
  if (scenario.id === "fetch") {
    if (search < 1 || webCalls < 2) return "invalid";
    return arm === "native_codex" ? "unverifiable" : openedOrFound >= 1 ? "completed" : "invalid";
  }
  if (webCalls < 4 || search < 1) return "invalid";
  return arm === "native_codex" ? "unverifiable" : openedOrFound >= 1 ? "completed" : "invalid";
}
