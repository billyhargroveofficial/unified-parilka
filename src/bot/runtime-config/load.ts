import type {
  BotRuntimeConfig,
  BotRuntimeEnvironment,
} from "./contracts.js";
import {
  absolutePath,
  boundedPlain,
  enumValue,
  existingAbsoluteFile,
  integer,
  normalizeBotUsername,
  requiredPlain,
  requiredSecret,
  sameConfiguredFile,
  telegramId,
  telegramIdList,
} from "./env-rules.js";
import { optionalResearchGatewayConfig } from "./research-gateway.js";
import { audioTranscribeConfig } from "./audio-transcribe.js";
import { requireLoopbackHttpOrigin } from "../web-tools/url-validation.js";
import {
  assertBotTokenShape,
  assertExclusivePoller,
  validateBotRuntimeRelationships,
} from "./validation.js";
import { optionalWebSearchConfig } from "./web-search.js";

const DEFAULT_SHARED_DB_PATH =
  "~/.telegram-parilka-mcp/messages.sqlite";

/**
 * Parses only the bot runtime environment. Secret values never appear in
 * validation messages and getUpdates ownership is explicit even in shadow.
 */
export function parseBotRuntimeConfig(
  env: BotRuntimeEnvironment = process.env,
): BotRuntimeConfig {
  const token = requiredSecret(env, "PARILKA_BOT_TOKEN");
  assertBotTokenShape(token);
  assertExclusivePoller(env);

  const allowedChatId = telegramId(
    requiredPlain(env, "PARILKA_BOT_CHAT_ID"),
    "PARILKA_BOT_CHAT_ID",
    "negative",
  );
  const botId = telegramId(
    requiredPlain(env, "PARILKA_BOT_ID"),
    "PARILKA_BOT_ID",
    "positive",
  );
  const botUsername = normalizeBotUsername(
    requiredPlain(env, "PARILKA_BOT_USERNAME"),
  );
  const sharedDbPath = absolutePath(
    env.TELEGRAM_DB_PATH ?? DEFAULT_SHARED_DB_PATH,
    "TELEGRAM_DB_PATH",
  );
  const requestedBotDbPath = absolutePath(
    env.PARILKA_BOT_DB_PATH ?? sharedDbPath,
    "PARILKA_BOT_DB_PATH",
  );
  if (!sameConfiguredFile(requestedBotDbPath, sharedDbPath)) {
    throw new Error(
      "PARILKA_BOT_DB_PATH must resolve to the same shared SQLite file as TELEGRAM_DB_PATH.",
    );
  }
  const mode = enumValue(
    env.PARILKA_BOT_MODE,
    "PARILKA_BOT_MODE",
    ["live", "shadow"] as const,
    "shadow",
  );

  const config: BotRuntimeConfig = {
    token,
    exclusivePollerConfirmed: true,
    allowedChatId,
    botId,
    botUsername,
    botDisplayName: boundedPlain(
      env.PARILKA_BOT_DISPLAY_NAME ?? "Машина",
      "PARILKA_BOT_DISPLAY_NAME",
      128,
    ),
    chatTitle: boundedPlain(
      env.PARILKA_BOT_CHAT_TITLE ??
        "Frontend228 + ML + Math + 1984",
      "PARILKA_BOT_CHAT_TITLE",
      160,
    ),
    historyDescription: boundedPlain(
      env.PARILKA_BOT_HISTORY_DESCRIPTION ??
        "вся доступная локальная история чата",
      "PARILKA_BOT_HISTORY_DESCRIPTION",
      200,
    ),
    ...(env.PARILKA_BOT_APPROXIMATE_MEMBER_COUNT === undefined
      ? {}
      : {
          approximateMemberCount: integer(
            env.PARILKA_BOT_APPROXIMATE_MEMBER_COUNT,
            "PARILKA_BOT_APPROXIMATE_MEMBER_COUNT",
            1,
            1,
            10_000_000,
          ),
        }),
    memoryWriteAuthorizerIds: telegramIdList(
      env.PARILKA_BOT_MEMORY_WRITE_SENDER_IDS,
      "PARILKA_BOT_MEMORY_WRITE_SENDER_IDS",
      16,
    ),
    // Always return the common spelling, including hard-link aliases.
    dbPath: sharedDbPath,
    modelConfigPath: existingAbsoluteFile(
      requiredPlain(env, "PARILKA_BOT_MODEL_CONFIG_PATH"),
      "PARILKA_BOT_MODEL_CONFIG_PATH",
    ),
    ...optionalWebSearchConfig(env),
    ...optionalResearchGatewayConfig(env),
    audioTranscribe: audioTranscribeConfig(env),
    searxngEndpoint: requireLoopbackHttpOrigin(
      env.PARILKA_BOT_SEARXNG_ENDPOINT ?? "http://127.0.0.1:8080",
    ),
    firecrawlEndpoint: requireLoopbackHttpOrigin(
      env.PARILKA_BOT_FIRECRAWL_ENDPOINT ?? "http://127.0.0.1:3002",
    ),
    mode,
    workerConcurrency: integer(
      env.PARILKA_BOT_WORKERS,
      "PARILKA_BOT_WORKERS",
      3,
      1,
      3,
    ),
    triggerCooldownMs: integer(
      env.PARILKA_BOT_TRIGGER_COOLDOWN_MS,
      "PARILKA_BOT_TRIGGER_COOLDOWN_MS",
      5_000,
      0,
      60_000,
    ),
    updateMaxAttempts: integer(
      env.PARILKA_BOT_UPDATE_MAX_ATTEMPTS,
      "PARILKA_BOT_UPDATE_MAX_ATTEMPTS",
      3,
      1,
      20,
    ),
    ...(env.PARILKA_BOT_INITIAL_OFFSET === undefined
      ? {}
      : {
          initialOffset: integer(
            env.PARILKA_BOT_INITIAL_OFFSET,
            "PARILKA_BOT_INITIAL_OFFSET",
            0,
            0,
            Number.MAX_SAFE_INTEGER - 1,
          ),
        }),
    pollTimeoutSec: integer(
      env.PARILKA_BOT_POLL_TIMEOUT_SEC,
      "PARILKA_BOT_POLL_TIMEOUT_SEC",
      30,
      1,
      50,
    ),
    pollLimit: integer(
      env.PARILKA_BOT_POLL_LIMIT,
      "PARILKA_BOT_POLL_LIMIT",
      100,
      1,
      100,
    ),
    pollBackoffInitialMs: integer(
      env.PARILKA_BOT_POLL_BACKOFF_INITIAL_MS,
      "PARILKA_BOT_POLL_BACKOFF_INITIAL_MS",
      1_000,
      10,
      60_000,
    ),
    pollBackoffMaxMs: integer(
      env.PARILKA_BOT_POLL_BACKOFF_MAX_MS,
      "PARILKA_BOT_POLL_BACKOFF_MAX_MS",
      30_000,
      10,
      5 * 60_000,
    ),
    modelStepTimeoutMs: integer(
      env.PARILKA_BOT_MODEL_STEP_TIMEOUT_MS,
      "PARILKA_BOT_MODEL_STEP_TIMEOUT_MS",
      180_000,
      1_000,
      15 * 60_000,
    ),
    publishTimeoutMs: integer(
      env.PARILKA_BOT_PUBLISH_TIMEOUT_MS,
      "PARILKA_BOT_PUBLISH_TIMEOUT_MS",
      30_000,
      1_000,
      5 * 60_000,
    ),
    shutdownTimeoutMs: integer(
      env.PARILKA_BOT_SHUTDOWN_TIMEOUT_MS,
      "PARILKA_BOT_SHUTDOWN_TIMEOUT_MS",
      660_000,
      1_000,
      15 * 60_000,
    ),
  };
  validateBotRuntimeRelationships(config);
  return config;
}
