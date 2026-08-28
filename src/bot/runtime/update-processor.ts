import { normalizeTelegramUpdate } from "../telegram-update.js";
import { boundedInteger, BotRuntimeProtocolError, compact, durableMessageId, safeMachineCode, stringifyUpdate, updateIdentifier } from "./helpers.js";
import type { BotRuntimeStore, BotUpdateProcessingResult, BotUpdateProcessorOptions, BotWorkNotifier } from "./contracts.js";
import type { TurnCoordinator } from "../turn-coordinator.js";
import type { TelegramUpdateOptions } from "../telegram-update.js";
import type { JsonEventLogger } from "../worker.js";

const MAX_RAW_UPDATE_CHARS = 2_000_000;
const BOT_TRIGGER_COOLDOWN_PREFIX = "telegram-user:";

export class BotUpdateProcessor {
  readonly #store: BotRuntimeStore;
  readonly #coordinator: TurnCoordinator;
  readonly #workNotifier: BotWorkNotifier;
  readonly #telegram: TelegramUpdateOptions;
  readonly #triggerCooldownMs: number;
  readonly #updateMaxAttempts: number;
  readonly #logger: JsonEventLogger | undefined;
  readonly #now: () => number;

  constructor(options: BotUpdateProcessorOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#workNotifier = options.workNotifier;
    this.#telegram = options.telegram;
    this.#triggerCooldownMs = boundedInteger(
      options.triggerCooldownMs ?? 5_000,
      0,
      60_000,
      "triggerCooldownMs",
    );
    this.#updateMaxAttempts = boundedInteger(
      options.updateMaxAttempts ?? 3,
      1,
      20,
      "updateMaxAttempts",
    );
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  process(update: unknown): BotUpdateProcessingResult {
    const updateId = updateIdentifier(update);
    if (updateId === undefined) {
      throw new BotRuntimeProtocolError("UPDATE_ID_MISSING");
    }

    const existing = this.#store.getBotUpdate(updateId);
    if (
      existing &&
      (existing.status === "dead_letter" ||
        (existing.chatId != null &&
          existing.triggerMessageId != null))
    ) {
      const turn =
        existing.chatId != null &&
        existing.triggerMessageId != null
          ? this.#store.getBotTurnByTrigger(
              existing.chatId,
              existing.triggerMessageId,
            )
          : undefined;
      if (turn?.status === "queued" || turn?.status === "failed") {
        this.#workNotifier.notify();
      }
      this.#log("info", "bot.update.duplicate_ack", {
        updateId,
        status: existing.status,
        turnId: turn?.id,
      });
      return {
        acknowledged: true,
        ackUpdateId: updateId,
        disposition: "duplicate",
        turnReserved: turn?.updateId === updateId,
        routed: false,
      };
    }

    const rawJson = stringifyUpdate(update);
    if (
      rawJson === undefined ||
      rawJson.length > MAX_RAW_UPDATE_CHARS
    ) {
      return this.#recordPoison(
        updateId,
        "raw_update_unserializable_or_too_large",
      );
    }

    const normalized = normalizeTelegramUpdate(update, this.#telegram);
    if (
      !normalized.ingest ||
      normalized.updateId !== updateId ||
      !normalized.chat ||
      !normalized.message ||
      !normalized.updateKind
    ) {
      return this.#recordPoison(updateId, normalized.reason);
    }

    const result = this.#store.ingestBotUpdate({
      updateId,
      rawJson,
      chat: normalized.chat,
      message: normalized.message,
      addressed: normalized.addressed,
      ...(normalized.addressed
        ? {
            triggerCooldown: {
              userKey:
                BOT_TRIGGER_COOLDOWN_PREFIX +
                (normalized.message.senderId ?? "unknown"),
              cooldownMs: this.#triggerCooldownMs,
            },
          }
        : {}),
      maxAttempts: this.#updateMaxAttempts,
      nowMs: this.#now(),
    });

    let routed = false;
    if (
      result.disposition !== "duplicate" &&
      normalized.updateKind === "message" &&
      normalized.reason !== "own_message" &&
      normalized.reason !== "bot_message"
    ) {
      this.#coordinator.routeMessage({
        messageId: durableMessageId(normalized.message),
        senderId:
          normalized.message.senderId ??
          `unknown:${normalized.message.chatId}:${normalized.message.messageId}`,
        ...(normalized.message.senderName === undefined
          ? {}
          : { senderName: normalized.message.senderName }),
        text: normalized.message.text,
        ...(normalized.replyToBot === true
          ? { replyToBot: true as const }
          : {}),
      });
      routed = true;
    }

    if (
      result.turn?.status === "queued" ||
      result.turn?.status === "failed"
    ) {
      this.#workNotifier.notify();
    }
    this.#log(
      result.throttled ? "warn" : "info",
      result.throttled
        ? "bot.update.cooldown"
        : "bot.update.committed",
      {
        updateId,
        reason: normalized.reason,
        disposition: result.disposition,
        turnId: result.turn?.id,
        routed,
        retryAfterMs: result.throttled?.retryAfterMs,
      },
    );
    return {
      acknowledged: true,
      ackUpdateId: result.ackUpdateId,
      disposition: result.disposition,
      turnReserved:
        result.turn?.updateId === updateId &&
        result.throttled === undefined,
      routed,
    };
  }

  #recordPoison(
    updateId: number,
    reason: string,
  ): BotUpdateProcessingResult {
    const result = this.#store.recordBotUpdateFailure({
      updateId,
      rawJson: JSON.stringify({ update_id: updateId, reason }),
      error: `Bot API update rejected: ${safeMachineCode(reason)}.`,
      maxAttempts: this.#updateMaxAttempts,
      nowMs: this.#now(),
    });
    this.#log("warn", "bot.update.rejected", {
      updateId,
      reason: safeMachineCode(reason),
      attempts: result.update.attempts,
      maxAttempts: result.update.maxAttempts,
      deadLetter: result.ackUpdateId !== undefined,
    });
    return result.ackUpdateId === undefined
      ? {
          acknowledged: false,
          updateId,
          disposition: "poison_retry",
        }
      : {
          acknowledged: true,
          ackUpdateId: result.ackUpdateId,
          disposition: "dead_letter",
          turnReserved: false,
          routed: false,
        };
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...compact(fields) });
    } catch {
      // Telemetry is never part of the durable ACK path.
    }
  }
}
