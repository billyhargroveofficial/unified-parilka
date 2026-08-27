import type { StoredMessage } from "../../store.js";
import type { CachedChatSearchResult } from "./contracts.js";
import { ReadToolExecutionError } from "./payload.js";

export async function callCacheSearch(params: {
  operation: (
    signal: AbortSignal,
  ) =>
    | readonly StoredMessage[]
    | CachedChatSearchResult
    | Promise<
        readonly StoredMessage[] | CachedChatSearchResult
      >;
  timeoutMs: number;
  externalSignal?: AbortSignal;
}): Promise<readonly StoredMessage[] | CachedChatSearchResult> {
  if (params.externalSignal?.aborted) {
    const timedOut = abortSignalTimedOut(params.externalSignal);
    throw new ReadToolExecutionError(
      timedOut ? "timeout" : "aborted",
      timedOut,
      timedOut
        ? "Chat search timed out."
        : "Chat search was aborted.",
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  let externalTimedOut = false;
  const onExternalAbort = () => {
    externalTimedOut =
      params.externalSignal != null &&
      abortSignalTimedOut(params.externalSignal);
    controller.abort(params.externalSignal?.reason);
  };
  params.externalSignal?.addEventListener(
    "abort",
    onExternalAbort,
    { once: true },
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, params.timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          new ReadToolExecutionError(
            timedOut || externalTimedOut ? "timeout" : "aborted",
            timedOut || externalTimedOut,
            timedOut || externalTimedOut
              ? `Chat search exceeded ${params.timeoutMs} ms.`
              : "Chat search was aborted.",
          ),
        ),
      { once: true },
    );
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        params.operation(controller.signal),
      ),
      aborted,
    ]);
  } catch (error) {
    if (error instanceof ReadToolExecutionError) {
      throw error;
    }
    throw new ReadToolExecutionError(
      "cache_error",
      false,
      "Chat search failed.",
    );
  } finally {
    clearTimeout(timeout);
    params.externalSignal?.removeEventListener(
      "abort",
      onExternalAbort,
    );
  }
}

function abortSignalTimedOut(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    (("name" in reason &&
      (reason as { name?: unknown }).name === "TimeoutError") ||
      ("code" in reason &&
        (reason as { code?: unknown }).code === "timeout"))
  );
}
