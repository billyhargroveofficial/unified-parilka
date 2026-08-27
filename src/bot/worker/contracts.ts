import type {
  MessageStore,
  StoredBotTurn,
} from "../../store.js";
import type { TurnCoordinator } from "../turn-coordinator.js";
import type {
  BotAgentFinalResult,
  BotAgentRequest,
  BotTurnAgent,
} from "../agent-contract.js";
import type { TelegramPublication } from "../telegram-publication.js";
import type {
  ToolProgressBotApiPort,
  ToolProgressPort,
} from "../tool-progress.js";
import type { TypingPort } from "../typing.js";
import type { TypingLeaseManager } from "../typing.js";

export const BOT_CONTEXT_MESSAGES = 60;
export const BOT_REPLAY_MESSAGES = 100;

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_HEARTBEAT_MS = 10_000;
export const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;
/** Terminal presentation cleanup is best-effort and must never busy-loop. */
export const PROGRESS_CLEANUP_RETRY_MS = 5_000;
export type { BotAgentFinalResult, BotAgentRequest, BotTurnAgent };

export interface TelegramPublishRequest {
  chatId: string;
  replyToMessageId: number;
  publication: TelegramPublication;
  signal: AbortSignal;
}

export type TelegramPublisherResult =
  | {
      ok: true;
      chunksSent: number;
      telegramMessageId?: number;
    }
  | {
      ok: false;
      chunksSent: number;
      error:
        | {
            kind: "telegram_rejected";
            code: string;
            retryable: boolean;
            retryAfterMs?: number;
          }
        | {
            kind: "network" | "timeout" | "unknown";
            code?: string;
          };
    };

export interface BotTurnPublisher {
  publish(request: TelegramPublishRequest): Promise<TelegramPublisherResult>;
}

export type { JsonEventLogger } from "../../observability/contracts.js";
import type { JsonEventLogger } from "../../observability/contracts.js";

export interface WorkerScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BotTurnWorkerOptions {
  store: MessageStore;
  coordinator: TurnCoordinator;
  agent: BotTurnAgent;
  publisher: BotTurnPublisher;
  workerId: string;
  allowedChatId: string;
  mode: "live" | "shadow";
  leaseMs?: number;
  heartbeatMs?: number;
  publishTimeoutMs?: number;
  typingPort?: TypingPort;
  /** Queue-level ownership keeps native typing alive before this worker claims. */
  typingLeases?: Pick<TypingLeaseManager, "claim" | "release">;
  typingIntervalMs?: number;
  toolProgressBotApiPort?: ToolProgressBotApiPort;
  logger?: JsonEventLogger;
  scheduler?: WorkerScheduler;
  now?: () => number;
}

export type BotTurnWorkerResult =
  | { status: "idle"; retryAfterMs?: number }
  | { status: "capacity" }
  | { status: "sent"; turnId: number; telegramMessageId?: number }
  | {
      status: "skipped";
      turnId: number;
      reason: "shadow" | "chat_scope";
    }
  | { status: "failed"; turnId: number; stage: "load" | "agent" | "coordinator" }
  | { status: "lease_lost"; turnId: number }
  | {
      status: "dispatch_rejected";
      turnId: number;
      retryable: boolean;
      retryAfterMs?: number;
    }
  | { status: "lost_ack"; turnId: number }
  | { status: "progress_cleaned"; turnId: number };
