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

export interface TypingHeartbeatOptions {
  port: TypingPort;
  chatId: string;
  intervalMs: number;
  scheduler: {
    setInterval(callback: () => void, delayMs: number): unknown;
    clearInterval(handle: unknown): void;
  };
  signal: AbortSignal;
}

export interface TypingHeartbeat {
  stop(): void;
}

/**
 * Fires an immediate typing action and then repeats on a bounded interval.
 * Returns a handle whose `stop()` clears the interval. Calling `stop()` more
 * than once is safe.
 */
export function startTypingHeartbeat(
  options: TypingHeartbeatOptions,
): TypingHeartbeat {
  const { port, chatId, intervalMs, scheduler, signal } = options;
  let stopped = false;
  let handle: unknown;

  const fire = (): void => {
    if (stopped || signal.aborted) {
      return;
    }
    port.sendChatAction(chatId, signal).catch(() => {
      // Typing is best-effort; a failure here must never propagate.
    });
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
