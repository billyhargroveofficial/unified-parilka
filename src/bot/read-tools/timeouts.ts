import type { StoredMessage } from "../../store.js";
import type {
  CachedChatSearchResult,
  WebFetchProvider,
  WebFetchResponse,
  WebSearchProvider,
  WebSearchResponse,
} from "./contracts.js";
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

export async function callWebProvider(params: {
  provider: WebSearchProvider;
  query: string;
  timeoutMs: number;
  externalSignal?: AbortSignal;
}): Promise<WebSearchResponse> {
  if (params.externalSignal?.aborted) {
    const timedOut = abortSignalTimedOut(params.externalSignal);
    throw new ReadToolExecutionError(
      timedOut ? "timeout" : "aborted",
      timedOut,
      timedOut
        ? "Web search timed out."
        : "Web search was aborted.",
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
    controller.abort(
      new ReadToolExecutionError(
        "timeout",
        true,
        `Web search exceeded ${params.timeoutMs} ms.`,
      ),
    );
  }, params.timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(
          controller.signal.reason ??
            new ReadToolExecutionError(
              "aborted",
              false,
              "Web search was aborted.",
            ),
        );
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        params.provider.search({
          query: params.query,
          signal: controller.signal,
        }),
      ),
      aborted,
    ]);
  } catch (error) {
    if (timedOut) {
      throw new ReadToolExecutionError(
        "timeout",
        true,
        `Web search exceeded ${params.timeoutMs} ms.`,
      );
    }
    if (params.externalSignal?.aborted) {
      throw new ReadToolExecutionError(
        externalTimedOut ? "timeout" : "aborted",
        externalTimedOut,
        externalTimedOut
          ? "Web search timed out."
          : "Web search was aborted.",
      );
    }
    if (error instanceof ReadToolExecutionError) {
      throw error;
    }
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      "Web search failed.",
    );
  } finally {
    clearTimeout(timeout);
    params.externalSignal?.removeEventListener(
      "abort",
      onExternalAbort,
    );
  }
}

export async function callWebFetchProvider(params: {
  provider: WebFetchProvider;
  url: string;
  maxChars: number;
  timeoutMs: number;
  externalSignal?: AbortSignal;
}): Promise<WebFetchResponse> {
  if (params.externalSignal?.aborted) {
    const timedOut = abortSignalTimedOut(params.externalSignal);
    throw new ReadToolExecutionError(
      timedOut ? "timeout" : "aborted",
      timedOut,
      timedOut
        ? "Static page fetch timed out."
        : "Static page fetch was aborted.",
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
    controller.abort(
      new ReadToolExecutionError(
        "timeout",
        true,
        `Static page fetch exceeded ${params.timeoutMs} ms.`,
      ),
    );
  }, params.timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(
          controller.signal.reason ??
            new ReadToolExecutionError(
              "aborted",
              false,
              "Static page fetch was aborted.",
            ),
        );
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        params.provider.fetch({
          url: params.url,
          maxChars: params.maxChars,
          signal: controller.signal,
        }),
      ),
      aborted,
    ]);
  } catch (error) {
    if (timedOut) {
      throw new ReadToolExecutionError(
        "timeout",
        true,
        `Static page fetch exceeded ${params.timeoutMs} ms.`,
      );
    }
    if (params.externalSignal?.aborted) {
      throw new ReadToolExecutionError(
        externalTimedOut ? "timeout" : "aborted",
        externalTimedOut,
        externalTimedOut
          ? "Static page fetch timed out."
          : "Static page fetch was aborted.",
      );
    }
    if (error instanceof ReadToolExecutionError) {
      throw error;
    }
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      "Static page fetch failed.",
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
