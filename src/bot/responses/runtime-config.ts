import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { OPENAI_RESPONSES_INTERACTIVE_REASONING_EFFORT } from "../../openai-responses/contracts.js";

const RESPONSES_MODEL = "gpt-5.6-luna" as const;
/** `fast` is requested; the subscription backend reports the effective tier as `priority`. */
const RESPONSES_SERVICE_TIER = "fast" as const;
const RESPONSES_REASONING_EFFORT = OPENAI_RESPONSES_INTERACTIVE_REASONING_EFFORT;

export type BotResponsesRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Direct Codex subscription runtime contract. OAuth state is shared with the
 * user's Codex sign-in, while this daemon speaks the Responses stream itself.
 * It never launches Codex/CLI and never accepts a Platform API key.
 */
export interface BotResponsesRuntimeConfig {
  readonly authFile: string;
  readonly model: typeof RESPONSES_MODEL;
  readonly serviceTier: typeof RESPONSES_SERVICE_TIER;
  readonly reasoningEffort: typeof RESPONSES_REASONING_EFFORT;
  readonly turnTimeoutMs: number;
}

/** Safe for logs: neither the auth-state path nor token contents escape. */
export interface SafeBotResponsesRuntimeConfig {
  readonly subscriptionAuthConfigured: true;
  readonly model: typeof RESPONSES_MODEL;
  readonly serviceTier: typeof RESPONSES_SERVICE_TIER;
  readonly reasoningEffort: typeof RESPONSES_REASONING_EFFORT;
  readonly turnTimeoutMs: number;
}

/**
 * Parses non-secret configuration. OAuth state must be owner-only writable:
 * the transport atomically persists a refreshed subscription token there.
 */
export function parseBotResponsesRuntimeConfig(
  env: BotResponsesRuntimeEnvironment,
): BotResponsesRuntimeConfig {
  const config = {
    authFile: requiredAbsoluteFile(
      env.PARILKA_BOT_CODEX_AUTH_FILE,
      "PARILKA_BOT_CODEX_AUTH_FILE",
    ),
    model: RESPONSES_MODEL,
    serviceTier: RESPONSES_SERVICE_TIER,
    reasoningEffort: RESPONSES_REASONING_EFFORT,
    turnTimeoutMs: integer(
      env.PARILKA_BOT_RESPONSES_TURN_TIMEOUT_MS,
      180_000,
      5_000,
      600_000,
      "PARILKA_BOT_RESPONSES_TURN_TIMEOUT_MS",
    ),
  } as const satisfies BotResponsesRuntimeConfig;
  assertBotCodexAuthFile(config);
  return config;
}

/**
 * Fail closed before SQLite/Telegram resources are acquired. The auth store
 * repeats safe read/write checks around refresh; this boundary check never
 * parses or logs credential contents.
 */
export function assertBotCodexAuthFile(config: BotResponsesRuntimeConfig): void {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Codex subscription auth file ownership cannot be verified on this platform.");
  }
  const path = config.authFile;
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== uid) {
    throw new Error("PARILKA_BOT_CODEX_AUTH_FILE must be an owner-owned regular non-symlink file.");
  }
  if (!hasOwnerOnlyWritableMode(before.mode)) {
    throw new Error("PARILKA_BOT_CODEX_AUTH_FILE must have mode 0600.");
  }
  try {
    accessSync(path, constants.W_OK);
  } catch {
    throw new Error("PARILKA_BOT_CODEX_AUTH_FILE must be writable by its owner for token refresh.");
  }

  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== uid || !hasOwnerOnlyWritableMode(opened.mode)) {
      throw new Error("PARILKA_BOT_CODEX_AUTH_FILE must remain an owner-owned mode-0600 regular file.");
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("PARILKA_BOT_CODEX_AUTH_FILE changed while it was validated.");
    }
  } finally {
    closeSync(descriptor);
  }
}

export function safeBotResponsesRuntimeConfig(
  config: BotResponsesRuntimeConfig,
): SafeBotResponsesRuntimeConfig {
  return {
    subscriptionAuthConfigured: true,
    model: config.model,
    serviceTier: config.serviceTier,
    reasoningEffort: config.reasoningEffort,
    turnTimeoutMs: config.turnTimeoutMs,
  };
}

function requiredAbsoluteFile(value: string | undefined, name: string): string {
  const trimmed = optional(value);
  if (trimmed === undefined) throw new Error(`${name} is required.`);
  if (!isAbsolute(trimmed)) throw new Error(`${name} must be an absolute path.`);
  return resolve(trimmed);
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function integer(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const normalized = optional(raw);
  const value = normalized === undefined ? fallback : Number(normalized);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function hasOwnerOnlyWritableMode(mode: number): boolean {
  return (mode & 0o777) === 0o600;
}
