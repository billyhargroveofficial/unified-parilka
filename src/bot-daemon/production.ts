import { BotMediaTools } from "../bot/media-tools.js";
import type { TelegramImageDownloadApi } from "../bot/media/index.js";
import { assertBotCodexAuthFile } from "../bot/responses/runtime-config.js";
import { NativeTelegramBotApi } from "../bot/telegram-bot-api.js";
import { createTelegramHttpLanes } from "../bot/telegram-http.js";
import { parseBotRuntimeConfig, type BotRuntimeConfig } from "../bot/runtime-config.js";
import {
  CodexSubscriptionAuthStore,
  CodexSubscriptionResponsesTransport,
  CodexSubscriptionUsageClient,
  OpenAiResponsesTurnClient,
} from "../openai-responses/index.js";
import { MessageStore } from "../store.js";
import { VectorRag } from "../vector-rag.js";
import { composeBotDaemon } from "./composition.js";
import type {
  BotDaemonApi,
  BotDaemonComposition,
  CreateProductionBotDaemonOptions,
  ProductionBotDaemon,
  ProductionBotDaemonFactories,
} from "./contracts.js";
import { ResponsesBotTurnAgent } from "./responses-agent.js";

/** Builds direct Responses adapters only; Bot API polling begins later in the lifecycle. */
export function createProductionBotDaemon(options: CreateProductionBotDaemonOptions = {}): ProductionBotDaemon {
  const config = parseBotRuntimeConfig(options.env ?? process.env);
  const factories: ProductionBotDaemonFactories = { ...DEFAULT_FACTORIES, ...options.factories };
  // Validate the owner-only credential before acquiring SQLite or Telegram
  // resources. The network model-access probe remains the explicit CLI
  // `--preflight`, so normal composition stays synchronous and inert.
  factories.preflight?.(config);
  let store: MessageStore | undefined;
  let api: BotDaemonApi | undefined;
  let composition: BotDaemonComposition | undefined;
  let closed: Promise<void> | undefined;
  try {
    store = factories.createStore(config.dbPath);
    store.reconcileActiveSendsOnStartup();
    store.reconcileDreamPublicationsOnStartup();
    api = factories.createApi(config.token, store, config);
    composition = composeBotDaemon({
      config,
      store,
      api,
      createAgent: (context) => factories.createAgent(context, config),
      ...(factories.createVector === undefined ? {} : (() => {
        const vector = factories.createVector?.(store!, config);
        return vector === undefined ? {} : { vector };
      })()),
      logger: options.logger,
      workerIdPrefix: options.workerIdPrefix,
    });
    const current = composition;
    return {
      ...current,
      config,
      store,
      logger: options.logger,
      activeWorkerCount: () =>
        current.workerPump.activeWorkers +
        current.dreamPublicationWorkerPump.activeWorkers,
      close: async () => {
        if (closed !== undefined) return closed;
        if (
          current.workerPump.activeWorkers > 0 ||
          current.dreamPublicationWorkerPump.activeWorkers > 0
        ) {
          throw new Error("Refusing to close SQLite while Responses bot workers remain active.");
        }
        closed = (async () => {
          try {
            await current.close();
          } finally {
            try {
              await api?.close?.();
            } finally {
              store?.close();
            }
          }
        })();
        return closed;
      },
    };
  } catch (error) {
    void api?.close?.().catch(() => undefined);
    store?.close();
    throw error;
  }
}

/** Synchronous fail-closed check used before daemon resources are acquired. */
export function assertBotDaemonConfiguration(config: BotRuntimeConfig): void {
  assertBotCodexAuthFile(config.responses);
}

const DEFAULT_FACTORIES: ProductionBotDaemonFactories = {
  createApi: (token, store, config) => {
    const http = createTelegramHttpLanes();
    return new NativeTelegramBotApi({
      token,
      fetch: http.actionFetch,
      pollFetch: http.pollFetch,
      close: () => http.close(),
      ownSends: { store, botId: config.botId, botUsername: config.botUsername },
    });
  },
  createStore: (path) => new MessageStore(path),
  createVector: (store, config) => new VectorRag(config.rag.vector, store),
  createAgent: (context, config) => {
    const auth = new CodexSubscriptionAuthStore({
      authFile: config.responses.authFile,
    });
    const responses = new OpenAiResponsesTurnClient(
      new CodexSubscriptionResponsesTransport({
        auth,
        timeoutMs: config.responses.turnTimeoutMs,
      }),
    );
    return new ResponsesBotTurnAgent({
      responses,
      causalRag: context.causalRag,
      media: new BotMediaTools(requireImageDownloadApi(context.api)),
      readTools: context.readTools,
      subscriptionUsage: new CodexSubscriptionUsageClient({ auth }),
      turnTimeoutMs: config.responses.turnTimeoutMs,
    });
  },
  preflight: assertBotDaemonConfiguration,
};

function requireImageDownloadApi(api: BotDaemonApi): TelegramImageDownloadApi {
  if (typeof api.getFile !== "function" || typeof api.downloadFile !== "function") {
    throw new Error("Production Telegram API must support trusted image downloads.");
  }
  return {
    getFile: api.getFile.bind(api),
    downloadFile: api.downloadFile.bind(api),
  };
}
