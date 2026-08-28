import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { BotRuntimeEnvironment } from "./contracts.js";

const MAX_SAFE_TELEGRAM_ID = BigInt(Number.MAX_SAFE_INTEGER);

export function requiredSecret(
  env: BotRuntimeEnvironment,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function requiredPlain(
  env: BotRuntimeEnvironment,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  if (value.length > 256) {
    throw new Error(`${name} is too long.`);
  }
  return value;
}

export function telegramId(
  value: string,
  name: string,
  sign: "negative" | "positive",
): string {
  if (!/^-?\d+$/u.test(value)) {
    throw new Error(`${name} must be a Telegram integer id.`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${name} must be a Telegram integer id.`);
  }
  const signMatches = sign === "negative" ? parsed < 0n : parsed > 0n;
  if (
    !signMatches ||
    parsed < -MAX_SAFE_TELEGRAM_ID ||
    parsed > MAX_SAFE_TELEGRAM_ID
  ) {
    throw new Error(
      `${name} must be a ${sign} Telegram id within JavaScript's safe integer range.`,
    );
  }
  return parsed.toString();
}

/**
 * Parses a small private allowlist without ever placing its values in an
 * error message. An omitted or blank list intentionally means nobody can
 * authorize model-driven memory writes.
 */
export function telegramIdList(
  raw: string | undefined,
  name: string,
  maximumEntries: number,
): readonly string[] {
  const normalized = raw?.trim();
  if (!normalized) {
    return Object.freeze([]);
  }
  if (normalized.length > 1_024) {
    throw new Error(`${name} is too long.`);
  }
  const parts = normalized.split(",").map((value) => value.trim());
  if (
    parts.length > maximumEntries ||
    parts.some((value) => value.length === 0)
  ) {
    throw new Error(
      `${name} must be a comma-separated list of at most ${maximumEntries} positive Telegram user IDs.`,
    );
  }
  const ids = parts.map((value) => telegramId(value, name, "positive"));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${name} must not contain duplicate Telegram user IDs.`);
  }
  return Object.freeze(ids);
}

export function normalizeBotUsername(value: string): string {
  const username = value.replace(/^@/u, "");
  if (
    !/^[A-Za-z0-9_]{5,32}$/u.test(username) ||
    !/bot$/iu.test(username)
  ) {
    throw new Error(
      "PARILKA_BOT_USERNAME must be a 5-32 character Telegram bot username ending in bot.",
    );
  }
  return username;
}

export function absolutePath(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\u0000")) {
    throw new Error(`${name} must be a non-empty filesystem path.`);
  }
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? resolve(homedir(), trimmed.slice(2))
        : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

export function absoluteSocketPath(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\u0000")) {
    throw new Error(`${name} must be a non-empty filesystem path.`);
  }
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? resolve(homedir(), trimmed.slice(2))
        : trimmed;
  if (!isAbsolute(expanded)) {
    throw new Error(`${name} must be an absolute Unix socket path.`);
  }
  const path = resolve(expanded);
  if (path.length > 1_024) {
    throw new Error(`${name} is too long.`);
  }
  return path;
}

export function existingAbsoluteFile(
  value: string,
  name: string,
): string {
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  const path = resolve(value);
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    // Stable errors deliberately exclude filesystem implementation details.
  }
  if (!isFile) {
    throw new Error(`${name} must reference an existing regular file.`);
  }
  return path;
}

export function sameConfiguredFile(
  left: string,
  right: string,
): boolean {
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

export function boundedPlain(
  value: string,
  name: string,
  maximum: number,
): string {
  const flattened = value.replace(/\s+/gu, " ").trim();
  if (!flattened || flattened.length > maximum) {
    throw new Error(
      `${name} must contain between 1 and ${maximum} characters.`,
    );
  }
  return flattened;
}

export function integer(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw integerError(name, minimum, maximum);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw integerError(name, minimum, maximum);
  }
  return parsed;
}

export function enumValue<const T extends readonly string[]>(
  raw: string | undefined,
  name: string,
  choices: T,
  fallback: T[number],
): T[number] {
  const value = raw?.trim() || fallback;
  if (!(choices as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${choices.join(", ")}.`);
  }
  return value as T[number];
}

function integerError(
  name: string,
  minimum: number,
  maximum: number,
): Error {
  return new Error(
    `${name} must be an integer between ${minimum} and ${maximum}.`,
  );
}
