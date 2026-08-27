export type BotRuntimeMode = "live" | "shadow";

/** Environment is deliberately narrow so tests can never inherit secrets. */
export type BotRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface BotRuntimeConfig {
  readonly token: string;
  readonly allowedChatId: string;
  readonly botId: string;
  readonly botUsername: string;
  readonly dbPath: string;
  readonly mode: BotRuntimeMode;
  readonly workerConcurrency: number;
  readonly triggerCooldownMs: number;
  readonly updateMaxAttempts: number;
  readonly initialOffset?: number;
  readonly pollTimeoutSec: number;
  readonly pollLimit: number;
  readonly pollBackoffInitialMs: number;
  readonly pollBackoffMaxMs: number;
  readonly publishTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly responses: BotResponsesRuntimeConfig;
  readonly rag: BotRagRuntimeConfig;
}

/** Safe for journal output: it deliberately omits the Bot API token. */
export interface SafeBotRuntimeConfig {
  readonly allowedChatId: string;
  readonly botId: string;
  readonly botUsername: string;
  readonly dbPath: string;
  readonly mode: BotRuntimeMode;
  readonly workerConcurrency: number;
  readonly pollTimeoutSec: number;
  readonly pollLimit: number;
  readonly responses: SafeBotResponsesRuntimeConfig;
  readonly rag: {
    readonly backend: "local_bge_m3";
    readonly localEndpoint: string;
    readonly localRequestTimeoutMs: number;
    readonly rerankTimeoutMs: number;
    readonly rerankMaxCandidates: number;
    readonly automaticTimeoutMs: number;
  };
}
import type {
  BotResponsesRuntimeConfig,
  SafeBotResponsesRuntimeConfig,
} from "../responses/runtime-config.js";
import type { BotRagRuntimeConfig } from "../responses/rag-runtime-config.js";
