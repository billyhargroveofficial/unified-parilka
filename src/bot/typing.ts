/**
 * Best-effort Telegram typing indicator with bounded heartbeat.
 *
 * Typing is presentation-only: every call is fire-and-forget and errors are
 * swallowed so they can never alter durable turn state. The heartbeat starts
 * immediately after claim and stops when the turn reaches any terminal state.
 */

export interface TypingPort {
  sendChatAction(chatId: string, signal: AbortSignal): Promise<void>;
}

/** The narrow scheduler surface shared by direct and queued typing leases. */
export interface TypingScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TypingHeartbeatOptions {
  port: TypingPort;
  chatId: string;
  intervalMs: number;
  scheduler: TypingScheduler;
  signal: AbortSignal;
  /** Called at most once each per turn; payloads never contain chat identity. */
  onFirstSuccess?: () => void;
  onFirstFailure?: (code: string) => void;
}

export interface TypingHeartbeat {
  stop(): void;
}

export interface QueuedTypingTurn {
  /** Durable SQLite turn identity; one chat action lease may serve many turns. */
  turnId: number;
  chatId: string;
}

/**
 * Queue/worker ownership seam for Telegram's chat-level typing indicator.
 * `claim` never starts a second heartbeat when a queued turn already has one.
 */
export interface TypingLeaseManager {
  enqueue(turn: QueuedTypingTurn): void;
  claim(turn: QueuedTypingTurn): TypingHeartbeat;
  /** Releases a queued turn without trusting an external chat-id value. */
  release(turnId: number): void;
  stopAll(): void;
}

/**
 * Maintains one native Telegram typing heartbeat per chat, from durable queue
 * admission through worker execution. A turn reference is released only when
 * its terminal worker path finishes; therefore a queued successor keeps the
 * same indicator alive while an older turn is still running.
 */
export class ChatTypingLeaseManager implements TypingLeaseManager {
  readonly #port: TypingPort;
  readonly #intervalMs: number;
  readonly #scheduler: TypingScheduler;
  readonly #onFirstSuccess: (() => void) | undefined;
  readonly #onFirstFailure: ((code: string) => void) | undefined;
  readonly #turnChats = new Map<number, string>();
  readonly #chatLeases = new Map<
    string,
    { controller: AbortController; heartbeat: TypingHeartbeat; turns: Set<number> }
  >();

  constructor(options: {
    port: TypingPort;
    intervalMs?: number;
    scheduler?: TypingScheduler;
    onFirstSuccess?: () => void;
    onFirstFailure?: (code: string) => void;
  }) {
    if (!options.port || typeof options.port.sendChatAction !== "function") {
      throw new TypeError("Typing lease manager requires a typing port.");
    }
    const intervalMs = options.intervalMs ?? 4_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000) {
      throw new RangeError("Typing lease interval must be between 1 and 60000ms.");
    }
    this.#port = options.port;
    this.#intervalMs = intervalMs;
    this.#scheduler = options.scheduler ?? defaultTypingScheduler;
    this.#onFirstSuccess = options.onFirstSuccess;
    this.#onFirstFailure = options.onFirstFailure;
  }

  enqueue(turn: QueuedTypingTurn): void {
    const { turnId, chatId } = validQueuedTurn(turn);
    const previousChatId = this.#turnChats.get(turnId);
    if (previousChatId === chatId) {
      return;
    }
    if (previousChatId !== undefined) {
      this.#release(turnId, previousChatId);
    }

    let lease = this.#chatLeases.get(chatId);
    if (lease === undefined) {
      const controller = new AbortController();
      lease = {
        controller,
        heartbeat: startTypingHeartbeat({
          port: this.#port,
          chatId,
          intervalMs: this.#intervalMs,
          scheduler: this.#scheduler,
          signal: controller.signal,
          onFirstSuccess: this.#onFirstSuccess,
          onFirstFailure: this.#onFirstFailure,
        }),
        turns: new Set<number>(),
      };
      this.#chatLeases.set(chatId, lease);
    }
    lease.turns.add(turnId);
    this.#turnChats.set(turnId, chatId);
  }

  claim(turn: QueuedTypingTurn): TypingHeartbeat {
    const { turnId, chatId } = validQueuedTurn(turn);
    this.enqueue({ turnId, chatId });
    let released = false;
    return {
      stop: () => {
        if (released) return;
        released = true;
        this.#release(turnId, chatId);
      },
    };
  }

  release(turnId: number): void {
    const normalizedTurnId = validTurnId(turnId);
    const chatId = this.#turnChats.get(normalizedTurnId);
    if (chatId !== undefined) {
      this.#release(normalizedTurnId, chatId);
    }
  }

  stopAll(): void {
    for (const lease of this.#chatLeases.values()) {
      lease.controller.abort();
      lease.heartbeat.stop();
    }
    this.#chatLeases.clear();
    this.#turnChats.clear();
  }

  #release(turnId: number, chatId: string): void {
    if (this.#turnChats.get(turnId) !== chatId) {
      return;
    }
    this.#turnChats.delete(turnId);
    const lease = this.#chatLeases.get(chatId);
    if (lease === undefined) {
      return;
    }
    lease.turns.delete(turnId);
    if (lease.turns.size !== 0) {
      return;
    }
    this.#chatLeases.delete(chatId);
    lease.controller.abort();
    lease.heartbeat.stop();
  }
}

/**
 * Fires an immediate typing action and then repeats on a bounded interval.
 * Returns a handle whose `stop()` clears the interval. Calling `stop()` more
 * than once is safe.
 */
export function startTypingHeartbeat(
  options: TypingHeartbeatOptions,
): TypingHeartbeat {
  const {
    port,
    chatId,
    intervalMs,
    scheduler,
    signal,
    onFirstSuccess,
    onFirstFailure,
  } = options;
  let stopped = false;
  let sentObserved = false;
  let failureObserved = false;
  let handle: unknown;

  const fire = (): void => {
    if (stopped || signal.aborted) {
      return;
    }
    void port.sendChatAction(chatId, signal).then(
      () => {
        if (sentObserved || stopped || signal.aborted) return;
        sentObserved = true;
        invokeSuccessTelemetry(onFirstSuccess);
      },
      (error: unknown) => {
        if (failureObserved || stopped || signal.aborted) return;
        failureObserved = true;
        invokeFailureTelemetry(onFirstFailure, typingFailureCode(error));
      },
    );
  };

  fire();
  handle = scheduler.setInterval(fire, intervalMs);

  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      scheduler.clearInterval(handle);
    },
  };
}

function invokeSuccessTelemetry(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Best-effort observability must remain outside durable turn control.
  }
}

function invokeFailureTelemetry(
  callback: ((code: string) => void) | undefined,
  code: string,
): void {
  try {
    callback?.(code);
  } catch {
    // Best-effort observability must remain outside durable turn control.
  }
}

function typingFailureCode(error: unknown): string {
  const candidate = error !== null && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof candidate === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(candidate)) {
    return candidate;
  }
  return "TYPING_ACTION_FAILED";
}

const defaultTypingScheduler: TypingScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function validQueuedTurn(value: QueuedTypingTurn): QueuedTypingTurn {
  const turnId = validTurnId(value.turnId);
  const chatId = value.chatId.trim();
  if (chatId.length === 0 || chatId.length > 256) {
    throw new TypeError("Queued typing chatId must be a non-empty bounded string.");
  }
  return { turnId, chatId };
}

function validTurnId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Queued typing turnId must be a positive safe integer.");
  }
  return value;
}
