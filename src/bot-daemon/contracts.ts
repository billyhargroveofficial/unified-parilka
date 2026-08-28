import type { Api } from "grammy";
import type { AppConfig } from "../config.js";
import type {
  AiSdkBotTurnAgent,
  TurnModelRouter,
} from "../bot/ai-agent.js";
import type {
  BotVectorSearchPort,
  CanonicalBotReadCache,
} from "../bot/read-cache.js";
import type {
  BotReadTools,
  ResearchGatewayProvider,
  WebSearchProvider,
} from "../bot/read-tools.js";
import type { BotMemoryTools } from "../bot/memory-tools.js";
import type { BotMediaTools } from "../bot/media-tools.js";
import type {
  BotApiLongPoller,
  BotApiRuntime,
  BotUpdateProcessor,
  BotWorkerDrainResult,
  BotWorkerPump,
} from "../bot/runtime.js";
import type {
  BotRuntimeConfig,
  BotResearchGatewayRuntimeConfig,
  BotWebSearchRuntimeConfig,
} from "../bot/runtime-config.js";
import type { TurnCoordinator } from "../bot/turn-coordinator.js";
import type {
  BotTurnWorker,
  JsonEventLogger,
} from "../bot/worker.js";
import type { MessageStore } from "../store.js";

export type BotDaemonApi = Pick<
  Api,
  | "getMe"
  | "deleteWebhook"
  | "getUpdates"
  | "getFile"
  | "sendMessage"
  | "sendRichMessage"
  | "sendChatAction"
  | "editMessageText"
  | "deleteMessage"
>;

export interface ComposeBotDaemonOptions {
  config: Readonly<BotRuntimeConfig>;
  store: MessageStore;
  api: BotDaemonApi;
  router: TurnModelRouter;
  vector?: BotVectorSearchPort;
  webSearch?: WebSearchProvider;
  researchGateway?: ResearchGatewayProvider;
  appConfig?: Readonly<AppConfig>;
  logger?: JsonEventLogger;
  workerIdPrefix?: string;
}

export interface BotDaemonComposition {
  runtime: BotApiRuntime;
  poller: BotApiLongPoller;
  workerPump: BotWorkerPump;
  workers: readonly BotTurnWorker[];
  processor: BotUpdateProcessor;
  coordinator: TurnCoordinator;
  cache: CanonicalBotReadCache;
  readTools: BotReadTools;
  mediaTools: BotMediaTools;
  memoryTools: BotMemoryTools;
  agent: AiSdkBotTurnAgent;
}

export interface ProductionBotDaemonFactories {
  createApi(token: string): BotDaemonApi;
  createStore(path: string): MessageStore;
  createRouter(
    path: string,
    env: Readonly<Record<string, string | undefined>>,
  ): TurnModelRouter;
  createVector(
    config: AppConfig,
    store: MessageStore,
  ): BotVectorSearchPort & { readonly isConfigured: boolean };
  createWebSearch(
    config: Readonly<BotWebSearchRuntimeConfig>,
  ): WebSearchProvider;
  createResearchGateway(
    config: Readonly<BotResearchGatewayRuntimeConfig>,
  ): ResearchGatewayProvider;
}

export interface CreateProductionBotDaemonOptions {
  env?: Readonly<Record<string, string | undefined>>;
  appConfig?: AppConfig;
  logger?: JsonEventLogger;
  factories?: Partial<ProductionBotDaemonFactories>;
  workerIdPrefix?: string;
}

export interface ProductionBotDaemon extends BotDaemonComposition {
  config: BotRuntimeConfig;
  appConfig: AppConfig;
  store: MessageStore;
  logger?: JsonEventLogger;
  vectorEnabled: boolean;
  webSearchEnabled: boolean;
  researchGatewayEnabled: boolean;
  activeWorkerCount(): number;
  close(): void;
}

export interface BotDaemonRuntimePort {
  run(signal?: AbortSignal): Promise<BotWorkerDrainResult>;
  requestStop(): void;
}

export interface BotDaemonLifecycleTarget {
  runtime: BotDaemonRuntimePort;
  activeWorkerCount?(): number;
  close(): void;
  logger?: JsonEventLogger;
}

export interface BotDaemonSignalSource {
  once(
    event: "SIGINT" | "SIGTERM",
    listener: (signal: NodeJS.Signals) => void,
  ): unknown;
  off(
    event: "SIGINT" | "SIGTERM",
    listener: (signal: NodeJS.Signals) => void,
  ): unknown;
}
