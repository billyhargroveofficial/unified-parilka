import {
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  DEFAULT_MAX_DAY_GENERATIONS_PER_RUN,
  DEFAULT_MAX_WEEK_GENERATIONS_PER_RUN,
  MAX_DAY_GENERATIONS_PER_RUN,
  MAX_WEEK_GENERATIONS_PER_RUN,
} from "../digest/types.js";

export interface CliOptions {
  apply: boolean;
  all: boolean;
  summaryOnly: boolean;
  dreamOnly: boolean;
  chatId: string;
  dbPath: string;
  botId: string;
  /** Present only for apply: dry-run must not read a credential or construct Responses. */
  responses?: ResponsesDigestCliOptions;
  maxInputChars?: number;
  maxOutputChars?: number;
  itemTimeoutMs?: number;
  modelTotalTimeoutMs?: number;
  modelCandidateTimeoutMs?: number;
  maxDayGenerationsPerRun: number;
  maxWeekGenerationsPerRun: number;
  memoryMaxChars: number;
}

export interface ResponsesDigestCliOptions {
  /** Absolute, owner-only Codex subscription OAuth cache. */
  authFile: string;
  model: "gpt-5.6-luna";
  /** Logical Fast tier; shared subscription transport maps it to wire priority. */
  serviceTier: "fast";
}

const DIGEST_RESPONSES_MODEL = "gpt-5.6-luna" as const;
const DIGEST_RESPONSES_SERVICE_TIER = "fast" as const;

