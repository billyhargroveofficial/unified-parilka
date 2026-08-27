import { safeBotRuntimeConfig } from "../bot/runtime-config.js";
import { createLogger } from "../observability/logger.js";
import { safeError } from "../observability/redaction.js";
import { createProductionBotDaemon } from "./production.js";
import { runBotDaemonLifecycle } from "./lifecycle.js";

export async function main(): Promise<void> {
  const logger = createLogger({ service: "bot" });
  let daemon: ReturnType<typeof createProductionBotDaemon> | undefined;
  try {
    daemon = createProductionBotDaemon({ logger });
    logger.info({ event: "bot.runtime.configured", config: safeBotRuntimeConfig(daemon.config) });
    const drained = await runBotDaemonLifecycle(daemon);
    if (!drained.drained) process.exitCode = 1;
  } catch (error) {
    logger.error({ event: "bot.runtime.fatal", failure: safeError(error) });
    process.exitCode = 1;
  } finally {
    await daemon?.close().catch(() => { process.exitCode = 1; });
    logger.flush();
  }
}
