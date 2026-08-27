import { CanonicalBotReadCache } from "../bot/read-cache.js";
import { BotReadTools } from "../bot/read-tools.js";
import { CausalRagContextBuilder } from "../bot/causal-rag/index.js";
import { DreamPublicationWorker } from "../bot/dream-publication-worker.js";
import { BotApiLongPoller, BotApiRuntime, BotUpdateProcessor, BotWorkerPump, botRuntimeOptions, createTelegramLongPollingApi, createToolProgressTelegramBotApiPort } from "../bot/runtime.js";
import { TurnCoordinator } from "../bot/turn-coordinator.js";
import { ChatTypingLeaseManager } from "../bot/typing.js";
import { BotTurnWorker } from "../bot/worker.js";
import { createBotApiTurnPublisher } from "../bot/grammy-publisher.js";
import type { BotDaemonComposition, ComposeBotDaemonOptions } from "./contracts.js";

/** Construction is side-effect-free: no Bot API or model turn occurs here. */
export function composeBotDaemon(options: ComposeBotDaemonOptions): BotDaemonComposition {
  const { config } = options;
  const workerIdPrefix = requireWorkerIdPrefix(options.workerIdPrefix ?? `bot:${process.pid}`);
  const coordinator = new TurnCoordinator({ maxActiveTurns: config.workerConcurrency, capacityPolicy: "refuse" });
  const cache = new CanonicalBotReadCache({
    store: options.store,
    ...(options.vector === undefined ? {} : { vector: options.vector }),
    logger: options.logger,
    botSenderId: config.botId,
    rerankMaxCandidates: config.rag.rerankMaxCandidates,
  });
  const readTools = new BotReadTools({
    chatId: config.allowedChatId,
    cache,
    skillStore: options.store,
    botSenderId: config.botId,
    timeZone: "Europe/Moscow",
  });
  const causalRag = new CausalRagContextBuilder({
    cache,
    skillIndex: options.store,
    historyTimeoutMs: config.rag.automaticTimeoutMs,
  });
  const agent = options.createAgent({
    store: options.store,
    api: options.api,
    cache,
    readTools,
    causalRag,
  });
  const publisher = createBotApiTurnPublisher(options.api);
  const toolProgressBotApiPort = createToolProgressTelegramBotApiPort(options.api);
  const typingLeases = new ChatTypingLeaseManager({
    port: { sendChatAction: (chatId, signal) => options.api.sendChatAction(chatId, signal) },
    onFirstSuccess: () => { options.logger?.info({ event: "bot.typing.sent" }); },
    onFirstFailure: (code) => { options.logger?.warn({ event: "bot.typing.failed", code }); },
  });
  const workers = Array.from({ length: config.workerConcurrency }, (_value, index) => new BotTurnWorker({
    store: options.store,
    coordinator,
    agent,
    publisher,
    workerId: `${workerIdPrefix}:${index + 1}`,
    allowedChatId: config.allowedChatId,
    mode: config.mode,
    publishTimeoutMs: config.publishTimeoutMs,
    typingLeases,
    toolProgressBotApiPort,
    logger: options.logger,
  }));
  const workerPump = new BotWorkerPump({ workers, logger: options.logger });
  const dreamPublicationWorkerPump = new BotWorkerPump({
    workers: [new DreamPublicationWorker({
      store: options.store,
      telegram: options.api,
      workerId: `${workerIdPrefix}:dream:1`,
      allowedChatId: config.allowedChatId,
      logger: options.logger,
    })],
    logger: options.logger,
  });
  const processor = new BotUpdateProcessor({
    store: options.store,
    coordinator,
    workNotifier: workerPump,
    typingLeases,
    telegram: { allowedChatId: config.allowedChatId, botId: config.botId, botUsername: config.botUsername },
    triggerCooldownMs: config.triggerCooldownMs,
    updateMaxAttempts: config.updateMaxAttempts,
    logger: options.logger,
  });
  const poller = new BotApiLongPoller({
    api: createTelegramLongPollingApi(options.api),
    processor,
    ...botRuntimeOptions({
      botId: config.botId,
      botUsername: config.botUsername,
      ...(config.initialOffset === undefined ? {} : { initialOffset: config.initialOffset }),
      pollTimeoutSec: config.pollTimeoutSec,
      pollLimit: config.pollLimit,
      pollBackoffInitialMs: config.pollBackoffInitialMs,
      pollBackoffMaxMs: config.pollBackoffMaxMs,
    }),
    logger: options.logger,
  });
  const runtime = new BotApiRuntime({ poller, workers: workerPump, maintenanceWorkers: dreamPublicationWorkerPump, typingLeases, shutdownTimeoutMs: config.shutdownTimeoutMs, logger: options.logger });
  return { runtime, poller, workerPump, dreamPublicationWorkerPump, workers, processor, coordinator, cache, readTools, causalRag, agent, close: () => agent.close() };
}

function requireWorkerIdPrefix(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,120}$/u.test(normalized)) throw new TypeError("workerIdPrefix must contain 1-120 machine-safe characters.");
  return normalized;
}
