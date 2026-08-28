#!/usr/bin/env node

import { isDirectBotDaemonExecution } from "./bot-daemon/entrypoint.js";
import { main as runBotDaemonMain } from "./bot-daemon/main.js";

export { composeBotDaemon } from "./bot-daemon/composition.js";
export type {
  BotDaemonApi,
  BotDaemonComposition,
  BotDaemonLifecycleTarget,
  BotDaemonRuntimePort,
  BotDaemonSignalSource,
  ComposeBotDaemonOptions,
  CreateProductionBotDaemonOptions,
  ProductionBotDaemon,
  ProductionBotDaemonFactories,
} from "./bot-daemon/contracts.js";
export { runBotDaemonLifecycle } from "./bot-daemon/lifecycle.js";
export { main } from "./bot-daemon/main.js";
export {
  assertBotDaemonConfiguration,
  createProductionBotDaemon,
} from "./bot-daemon/production.js";

if (isDirectBotDaemonExecution(import.meta.url)) {
  void runBotDaemonMain();
}
