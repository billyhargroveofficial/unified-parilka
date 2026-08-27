import type { BotWorkerDrainResult } from "../bot/runtime.js";
import type { BotDaemonLifecycleTarget, BotDaemonSignalSource } from "./contracts.js";

/** Stops admission, awaits the bounded worker drain, then releases resources. */
export async function runBotDaemonLifecycle(target: BotDaemonLifecycleTarget, options: { signalSource?: BotDaemonSignalSource } = {}): Promise<BotWorkerDrainResult> {
  const signalSource = options.signalSource ?? process;
  const controller = new AbortController();
  let seen = false;
  const stop = (): void => {
    if (seen) return;
    seen = true;
    controller.abort();
    try { target.runtime.requestStop(); } catch { /* shutdown remains best effort */ }
  };
  signalSource.once("SIGINT", stop);
  signalSource.once("SIGTERM", stop);
  let result: BotWorkerDrainResult | undefined;
  try {
    result = await target.runtime.run(controller.signal);
    return result;
  } finally {
    signalSource.off("SIGINT", stop);
    signalSource.off("SIGTERM", stop);
    if ((target.activeWorkerCount?.() ?? result?.activeWorkers ?? 0) === 0) await target.close();
  }
}
