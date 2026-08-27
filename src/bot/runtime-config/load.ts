import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { BotRuntimeConfig, BotRuntimeEnvironment, SafeBotRuntimeConfig } from "./contracts.js";
import {
  parseBotResponsesRuntimeConfig,
  safeBotResponsesRuntimeConfig,
} from "../responses/runtime-config.js";
import { parseBotRagRuntimeConfig } from "../responses/rag-runtime-config.js";

export function parseBotRuntimeConfig(env: BotRuntimeEnvironment): BotRuntimeConfig {
  const dbPath = absoluteFilePath(required(env, "PARILKA_BOT_DB_PATH"), "PARILKA_BOT_DB_PATH", false);
  const sharedDbPath = optional(env, "TELEGRAM_DB_PATH");
  if (sharedDbPath !== undefined && resolve(sharedDbPath) !== dbPath) {
    throw new Error("PARILKA_BOT_DB_PATH and TELEGRAM_DB_PATH must name the same shared SQLite file.");
  }
  const pollBackoffInitialMs = integer(env, "PARILKA_BOT_POLL_BACKOFF_INITIAL_MS", 1_000, 10, 60_000);
  const pollBackoffMaxMs = integer(env, "PARILKA_BOT_POLL_BACKOFF_MAX_MS", 30_000, pollBackoffInitialMs, 300_000);
  const mode = optional(env, "PARILKA_BOT_MODE") ?? "shadow";
  if (mode !== "live" && mode !== "shadow") {
    throw new Error("PARILKA_BOT_MODE must be live or shadow.");
  }
  const responses = parseBotResponsesRuntimeConfig(env);
  const rag = parseBotRagRuntimeConfig(env);
  const token = tokenFromEnvironment(env);
  if (!/^\d{1,16}:[A-Za-z0-9_-]{20,}$/u.test(token)) {
    throw new Error("PARILKA_BOT_TOKEN has an invalid Bot API token shape.");
  }
  if (optional(env, "PARILKA_BOT_EXCLUSIVE_POLLER") !== "true") {
    throw new Error("PARILKA_BOT_EXCLUSIVE_POLLER must be exactly true after every other getUpdates poller is stopped.");
  }
  return {
    token,
    allowedChatId: telegramChatId(required(env, "PARILKA_BOT_CHAT_ID"), "PARILKA_BOT_CHAT_ID"),
    botId: positiveTelegramId(required(env, "PARILKA_BOT_ID"), "PARILKA_BOT_ID"),
    botUsername: botUsername(required(env, "PARILKA_BOT_USERNAME")),
    dbPath,
    mode,
    // A chat's messages must retain their delivery order, including while a
    // Responses turn makes sequential local-tool continuations.
    workerConcurrency: integer(env, "PARILKA_BOT_WORKERS", 1, 1, 1),
    triggerCooldownMs: integer(env, "PARILKA_BOT_TRIGGER_COOLDOWN_MS", 5_000, 0, 60_000),
    updateMaxAttempts: integer(env, "PARILKA_BOT_UPDATE_MAX_ATTEMPTS", 3, 1, 20),
    ...(optional(env, "PARILKA_BOT_INITIAL_OFFSET") === undefined ? {} : {
      initialOffset: integer(env, "PARILKA_BOT_INITIAL_OFFSET", 0, 0, Number.MAX_SAFE_INTEGER - 1),
    }),
    pollTimeoutSec: integer(env, "PARILKA_BOT_POLL_TIMEOUT_SEC", 30, 1, 50),
    pollLimit: integer(env, "PARILKA_BOT_POLL_LIMIT", 100, 1, 100),
    pollBackoffInitialMs,
    pollBackoffMaxMs,
    publishTimeoutMs: integer(env, "PARILKA_BOT_PUBLISH_TIMEOUT_MS", 30_000, 1_000, 300_000),
    shutdownTimeoutMs: integer(env, "PARILKA_BOT_SHUTDOWN_TIMEOUT_MS", 660_000, 1_000, 900_000),
    responses,
    rag,
  };
}

