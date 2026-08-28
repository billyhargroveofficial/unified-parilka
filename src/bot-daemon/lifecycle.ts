import type { BotWorkerDrainResult } from "../bot/runtime.js";
import type {
  BotDaemonLifecycleTarget,
  BotDaemonSignalSource,
} from "./contracts.js";
import { safeDaemonLog } from "./trace.js";

/**
 * Stops intake first, waits for the bounded in-flight drain, then closes
 * SQLite only when no worker can still use it.
 */
export async function runBotDaemonLifecycle(
  target: BotDaemonLifecycleTarget,
  options: {
    signalSource?: BotDaemonSignalSource;
  } = {},
): Promise<BotWorkerDrainResult> {
  const signalSource = options.signalSource ?? process;
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (receivedSignal !== undefined) {
      return;
    }
    receivedSignal = signal;
    safeDaemonLog(target.logger, "info", {
      event: "bot.runtime.signal",
      signal,
    });
    controller.abort(new BotDaemonStopError(signal));
    try {
      target.runtime.requestStop();
    } catch {
      safeDaemonLog(target.logger, "warn", {
        event: "bot.runtime.stop_request_failed",
      });
    }
  };
  signalSource.once("SIGINT", onSignal);
  signalSource.once("SIGTERM", onSignal);
  let drainResult: BotWorkerDrainResult | undefined;
  try {
    drainResult = await target.runtime.run(controller.signal);
    return drainResult;
  } finally {
    try {
      signalSource.off("SIGINT", onSignal);
      signalSource.off("SIGTERM", onSignal);
    } finally {
      const activeWorkers =
        target.activeWorkerCount?.() ??
        drainResult?.activeWorkers ??
        0;
      if (activeWorkers === 0) {
        target.close();
      } else {
        safeDaemonLog(target.logger, "error", {
          event: "bot.runtime.sqlite_close_deferred",
          activeWorkers,
        });
      }
    }
  }
}

class BotDaemonStopError extends Error {
  readonly name = "BotDaemonStopError";

  constructor(readonly signal: NodeJS.Signals) {
    super(`Bot daemon is stopping after ${signal}.`);
  }
}
