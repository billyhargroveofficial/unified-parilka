import type { MessageStore, StoredBotTurn } from "../../store.js";
import { TurnCoordinator } from "../turn-coordinator.js";
import {
  createTelegramPublication,
  type TelegramPublication,
} from "../telegram-publication.js";
import {
  ToolProgressPublisher,
  type ToolProgressBotApiPort,
} from "../tool-progress.js";
import {
  startTypingHeartbeat,
  type TypingHeartbeat,
  type TypingLeaseManager,
  type TypingPort,
} from "../typing.js";
import {
  type BotAgentFinalResult,
  type BotTurnAgent,
  type BotTurnPublisher,
  type BotTurnWorkerOptions,
  type BotTurnWorkerResult,
  type JsonEventLogger,
  PROGRESS_CLEANUP_RETRY_MS,
  type WorkerScheduler,
} from "./contracts.js";
import { dispatchBotTurn, markBotTurnLostAck } from "./dispatch.js";
import {
  isAgentFinal,
  safeErrorCode,
} from "./helpers.js";
import { isBotAgentFinalReplyWithinLimit } from "../agent-contract.js";
import { startTurnTimers, type TurnTimers } from "./timers.js";
import {
  createTurnFoldCollector,
  loadBotTurn,
  seedBotTurnReplay,
} from "./turn-context.js";
import { resolveBotTurnWorkerSettings } from "./worker-config.js";

export class BotTurnWorker {
  readonly #store: MessageStore;
  readonly #coordinator: TurnCoordinator;
  readonly #agent: BotTurnAgent;
  readonly #publisher: BotTurnPublisher;
  readonly #workerId: string;
  readonly #allowedChatId: string;
  readonly #mode: "live" | "shadow";
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #publishTimeoutMs: number;
  readonly #typingPort: TypingPort | undefined;
  readonly #typingLeases: Pick<TypingLeaseManager, "claim" | "release"> | undefined;
  readonly #typingIntervalMs: number;
  readonly #toolProgressBotApiPort: ToolProgressBotApiPort | undefined;
  readonly #logger: JsonEventLogger | undefined;
  readonly #scheduler: WorkerScheduler;
  readonly #now: () => number;
  /** Rate-limits a failed presentation cleanup without starving it behind work. */
  #nextProgressCleanupAtMs = 0;

  constructor(options: BotTurnWorkerOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#agent = options.agent;
    this.#publisher = options.publisher;
    const settings = resolveBotTurnWorkerSettings(options);
    this.#workerId = settings.workerId;
    this.#allowedChatId = settings.allowedChatId;
    this.#mode = settings.mode;
    this.#leaseMs = settings.leaseMs;
    this.#heartbeatMs = settings.heartbeatMs;
    this.#publishTimeoutMs = settings.publishTimeoutMs;
    this.#typingPort = options.typingPort;
    this.#typingLeases = options.typingLeases;
    this.#typingIntervalMs = options.typingIntervalMs ?? 4_000;
    this.#toolProgressBotApiPort = options.toolProgressBotApiPort;
    this.#logger = settings.logger;
    this.#scheduler = settings.scheduler;
    this.#now = settings.now;
  }

