import { safeBotRuntimeConfig } from "../bot/runtime-config.js";
import { createLogger } from "../observability/logger.js";
import { safeError } from "../observability/redaction.js";
import type { ProductionBotDaemon } from "./contracts.js";
import { runBotDaemonLifecycle } from "./lifecycle.js";
import { createProductionBotDaemon } from "./production.js";

export async function main(): Promise<void> {
  let logger: ReturnType<typeof createLogger> | undefined;
  try {
    logger = createLogger({ service: "bot" });
  } catch {
    process.stderr.write(
      '{"service":"bot","event":"bot.runtime.logger_init_failed","level":"fatal"}\n',
    );
    process.exit(1);
  }
  const log = logger;
  process.once("uncaughtException", (error) => {
    try {
      log.fatal({ event: "bot.runtime.uncaught", failure: safeError(error) });
      log.flush();
    } catch { /* last-resort handler must not throw */ }
    process.exit(1);
  });
  process.once("unhandledRejection", (reason) => {
    try {
      log.fatal({ event: "bot.runtime.unhandled_rejection", failure: safeError(reason) });
      log.flush();
    } catch { /* last-resort handler must not throw */ }
    process.exit(1);
  });

  let deployment: ProductionBotDaemon | undefined;
  try {
    deployment = createProductionBotDaemon({ logger: log });
    log.info({
      event: "bot.runtime.configured",
      config: safeBotRuntimeConfig(deployment.config),
      vectorEnabled: deployment.vectorEnabled,
      webSearchEnabled: deployment.webSearchEnabled,
    });
    const drain = await runBotDaemonLifecycle(deployment);
    if (!drain.drained) {
      log.error({
        event: "bot.runtime.ungraceful_exit",
        activeWorkers: drain.activeWorkers,
      });
      process.exitCode = 1;
    }
  } catch (error) {
    log.error({
      event: "bot.runtime.fatal",
      failure: safeError(error),
    });
    process.exitCode = 1;
  } finally {
    try {
      deployment?.close();
    } finally {
      try {
        log.flush();
      } catch {
        // Telemetry failure cannot hide the exit code or keep SQLite open.
      }
    }
  }
}