export function parseOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CliOptions {
  const values = new Map<string, string>();
  let apply = false;
  let all = false;
  let summaryOnly = false;
  let dreamOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--summary-only") {
      summaryOnly = true;
      continue;
    }
    if (argument === "--dream-only") {
      dreamOnly = true;
      continue;
    }
    const allowed = new Set([
      "--chat",
      "--db",
      "--bot-id",
      "--max-input-chars",
      "--max-output-chars",
      "--item-timeout-ms",
      "--model-total-timeout-ms",
      "--model-candidate-timeout-ms",
      "--max-day-generations-per-run",
      "--max-week-generations-per-run",
    ]);
    if (!allowed.has(argument)) {
      throw new CliConfigError(
        "unknown_argument",
        `Unknown argument: ${argument}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliConfigError(
        "missing_argument_value",
        `${argument} requires a value.`,
      );
    }
    if (values.has(argument)) {
      throw new CliConfigError(
        "duplicate_argument",
        `${argument} may be provided only once.`,
      );
    }
    values.set(argument, value);
    index += 1;
  }

  const chatId = telegramChatId(
    values.get("--chat") ??
      env.PARILKA_DIGEST_CHAT_ID ??
      env.PARILKA_BOT_CHAT_ID ??
      onlyAllowedChat(env.TELEGRAM_ALLOWED_CHAT_IDS),
  );
  assertMatchesAllowlist(chatId, env.TELEGRAM_ALLOWED_CHAT_IDS);

  const configuredDb =
    values.get("--db") ??
    env.PARILKA_DIGEST_DB_PATH ??
    env.PARILKA_BOT_DB_PATH ??
    env.TELEGRAM_DB_PATH;
  if (!configuredDb) {
    throw new CliConfigError(
      "missing_db",
      "Set --db, PARILKA_DIGEST_DB_PATH, PARILKA_BOT_DB_PATH, or TELEGRAM_DB_PATH.",
    );
  }
  const dbPath = existingAbsoluteFile(
    configuredDb,
    "digest database",
  );
  assertSingleLinkDatabase(dbPath);
  assertSharedDatabaseIdentity(dbPath, env);

  const botIdValue =
    values.get("--bot-id") ?? env.PARILKA_BOT_ID;
  const botId = botIdValue ? telegramBotId(botIdValue) : "";
  if (apply && botId === "") {
    throw new CliConfigError(
      "missing_bot_id",
      "Dream mode requires --bot-id or PARILKA_BOT_ID to the application bot Telegram user id.",
    );
  }

  const options: CliOptions = {
    apply,
    all,
    summaryOnly,
    dreamOnly,
    chatId,
    dbPath,
    botId,
    ...(apply ? { responses: parseResponsesOptions(env) } : {}),
    maxInputChars: integerOption(
      values.get("--max-input-chars") ??
        env.PARILKA_DIGEST_MAX_INPUT_CHARS,
      "max input characters",
      1_000,
      2_000_000,
    ),
    maxOutputChars: integerOption(
      values.get("--max-output-chars") ??
        env.PARILKA_DIGEST_MAX_OUTPUT_CHARS,
      "max output characters",
      1_000,
      200_000,
    ),
    itemTimeoutMs: integerOption(
      values.get("--item-timeout-ms") ??
        env.PARILKA_DIGEST_ITEM_TIMEOUT_MS,
      "item timeout",
      1_000,
      15 * 60_000,
    ),
    modelTotalTimeoutMs: integerOption(
      values.get("--model-total-timeout-ms") ??
        env.PARILKA_DIGEST_MODEL_TOTAL_TIMEOUT_MS,
      "model total timeout",
      1_000,
      15 * 60_000,
    ),
    modelCandidateTimeoutMs: integerOption(
      values.get("--model-candidate-timeout-ms") ??
        env.PARILKA_DIGEST_MODEL_CANDIDATE_TIMEOUT_MS,
      "model candidate timeout",
      500,
      15 * 60_000,
    ),
    maxDayGenerationsPerRun:
      integerOption(
        values.get("--max-day-generations-per-run") ??
          env.PARILKA_DIGEST_MAX_DAY_GENERATIONS_PER_RUN,
        "day generations per run",
        0,
        MAX_DAY_GENERATIONS_PER_RUN,
      ) ?? DEFAULT_MAX_DAY_GENERATIONS_PER_RUN,
    maxWeekGenerationsPerRun:
      integerOption(
        values.get("--max-week-generations-per-run") ??
          env.PARILKA_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN,
        "week generations per run",
        0,
        MAX_WEEK_GENERATIONS_PER_RUN,
      ) ?? DEFAULT_MAX_WEEK_GENERATIONS_PER_RUN,
    memoryMaxChars: integerFromEnvironment(
      env.PARILKA_MEMORY_MAX_CHARS,
      "memory max chars",
      500,
      4_000,
      2_000,
    ),
  };

  return options;
}

function parseResponsesOptions(
  env: Readonly<Record<string, string | undefined>>,
): ResponsesDigestCliOptions {
  const authFile = requiredAbsolutePath(
    env.PARILKA_DIGEST_CODEX_AUTH_FILE,
    "PARILKA_DIGEST_CODEX_AUTH_FILE",
    "missing_codex_auth_file",
  );
  return {
    authFile,
    model: DIGEST_RESPONSES_MODEL,
    serviceTier: DIGEST_RESPONSES_SERVICE_TIER,
  };
}

function requiredAbsolutePath(
  value: string | undefined,
  name: string,
  code: string,
): string {
  if (!value?.trim()) {
    throw new CliConfigError(code, `${name} must be configured for apply mode.`);
  }
  return absolutePath(value, name);
}

function absolutePath(value: string, name: string): string {
  const expanded = expandHome(value.trim());
  if (!isAbsolute(expanded)) {
    throw new CliConfigError("path_not_absolute", `${name} path must be absolute.`);
  }
  return resolve(expanded);
}

function telegramChatId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^-\d{5,20}$/u.test(normalized)) {
    throw new CliConfigError(
      "invalid_chat",
      "Digest chat id must be one negative Telegram chat id.",
    );
  }
  return normalized;
}

function telegramBotId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^\d{5,20}$/u.test(normalized)) {
    throw new CliConfigError(
      "invalid_bot_id",
      "Bot id must be a positive Telegram user id.",
    );
  }
  return normalized;
}

function onlyAllowedChat(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const chats = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chats.length !== 1) {
    throw new CliConfigError(
      "invalid_allowlist",
      "TELEGRAM_ALLOWED_CHAT_IDS must contain exactly one chat for digest generation.",
    );
  }
  return chats[0];
}

function assertMatchesAllowlist(
  chatId: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  const allowed = telegramChatId(onlyAllowedChat(value));
  if (allowed !== chatId) {
    throw new CliConfigError(
      "chat_not_allowlisted",
      "Digest chat id does not match TELEGRAM_ALLOWED_CHAT_IDS.",
    );
  }
}

function existingAbsoluteFile(value: string, name: string): string {
  const expanded = expandHome(value.trim());
  if (!isAbsolute(expanded)) {
    throw new CliConfigError(
      "path_not_absolute",
      `${name} path must be absolute.`,
    );
  }
  const path = realpathSync(resolve(expanded));
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new CliConfigError(
      "path_not_file",
      `${name} path must name a regular file.`,
    );
  }
  return path;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function assertSharedDatabaseIdentity(
  selectedPath: string,
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const [name, value] of [
    ["PARILKA_BOT_DB_PATH", env.PARILKA_BOT_DB_PATH],
    ["TELEGRAM_DB_PATH", env.TELEGRAM_DB_PATH],
  ] as const) {
    if (!value) {
      continue;
    }
    const configured = existingAbsoluteFile(value, name);
    const selected = statSync(selectedPath);
    const candidate = statSync(configured);
    if (selectedPath !== configured) {
      throw new CliConfigError(
        "database_path_mismatch",
        `${name} must resolve to the same canonical pathname as the selected shared database; a different hardlink path is unsafe with SQLite WAL.`,
      );
    }
    if (
      selected.dev !== candidate.dev ||
      selected.ino !== candidate.ino
    ) {
      throw new CliConfigError(
        "database_identity_mismatch",
        `${name} does not identify the selected shared database.`,
      );
    }
  }
}

function assertSingleLinkDatabase(path: string): void {
  if (statSync(path).nlink !== 1) {
    throw new CliConfigError(
      "database_has_hardlinks",
      "Digest database must not have hardlink aliases; use its one canonical pathname.",
    );
  }
}

function integerOption(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value.trim())) {
    throw new CliConfigError(
      "invalid_integer",
      `${name} must be an integer.`,
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new CliConfigError(
      "integer_out_of_range",
      `${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

export function integerFromEnvironment(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return (
    integerOption(value, name, minimum, maximum) ?? fallback
  );
}

export class CliConfigError extends Error {
  readonly name = "CliConfigError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
