import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { TelegramFetch } from "./telegram-bot-api.js";

const ACTION_CONNECTIONS = 4;

export interface TelegramHttpLanes {
  readonly actionFetch: TelegramFetch;
  readonly pollFetch: TelegramFetch;
  close(): Promise<void>;
}

/**
 * Gives Telegram long polling and user-visible Bot API calls independent
 * connection pools. A 30-second getUpdates request must never hold up typing,
 * progress, publication, edits, or cleanup.
 */
export function createTelegramHttpLanes(): TelegramHttpLanes {
  const actionDispatcher = new Agent({
    connections: ACTION_CONNECTIONS,
    pipelining: 1,
  });
  const pollDispatcher = new Agent({
    connections: 1,
    pipelining: 1,
  });
  let closed: Promise<void> | undefined;

  return {
    actionFetch: dispatcherFetch(actionDispatcher),
    pollFetch: dispatcherFetch(pollDispatcher),
    close() {
      closed ??= Promise.all([
        actionDispatcher.close(),
        pollDispatcher.close(),
      ]).then(() => undefined);
      return closed;
    },
  };
}

function dispatcherFetch(dispatcher: Dispatcher): TelegramFetch {
  return async (input, init) => {
    const response = await undiciFetch(input, {
      ...init,
      dispatcher,
    });
    return response as Response;
  };
}
