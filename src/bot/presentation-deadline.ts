/** Narrow timer boundary for deterministic presentation timing. */
export interface PresentationScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type PresentationDeadlineOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "failed" }
  | { kind: "timed_out" };

export const defaultPresentationScheduler: PresentationScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Races a best-effort presentation operation against its hard deadline. A
 * late successful operation can be compensated by the caller when necessary.
 */
export async function runPresentationWithinDeadline<T>(options: {
  operation: (signal: AbortSignal) => Promise<T>;
  parentSignal: AbortSignal;
  scheduler: PresentationScheduler;
  timeoutMs: number;
  onLateSuccess?: (value: T) => void;
}): Promise<PresentationDeadlineOutcome<T>> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.parentSignal.reason);
  options.parentSignal.addEventListener("abort", abortFromParent, { once: true });
  if (options.parentSignal.aborted) {
    abortFromParent();
  }
  let request: Promise<T>;
  try {
    request = options.operation(controller.signal);
  } catch {
    request = Promise.reject(new Error("Tool progress presentation request failed."));
  }
  const completion = request.then<PresentationDeadlineOutcome<T>, PresentationDeadlineOutcome<T>>(
    (value) => ({ kind: "completed", value }),
    () => ({ kind: "failed" }),
  );
  let timeoutHandle: unknown;
  const timeout = new Promise<PresentationDeadlineOutcome<T>>((resolve) => {
    timeoutHandle = options.scheduler.setTimeout(
      () => resolve({ kind: "timed_out" }),
      options.timeoutMs,
    );
  });
  const outcome = await Promise.race([completion, timeout]);
  options.scheduler.clearTimeout(timeoutHandle);
  options.parentSignal.removeEventListener("abort", abortFromParent);
  if (outcome.kind === "timed_out") {
    controller.abort(new Error("Tool progress presentation deadline exceeded."));
    void completion.then((lateOutcome) => {
      if (lateOutcome.kind === "completed") {
        try {
          options.onLateSuccess?.(lateOutcome.value);
        } catch {
          // Late best-effort compensation cannot affect a completed turn.
        }
      }
    });
  }
  return outcome;
}

export function waitForSchedulerDelay(
  scheduler: PresentationScheduler,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let handle: unknown;
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      if (handle !== undefined) {
        scheduler.clearTimeout(handle);
      }
      done();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    handle = scheduler.setTimeout(done, delayMs);
  });
}
