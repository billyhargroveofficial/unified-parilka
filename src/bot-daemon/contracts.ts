import type { BotReadTools } from "../bot/read-tools.js";
import type { CanonicalBotReadCache, BotVectorSearchPort } from "../bot/read-cache.js";
import type { CausalRagContextBuilder } from "../bot/causal-rag/index.js";
import type { TelegramImageDownloadApi } from "../bot/media/index.js";
import type { BotApiLongPoller, BotApiRuntime, BotUpdateProcessor, BotWorkerDrainResult, BotWorkerPump, TelegramBotApiPort } from "../bot/runtime.js";
import type { TurnCoordinator } from "../bot/turn-coordinator.js";
import type { BotTurnWorker, JsonEventLogger } from "../bot/worker.js";
import type { BotTurnAgent } from "../bot/agent-contract.js";
import type { BotRuntimeConfig, BotRuntimeEnvironment } from "../bot/runtime-config.js";
import type { MessageStore } from "../store.js";

export type BotDaemonApi = TelegramBotApiPort & {
  /** Releases production HTTP pools after polling and workers have drained. */
  close?(): Promise<void>;
} & Partial<TelegramImageDownloadApi>;

export type ClosableBotTurnAgent = BotTurnAgent & {
  close(): Promise<void>;
};

export interface BotAgentCompositionContext {
  readonly store: MessageStore;
  readonly api: BotDaemonApi;
  readonly cache: CanonicalBotReadCache;
  readonly readTools: BotReadTools;
  readonly causalRag: CausalRagContextBuilder;
}

export interface ComposeBotDaemonOptions {
  readonly config: BotRuntimeConfig;
  readonly store: MessageStore;
  readonly api: BotDaemonApi;
  readonly createAgent: (context: BotAgentCompositionContext) => ClosableBotTurnAgent;
  readonly vector?: BotVectorSearchPort;
  readonly logger?: JsonEventLogger;
  readonly workerIdPrefix?: string;
}

export interface BotDaemonComposition {
  readonly runtime: BotApiRuntime;
  readonly poller: BotApiLongPoller;
  readonly workerPump: BotWorkerPump;
  readonly workers: readonly BotTurnWorker[];
  readonly processor: BotUpdateProcessor;
  readonly coordinator: TurnCoordinator;
  readonly cache: CanonicalBotReadCache;
  readonly readTools: BotReadTools;
  readonly causalRag: CausalRagContextBuilder;
  readonly agent: ClosableBotTurnAgent;
  close(): Promise<void>;
}

export interface ProductionBotDaemonFactories {
  readonly createApi: (token: string, store: MessageStore, config: BotRuntimeConfig) => BotDaemonApi;
  readonly createStore: (path: string) => MessageStore;
  readonly createAgent: (context: BotAgentCompositionContext, config: BotRuntimeConfig) => ClosableBotTurnAgent;
  readonly createVector?: (store: MessageStore, config: BotRuntimeConfig) => BotVectorSearchPort | undefined;
  readonly preflight?: (config: BotRuntimeConfig) => void;
}

export interface CreateProductionBotDaemonOptions {
  readonly env?: BotRuntimeEnvironment;
  readonly logger?: JsonEventLogger;
  readonly factories?: Partial<ProductionBotDaemonFactories>;
  readonly workerIdPrefix?: string;
}

export interface ProductionBotDaemon extends BotDaemonComposition {
  readonly config: BotRuntimeConfig;
  readonly store: MessageStore;
  readonly logger?: JsonEventLogger;
  activeWorkerCount(): number;
}

export interface BotDaemonRuntimePort {
  run(signal?: AbortSignal): Promise<BotWorkerDrainResult>;
  requestStop(): void;
}

export interface BotDaemonLifecycleTarget {
  readonly runtime: BotDaemonRuntimePort;
  activeWorkerCount?(): number;
  close(): void | Promise<void>;
  readonly logger?: JsonEventLogger;
}

export interface BotDaemonSignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: (signal: NodeJS.Signals) => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: (signal: NodeJS.Signals) => void): unknown;
}
