import { runBotResponsesPreflightMain } from "./preflight.js";
import { main as runBotDaemonMain } from "./main.js";

export type BotDaemonCommand = "run" | "preflight";

export function selectBotDaemonCommand(args: readonly string[]): BotDaemonCommand {
  if (args.length === 0) return "run";
  if (args.length === 1 && args[0] === "--preflight") return "preflight";
  throw new Error("parilka-bot accepts no arguments except --preflight.");
}

export async function runBotDaemonCommand(args: readonly string[]): Promise<void> {
  let command: BotDaemonCommand;
  try {
    command = selectBotDaemonCommand(args);
  } catch {
    process.stderr.write("parilka-bot accepts no arguments except --preflight.\n");
    process.exitCode = 2;
    return;
  }
  if (command === "preflight") {
    await runBotResponsesPreflightMain();
    return;
  }
  await runBotDaemonMain();
}
