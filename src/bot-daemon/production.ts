import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Api } from "grammy";
import {
  loadConfig,
  type AppConfig,
} from "../config.js";
import type { BotRuntimeConfig } from "../bot/runtime-config.js";
import { parseBotRuntimeConfig } from "../bot/runtime-config.js";
import { ModelRouter } from "../providers/model-router.js";
import { MessageStore } from "../store.js";
import { VectorRag } from "../vector-rag.js";
import { HttpJsonWebSearchProvider } from "../bot/web-search.js";
import { VertexGeminiWebSearchProvider } from "../bot/web-search-vertex.js";
import { UnixSocketResearchGatewayProvider } from "../bot/read-tools.js";
import { composeBotDaemon } from "./composition.js";
import type {
  BotDaemonComposition,
  CreateProductionBotDaemonOptions,
  ProductionBotDaemon,
  ProductionBotDaemonFactories,
} from "./contracts.js";
import { safeDaemonLog } from "./trace.js";

/**
 * Creates production adapters without beginning long polling. The returned
 * deployment owns its MessageStore and closes it idempotently.
 */
export function createProductionBotDaemon(
  options: CreateProductionBotDaemonOptions = {},
): ProductionBotDaemon {
  if (
    options.env !== undefined &&
    options.env !== process.env &&
    options.appConfig === undefined
  ) {
    throw new Error(
      "A custom bot environment requires an explicit appConfig so shared Telegram settings cannot be read from a different process.env.",
    );
  }
  const env = options.env ?? process.env;
  const config = parseBotRuntimeConfig(env);
  const appConfig = options.appConfig ?? loadConfig();
  assertBotDaemonConfiguration(config, appConfig);
  const factories: ProductionBotDaemonFactories = {
    ...DEFAULT_PRODUCTION_FACTORIES,
    ...options.factories,
  };

  // Provider configuration and referenced secrets fail before SQLite opens.
  const api = factories.createApi(config.token);
  const router = factories.createRouter(config.modelConfigPath, env);
  const webSearch =
    config.webSearch === undefined
      ? undefined
      : factories.createWebSearch(config.webSearch);
  const researchGateway =
    config.researchGateway === undefined
      ? undefined
      : factories.createResearchGateway(config.researchGateway);
  const store = factories.createStore(config.dbPath);
  store.reconcileActiveSendsOnStartup();

  // Evidence-log stuck sending turns from a previous crash.
  // Oracle: НЕ переводить автоматически в lost_ack — allowedChatId не доказывает
  // ownership процесса; другой MCP-процесс может владеть отправкой.
  const stuckSending = store.countStuckSendingTurns(config.allowedChatId);
  if (stuckSending > 0) {
    safeDaemonLog(options.logger, "warn", {
      event: "bot.startup.stuck_sending",
      count: stuckSending,
      chatId: config.allowedChatId,
    });
  }

  let composition: BotDaemonComposition | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    const activeWorkers =
      composition?.workerPump.activeWorkers ?? 0;
    if (activeWorkers > 0) {
      safeDaemonLog(options.logger, "error", {
        event: "bot.runtime.sqlite_close_deferred",
        activeWorkers,
      });
      return;
    }
    closed = true;
    store.close();
  };

  try {
    const vectorCandidate = factories.createVector(
      appConfig,
      store,
    );
    const vector = vectorCandidate.isConfigured
      ? vectorCandidate
      : undefined;
    composition = composeBotDaemon({
      config,
      store,
      api,
      router,
      appConfig,
      ...(vector === undefined ? {} : { vector }),
      ...(webSearch === undefined ? {} : { webSearch }),
      ...(researchGateway === undefined ? {} : { researchGateway }),
      logger: options.logger,
      workerIdPrefix: options.workerIdPrefix,
    });
    return {
      ...composition,
      config,
      appConfig,
      store,
      logger: options.logger,
      vectorEnabled: vector !== undefined,
      webSearchEnabled: webSearch !== undefined,
      researchGatewayEnabled: researchGateway !== undefined,
      activeWorkerCount: () =>
        composition?.workerPump.activeWorkers ?? 0,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Reconciles independently parsed bot and shared application configuration
 * before SQLite is opened.
 */
export function assertBotDaemonConfiguration(
  bot: Readonly<BotRuntimeConfig>,
  app: Readonly<AppConfig>,
): void {
  if (!sameConfiguredFile(bot.dbPath, app.storage.dbPath)) {
    throw new Error(
      "Bot and Telegram services must use the same SQLite database.",
    );
  }
  const allowed = new Set(
    app.telegram.allowedChatIds.map(normalizeTelegramId),
  );
  if (!allowed.has(normalizeTelegramId(bot.allowedChatId))) {
    throw new Error(
      "PARILKA_BOT_CHAT_ID must be present in TELEGRAM_ALLOWED_CHAT_IDS.",
    );
  }
}

const DEFAULT_PRODUCTION_FACTORIES: ProductionBotDaemonFactories = {
  createApi(token) {
    return new Api(token);
  },
  createStore(path) {
    return new MessageStore(path);
  },
  createRouter(path, env) {
    return ModelRouter.fromFile(path, { env });
  },
  createVector(config, store) {
    return new VectorRag(config, store);
  },
  createWebSearch(config) {
    if (config.kind === "vertex") {
      return new VertexGeminiWebSearchProvider(config);
    }
    return new HttpJsonWebSearchProvider({
      endpoint: config.endpoint,
      bearerToken: config.bearerToken,
    });
  },
  createResearchGateway(config) {
    return new UnixSocketResearchGatewayProvider({
      socketPath: config.socketPath,
    });
  },
};

function sameConfiguredFile(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) {
    return true;
  }
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function normalizeTelegramId(value: string): string {
  if (!/^-?\d+$/u.test(value)) {
    throw invalidTelegramAllowlist();
  }
  try {
    return BigInt(value).toString();
  } catch {
    throw invalidTelegramAllowlist();
  }
}

function invalidTelegramAllowlist(): Error {
  return new Error(
    "Telegram allowlist contains a non-integer chat id.",
  );
}
