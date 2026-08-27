import type { Response } from "openai/resources/responses/responses";
import {
  OPENAI_RESPONSES_MODEL,
  OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER,
  type EffectiveResponsesServiceTier,
  type ResponsesProgressEvent,
  type RunResponsesTurnRequest,
  ResponsesTurnCancelledError,
  ResponsesTurnError,
} from "./contracts.js";

export type CompletedResponseAdmission = {
  model: typeof OPENAI_RESPONSES_MODEL;
  serviceTier: EffectiveResponsesServiceTier;
};

/**
 * The public Luna page currently lists only the `gpt-5.6-luna` alias, not a
 * dated snapshot. Accept that exact response identity only: prefix matching
 * would silently admit Terra, Sol, or an unreviewed future snapshot.
 *
 * The subscription transport normalizes its Fast lane to the exact `priority`
 * wire value. Reject every other value on every function-loop leg, not merely
 * during daemon preflight.
 */
export function assertCompletedResponseAdmission(response: Response): CompletedResponseAdmission {
  if (response.model !== OPENAI_RESPONSES_MODEL) {
    throw new ResponsesTurnError("Responses completed with an unexpected model.");
  }
  if (response.status !== "completed") {
    throw new ResponsesTurnError("Responses completed event carried a non-completed response.");
  }
  if (response.service_tier !== OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER) {
    throw new ResponsesTurnError("Responses completed without the required fast service tier.");
  }
  return { model: OPENAI_RESPONSES_MODEL, serviceTier: OPENAI_RESPONSES_SUBSCRIPTION_SERVICE_TIER };
}

export async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  return await awaitWithAbort(iterator.next(), signal);
}

export async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ResponsesTurnCancelledError();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new ResponsesTurnCancelledError());
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

export function joinSignals(parent: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

export async function progress(
  request: RunResponsesTurnRequest,
  event: ResponsesProgressEvent,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const update = Promise.resolve(request.progress?.onProgress(event));
    if (signal === undefined) await update;
    else await awaitWithAbort(update, signal);
  } catch { /* presentation never controls a model turn */ }
}
