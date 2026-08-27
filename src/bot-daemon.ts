#!/usr/bin/env node
import { isDirectBotDaemonExecution } from "./bot-daemon/entrypoint.js";
import { runBotDaemonCommand } from "./bot-daemon/command.js";

export { composeBotDaemon } from "./bot-daemon/composition.js";
export { createProductionBotDaemon, assertBotDaemonConfiguration } from "./bot-daemon/production.js";
export { runBotDaemonLifecycle } from "./bot-daemon/lifecycle.js";
export { main } from "./bot-daemon/main.js";
export { runBotResponsesPreflight } from "./bot-daemon/preflight.js";
export { runBotDaemonCommand, selectBotDaemonCommand } from "./bot-daemon/command.js";
export type * from "./bot-daemon/contracts.js";

if (isDirectBotDaemonExecution(import.meta.url)) {
  void runBotDaemonCommand(process.argv.slice(2));
}