export function safeBotRuntimeConfig(config: BotRuntimeConfig): SafeBotRuntimeConfig {
  return {
    allowedChatId: config.allowedChatId,
    botId: config.botId,
    botUsername: config.botUsername,
    dbPath: config.dbPath,
    mode: config.mode,
    workerConcurrency: config.workerConcurrency,
    pollTimeoutSec: config.pollTimeoutSec,
    pollLimit: config.pollLimit,
    responses: safeBotResponsesRuntimeConfig(config.responses),
    rag: {
      backend: "local_bge_m3",
      localEndpoint: config.rag.vector.embeddings.localEndpoint,
      localRequestTimeoutMs: config.rag.vector.embeddings.localRequestTimeoutMs,
      rerankTimeoutMs: config.rag.vector.embeddings.rerankTimeoutMs,
      rerankMaxCandidates: config.rag.rerankMaxCandidates,
      automaticTimeoutMs: config.rag.automaticTimeoutMs,
    },
  };
}

function tokenFromEnvironment(env: BotRuntimeEnvironment): string {
  const direct = optional(env, "PARILKA_BOT_TOKEN");
  const file = optional(env, "PARILKA_BOT_TOKEN_FILE");
  if (direct !== undefined && file !== undefined) {
    throw new Error("Set exactly one of PARILKA_BOT_TOKEN or PARILKA_BOT_TOKEN_FILE.");
  }
  if (direct !== undefined) return direct;
  if (file === undefined) throw new Error("PARILKA_BOT_TOKEN or PARILKA_BOT_TOKEN_FILE is required.");
  const path = absoluteFilePath(file, "PARILKA_BOT_TOKEN_FILE", true);
  const beforeOpen = lstatSync(path);
  const uid = process.getuid?.();
  if (uid === undefined || beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || beforeOpen.uid !== uid) {
    throw new Error("PARILKA_BOT_TOKEN_FILE must be an owner-owned regular non-symlink file.");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.uid !== uid) {
      throw new Error("PARILKA_BOT_TOKEN_FILE must be an owner-owned regular non-symlink file.");
    }
    if ((metadata.mode & 0o777) !== 0o400 && (metadata.mode & 0o777) !== 0o600) {
      throw new Error("PARILKA_BOT_TOKEN_FILE must have mode 0400 or 0600.");
    }
    if (metadata.size < 1 || metadata.size > 4_096) throw new Error("PARILKA_BOT_TOKEN_FILE must be a bounded one-line file.");
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  if (!/^[^\r\n]+(?:\n)?$/u.test(raw)) throw new Error("PARILKA_BOT_TOKEN_FILE must contain one token line.");
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function required(env: BotRuntimeEnvironment, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new Error(`${name} is required.`);
  return value;
}
function optional(env: BotRuntimeEnvironment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}
function integer(env: BotRuntimeEnvironment, name: string, fallback: number, min: number, max: number): number {
  const raw = optional(env, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
function absoluteFilePath(value: string, name: string, mustExist: boolean): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  const path = resolve(value);
  if (mustExist) {
    let stat;
    try { stat = statSync(path); } catch { throw new Error(`${name} must be an existing regular file.`); }
    if (!stat.isFile()) throw new Error(`${name} must be an existing regular file.`);
  }
  return path;
}
function positiveTelegramId(value: string, name: string): string {
  if (!/^\d+$/u.test(value) || BigInt(value) < 1n || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} must be a positive Telegram id.`);
  return BigInt(value).toString();
}
function telegramChatId(value: string, name: string): string {
  if (!/^-?\d+$/u.test(value)) throw new Error(`${name} must be a Telegram chat id.`);
  return BigInt(value).toString();
}
function botUsername(value: string): string {
  const normalized = value.replace(/^@/u, "");
  if (!/^[A-Za-z0-9_]{5,32}$/u.test(normalized)) throw new Error("PARILKA_BOT_USERNAME must be a valid Telegram username.");
  return normalized;
}
