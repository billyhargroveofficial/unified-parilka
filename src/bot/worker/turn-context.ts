import type {
  MessageStore,
  StoredBotTurn,
  StoredMessage,
} from "../../store.js";
import type {
  FoldBatch,
  TurnBoundary,
  TurnCoordinator,
} from "../turn-coordinator.js";
import {
  BOT_CONTEXT_MESSAGES,
  BOT_REPLAY_MESSAGES,
} from "./contracts.js";
import {
  durableMessageId,
  WorkerProtocolError,
} from "./helpers.js";

export interface LoadedBotTurn {
  trigger: StoredMessage;
  replyTarget?: StoredMessage;
  context: StoredMessage[];
  replay: StoredMessage[];
}

export function loadBotTurn(
  store: MessageStore,
  turn: StoredBotTurn,
): LoadedBotTurn | undefined {
  const storedTrigger = store.getMessagesByIds({
    chatId: turn.chatId,
    messageIds: [turn.triggerMessageId],
  })[0];
  if (!storedTrigger) {
    return undefined;
  }
  // The MTProto synchronizer intentionally stores only generic message
  // metadata and may later overwrite `messages.raw_json`. A Bot API turn has
  // its own durable raw update, which is the authoritative bounded source for
  // a current attachment and its one-hop `reply_to_message`. Rehydrate it
  // only after matching the exact turn/update/chat/message tuple.
  const trigger = hydrateBotApiTrigger(store, turn, storedTrigger);
  const previous = store
    .getHistory({
      chatId: turn.chatId,
      beforeId: turn.triggerMessageId,
      limit: BOT_CONTEXT_MESSAGES,
      order: "desc",
    })
    .reverse();
  const replay = store.getHistory({
    chatId: turn.chatId,
    afterId: turn.triggerMessageId,
    limit: BOT_REPLAY_MESSAGES,
    order: "asc",
  });
  const replyTarget = trigger.replyToMessageId === undefined
    ? undefined
    : store.getMessagesByIds({
        chatId: turn.chatId,
        messageIds: [trigger.replyToMessageId],
      })[0];
  return {
    trigger,
    ...(replyTarget === undefined ? {} : { replyTarget }),
    context: [...previous, trigger],
    replay,
  };
}

const MAX_BOT_UPDATE_RAW_CHARS = 2_000_000;

function hydrateBotApiTrigger(
  store: MessageStore,
  turn: StoredBotTurn,
  trigger: StoredMessage,
): StoredMessage {
  const update = store.getBotUpdate(turn.updateId);
  if (
    !update ||
    !update.addressed ||
    update.chatId !== turn.chatId ||
    update.triggerMessageId !== turn.triggerMessageId ||
    update.rawJson.length === 0 ||
    update.rawJson.length > MAX_BOT_UPDATE_RAW_CHARS
  ) {
    return trigger;
  }
  try {
    const root = asObject(JSON.parse(update.rawJson));
    const message = asObject(root?.message);
    const chat = asObject(message?.chat);
    if (
      !message ||
      positiveInteger(message.message_id) !== turn.triggerMessageId ||
      telegramId(chat?.id) !== turn.chatId
    ) {
      return trigger;
    }
    const rawJson = JSON.stringify(message);
    return rawJson.length <= MAX_BOT_UPDATE_RAW_CHARS
      ? { ...trigger, rawJson }
      : trigger;
  } catch {
    return trigger;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function telegramId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  return typeof value === "string" && /^-?\d+$/u.test(value)
    ? value.replace(/^-?0+(?=\d)/u, (zeroes) =>
        zeroes.startsWith("-") ? "-" : "",
      )
    : undefined;
}

export function seedBotTurnReplay(
  coordinator: TurnCoordinator,
  coordinatorTurnId: string,
  replay: readonly StoredMessage[],
): void {
  const seeded = coordinator.seedTurnReplay(
    coordinatorTurnId,
    replay.map((message) => ({
      messageId: durableMessageId(message),
      senderId: message.senderId ?? "unknown",
      ...(message.senderName == null
        ? {}
        : { senderName: message.senderName }),
      text: message.text,
    })),
  );
  if (seeded.status === "not_found") {
    throw new WorkerProtocolError("coordinator_turn_missing");
  }
}

export function createTurnFoldCollector(
  coordinator: TurnCoordinator,
  coordinatorTurnId: string,
): {
  drainFold: (boundary: TurnBoundary) => FoldBatch;
} {
  const drainFold = (boundary: TurnBoundary): FoldBatch => {
    const result = coordinator.drainAtBoundary(
      coordinatorTurnId,
      boundary,
    );
    if (result.status === "not_found") {
      throw new WorkerProtocolError("coordinator_turn_missing");
    }
    return result.fold;
  };
  return {
    drainFold,
  };
}