  async runOnce(): Promise<BotTurnWorkerResult> {
    // Cleanup belongs ahead of normal claim. Otherwise a permanently busy
    // FIFO queue can keep a stale completed-turn bubble visible forever.
    const progressCleanup = await this.#cleanupTerminalProgress();
    if (this.#coordinator.availableTurnSlots <= 0) {
      this.#log("info", "bot.turn.capacity", {
        activeTurns: this.#coordinator.activeTurnCount,
      });
      return { status: "capacity" };
    }

    const turn = this.#store.claimNextBotTurn({
      workerId: this.#workerId,
      chatId: this.#allowedChatId,
      leaseMs: this.#leaseMs,
      nowMs: this.#now(),
    });
    if (!turn) {
      if (progressCleanup !== undefined) {
        return progressCleanup;
      }
      const nowMs = this.#now();
      const retryAt = this.#store.getNextBotTurnRetryAt(
        this.#allowedChatId,
        nowMs,
      );
      const progressRetryAfterMs = this.#progressCleanupRetryAfter(nowMs);
      const retryAfterMs = earliestRetryAfter(
        retryAt == null ? undefined : Math.max(1, retryAt - nowMs),
        progressRetryAfterMs,
      );
      return {
        status: "idle",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    // The coordinator remains string-generic, while production correlation
    // uses the canonical decimal representation of the durable SQLite turn.
    const coordinatorTurnId = String(turn.id);
    let coordinatorStarted = false;
    let timers: TurnTimers | undefined;
    let typing: TypingHeartbeat | undefined;
    let reachedSending = false;
    const controller = new AbortController();
    try {
      if (turn.chatId !== this.#allowedChatId) {
        // A corrupt durable row must never turn into a foreign chat action.
        // Release by trusted durable id only; the manager resolves its own
        // previously admitted chat mapping and ignores unknown turns.
        try {
          this.#typingLeases?.release(turn.id);
        } catch {
          // Presentation cleanup cannot alter the durable scope rejection.
        }
        const skipped = this.#store.markBotTurnSkipped(
          turn.id,
          this.#workerId,
          "chat_scope_violation",
          this.#now(),
        );
        if (!skipped) {
          return { status: "lease_lost", turnId: turn.id };
        }
        this.#log("error", "bot.turn.chat_scope_rejected", {
          turnId: turn.id,
        });
        return {
          status: "skipped",
          turnId: turn.id,
          reason: "chat_scope",
        };
      }

      // Queue admission starts the chat-level heartbeat before worker claim.
      // Claim its reference immediately after scope validation so every later
      // terminal path releases exactly this durable turn without trusting an
      // unvalidated chat id.
      if (this.#typingLeases) {
        typing = this.#typingLeases.claim({
          turnId: turn.id,
          chatId: turn.chatId,
        });
      } else if (this.#typingPort) {
        typing = startTypingHeartbeat({
          port: this.#typingPort,
          chatId: turn.chatId,
          intervalMs: this.#typingIntervalMs,
          scheduler: this.#scheduler,
          signal: controller.signal,
          onFirstSuccess: () => {
            this.#log("info", "bot.typing.sent", { turnId: turn.id });
          },
          onFirstFailure: (code) => {
            this.#log("warn", "bot.typing.failed", { turnId: turn.id, code });
          },
        });
      }

      const loaded = loadBotTurn(this.#store, turn);
      if (!loaded) {
        if (!this.#failClaimedTurn(turn, "load", "trigger_not_found")) {
          return { status: "lease_lost", turnId: turn.id };
        }
        return { status: "failed", turnId: turn.id, stage: "load" };
      }

      const admission = this.#coordinator.startTurn({
        turnId: coordinatorTurnId,
        ownerSenderId: loaded.trigger.senderId ?? `unknown:${turn.id}`,
      });
      if (!admission.accepted) {
        if (
          !this.#failClaimedTurn(
            turn,
            "coordinator",
            admission.reason,
          )
        ) {
          return { status: "lease_lost", turnId: turn.id };
        }
        return {
          status: "failed",
          turnId: turn.id,
          stage: "coordinator",
        };
      }
      coordinatorStarted = true;
      seedBotTurnReplay(
        this.#coordinator,
        coordinatorTurnId,
        loaded.replay,
      );

      const toolProgress = this.#toolProgressBotApiPort
        ? new ToolProgressPublisher({
            turnId: turn.id,
            workerId: this.#workerId,
            chatId: turn.chatId,
            signal: controller.signal,
            botApi: this.#toolProgressBotApiPort,
            store: this.#store,
            initialMessageId: turn.progressMessageId,
            now: this.#now,
          })
        : undefined;
      timers = startTurnTimers({
        store: this.#store,
        turn,
        workerId: this.#workerId,
        leaseMs: this.#leaseMs,
        heartbeatMs: this.#heartbeatMs,
        scheduler: this.#scheduler,
        now: this.#now,
        controller,
      });
      const { drainFold } = createTurnFoldCollector(
        this.#coordinator,
        coordinatorTurnId,
      );

      if (toolProgress) {
        await toolProgress.recoverPrevious(controller.signal);
      }

      const resumedDraft = validSavedDraft(turn.draftText);
      let final: BotAgentFinalResult | undefined;
      if (resumedDraft === undefined) {
        try {
          final = await Promise.race([
            this.#agent.run({
              turn: Object.freeze({ ...turn }),
              trigger: Object.freeze({ ...loaded.trigger }),
              ...(loaded.replyTarget === undefined
                ? {}
                : { replyTarget: Object.freeze({ ...loaded.replyTarget }) }),
              context: loaded.context.map((message) =>
                Object.freeze({ ...message }),
              ),
              signal: controller.signal,
              drainFold,
              toolProgressPort: toolProgress,
            }),
            timers.interruption,
          ]);
        } catch (error) {
          timers.stop();
          if (timers.leaseLost) {
            this.#log("warn", "bot.turn.lease_lost", { turnId: turn.id });
            return { status: "lease_lost", turnId: turn.id };
          }
          if (
            !this.#failClaimedTurn(
              turn,
              "agent",
              safeErrorCode(error),
            )
          ) {
            return { status: "lease_lost", turnId: turn.id };
          }
          await finishToolProgress(toolProgress, controller.signal);
          return { status: "failed", turnId: turn.id, stage: "agent" };
        }

        if (timers.leaseLost) {
          timers.stop();
          return { status: "lease_lost", turnId: turn.id };
        }
        if (!isAgentFinal(final)) {
          timers.stop();
          if (
            !this.#failClaimedTurn(
              turn,
              "agent",
              "invalid_final_protocol",
            )
          ) {
            return { status: "lease_lost", turnId: turn.id };
          }
          await finishToolProgress(toolProgress, controller.signal);
          return { status: "failed", turnId: turn.id, stage: "agent" };
        }
      }

      const draftText = resumedDraft ?? final!.text;
      // Defend the durable worker boundary independently of the production
      // Responses agent. Other BotTurnAgent implementations must not be able to
      // persist or publish an unbounded final either.
      if (!isBotAgentFinalReplyWithinLimit(draftText)) {
        timers.stop();
        if (
          !this.#failClaimedTurn(
            turn,
            "agent",
            "final_reply_too_large",
          )
        ) {
          return { status: "lease_lost", turnId: turn.id };
        }
        await finishToolProgress(toolProgress, controller.signal);
        return { status: "failed", turnId: turn.id, stage: "agent" };
      }

      // The progress message is presentation-only and must not outlive the
      // final output, including a shadow turn.
      try {
        await toolProgress?.finish(controller.signal);
      } catch {
        // A persisted fence lets the next attempt recover a failed cleanup.
      }

      const publication: TelegramPublication = createTelegramPublication(
        draftText,
        final?.responseOrigin,
      );

      if (
        !this.#store.saveBotTurnDraft(
          turn.id,
          this.#workerId,
          draftText,
          this.#now(),
        )
      ) {
        timers.stop();
        return { status: "lease_lost", turnId: turn.id };
      }

      if (this.#mode === "shadow") {
        timers.stop();
        if (
          !this.#store.markBotTurnSkipped(
            turn.id,
            this.#workerId,
            "shadow_mode",
            this.#now(),
          )
        ) {
          return { status: "lease_lost", turnId: turn.id };
        }
        this.#log("info", "bot.turn.skipped", {
          turnId: turn.id,
          reason: "shadow",
          publication: publication.mode,
        });
        return { status: "skipped", turnId: turn.id, reason: "shadow" };
      }

      // From here on no durable lease timer may mutate or abort the turn. The
      // `sending` row is the unknown-delivery fence. Native typing is purely
      // presentational, so keep it alive until publisher ACK/timeout; otherwise
      // a slow rich send leaves a blank header after progress cleanup.
      timers.stop();
      if (
        !this.#store.markBotTurnSending(
          turn.id,
          this.#workerId,
          this.#now(),
        )
      ) {
        return { status: "lease_lost", turnId: turn.id };
      }
      reachedSending = true;
      return await dispatchBotTurn(
        {
          store: this.#store,
          publisher: this.#publisher,
          allowedChatId: this.#allowedChatId,
          publishTimeoutMs: this.#publishTimeoutMs,
          scheduler: this.#scheduler,
          logger: this.#logger,
          now: this.#now,
        },
        turn,
        loaded.trigger,
        publication,
      );
    } catch (error) {
      timers?.stop();
      if (reachedSending) {
        markBotTurnLostAck(
          { store: this.#store, logger: this.#logger, now: this.#now },
          turn,
          `worker_exception:${safeErrorCode(error)}`,
        );
        return { status: "lost_ack", turnId: turn.id };
      }
      if (!this.#failClaimedTurn(turn, "agent", safeErrorCode(error))) {
        return { status: "lease_lost", turnId: turn.id };
      }
      return { status: "failed", turnId: turn.id, stage: "agent" };
    } finally {
      typing?.stop();
      timers?.stop();
      if (coordinatorStarted) {
        this.#coordinator.completeTurn(coordinatorTurnId);
      }
    }
  }

  #failClaimedTurn(
    turn: StoredBotTurn,
    stage: "load" | "agent" | "coordinator",
    code: string,
  ): boolean {
    let transitioned = false;
    try {
      transitioned = this.#store.markBotTurnFailed(
        turn.id,
        this.#workerId,
        `${stage}:${code}`,
        this.#now(),
      );
    } finally {
      this.#log("error", "bot.turn.failed", {
        turnId: turn.id,
        stage,
        code,
      });
    }
    return transitioned;
  }

  async #cleanupTerminalProgress(): Promise<BotTurnWorkerResult | undefined> {
    if (!this.#toolProgressBotApiPort) {
      return undefined;
    }
    const nowMs = this.#now();
    if (this.#nextProgressCleanupAtMs > nowMs) {
      return undefined;
    }
    const candidate = this.#store.getNextBotTurnProgressCleanup(
      this.#allowedChatId,
    );
    const messageId = candidate?.progressMessageId;
    if (candidate === undefined || messageId === undefined) {
      return undefined;
    }
    try {
      const result = await this.#toolProgressBotApiPort.deleteMessage(
        candidate.chatId,
        messageId,
        new AbortController().signal,
      );
      const terminalRefusal = !result.ok && result.terminal === true;
      if (result.ok || terminalRefusal) {
        this.#store.clearTerminalBotTurnProgressIfMatches(
          candidate.id,
          messageId,
          nowMs,
        );
        this.#nextProgressCleanupAtMs = 0;
        this.#log("info", terminalRefusal
          ? "bot.progress.abandoned"
          : "bot.progress.cleaned", {
          turnId: candidate.id,
          ...(terminalRefusal ? { reason: "permanent_delete_refusal" } : {}),
        });
        return { status: "progress_cleaned", turnId: candidate.id };
      }
    } catch {
      // A failed presentation cleanup must not affect future chat turns.
    }
    this.#nextProgressCleanupAtMs = nowMs + PROGRESS_CLEANUP_RETRY_MS;
    this.#log("warn", "bot.progress.cleanup_failed", {
      turnId: candidate.id,
    });
    return { status: "idle", retryAfterMs: PROGRESS_CLEANUP_RETRY_MS };
  }

  #progressCleanupRetryAfter(nowMs: number): number | undefined {
    return this.#nextProgressCleanupAtMs > nowMs
      ? this.#nextProgressCleanupAtMs - nowMs
      : undefined;
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...fields });
    } catch {
      // Logging must never alter durable turn state.
    }
  }
}

function earliestRetryAfter(
  ...values: Array<number | undefined>
): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length === 0 ? undefined : Math.min(...known);
}

/** A terminal owned turn may remove its presentation bubble; lease loss may not. */
async function finishToolProgress(
  toolProgress: ToolProgressPublisher | undefined,
  signal: AbortSignal,
): Promise<void> {
  try {
    await toolProgress?.finish(signal);
  } catch {
    // The persisted progress fence remains for the next claimed attempt.
  }
}

function validSavedDraft(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
