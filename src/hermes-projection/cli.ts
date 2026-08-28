import {
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { MessageStore } from "../store.js";
import {
  acquireDigestProcessLock,
  type DigestProcessLock,
} from "../digest/process-lock.js";
import { runProjectionWithLocks } from "./apply.js";
import type { ProjectionReport } from "./types.js";

export interface HermesProjectionCliOptions {
  apply: boolean;
  disabled: boolean;
  dbPath: string;
  chatId: string;
  hermesHome: string;
  lockTimeoutMs: number;
}

export function parseHermesProjectionOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): HermesProjectionCliOptions {
  const values = new Map<string, string>();
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    const allowed = new Set([
      "--db",
      "--chat",
      "--hermes-home",
      "--lock-timeout-ms",
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

  // Lock timeout is validated for both enabled and disabled runs.
  const lockTimeoutMs = parseLockTimeout(values.get("--lock-timeout-ms"));

  // Disabled apply resolves nothing else: no DB/chat/profile stat, realpath,
  // or filesystem touch. Syntax above and the lock timeout stay checked.
  if (apply && !isProjectionEnabled(env)) {
    return {
      apply,
      disabled: true,
      dbPath: "",
      chatId: "",
      hermesHome: "",
      lockTimeoutMs,
    };
  }

  // DB path resolution
  const dbPath = resolveDatabasePath(values.get("--db"), env);

  // Chat ID resolution
  const chatId = resolveChatId(values.get("--chat"), env);

  // A real profile home is required for both dry-run and apply. It comes only
  // from --hermes-home; the wrapper supplies its default profile path.
  const hermesHomeRaw = values.get("--hermes-home");
  if (!hermesHomeRaw) {
    throw new CliConfigError(
      "missing_hermes_home",
      "Profile home is required: set --hermes-home.",
    );
  }
  const hermesHome = existingAbsoluteDir(
    hermesHomeRaw.trim(),
    "hermes profile home",
  );

  return { apply, disabled: false, dbPath, chatId, hermesHome, lockTimeoutMs };
}

function isProjectionEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = env.PARILKA_HERMES_PROJECTION_ENABLED;
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  return ["1", "true", "yes"].includes(trimmed.toLowerCase());
}

function resolveDatabasePath(
  cliValue: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw =
    cliValue ??
    env.PARILKA_DIGEST_DB_PATH ??
    env.PARILKA_BOT_DB_PATH ??
    env.TELEGRAM_DB_PATH;
  if (!raw) {
    throw new CliConfigError(
      "missing_db",
      "Set --db, PARILKA_DIGEST_DB_PATH, PARILKA_BOT_DB_PATH, or TELEGRAM_DB_PATH.",
    );
  }
  return existingAbsoluteFile(raw.trim(), "database");
}

function resolveChatId(
  cliValue: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw =
    cliValue ??
    env.PARILKA_DIGEST_CHAT_ID ??
    env.PARILKA_BOT_CHAT_ID;
  if (raw) {
    const trimmed = raw.trim();
    if (!/^-\d{5,20}$/u.test(trimmed)) {
      throw new CliConfigError("invalid_chat", "Chat id must be a negative Telegram chat id.");
    }
    return trimmed;
  }
  // Fallback to single allowed chat
  const allowed = env.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
  if (allowed) {
    const chats = allowed.split(",").map((s) => s.trim()).filter(Boolean);
    if (chats.length === 1 && /^-\d{5,20}$/u.test(chats[0]!)) {
      return chats[0]!;
    }
    throw new CliConfigError(
      "invalid_allowlist",
      "TELEGRAM_ALLOWED_CHAT_IDS must contain exactly one chat for projection.",
    );
  }
  throw new CliConfigError(
    "missing_chat",
    "Set --chat, PARILKA_DIGEST_CHAT_ID, PARILKA_BOT_CHAT_ID, or TELEGRAM_ALLOWED_CHAT_IDS.",
  );
}

function parseLockTimeout(raw: string | undefined): number {
  if (!raw) return 30_000;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new CliConfigError(
      "invalid_lock_timeout",
      "Lock timeout must be a positive integer.",
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) {
    throw new CliConfigError(
      "lock_timeout_out_of_range",
      "Lock timeout must be between 100 and 300000 ms.",
    );
  }
  return value;
}

function existingAbsoluteFile(value: string, name: string): string {
  const expanded = expandHome(value.trim());
  if (!isAbsolute(expanded)) {
    throw new CliConfigError("path_not_absolute", `${name} path must be absolute.`);
  }
  let path: string;
  try {
    path = realpathSync(resolve(expanded));
  } catch {
    throw new CliConfigError("path_not_found", `${name} path does not exist.`);
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new CliConfigError("path_not_file", `${name} path must name a regular file.`);
  }
  return path;
}

function existingAbsoluteDir(value: string, name: string): string {
  const expanded = expandHome(value.trim());
  if (!isAbsolute(expanded)) {
    throw new CliConfigError("path_not_absolute", `${name} path must be absolute.`);
  }
  let path: string;
  try {
    path = realpathSync(resolve(expanded));
  } catch {
    throw new CliConfigError("path_not_found", `${name} path does not exist.`);
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    throw new CliConfigError("path_not_dir", `${name} path must name a directory.`);
  }
  return path;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
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

/**
 * Main CLI runner. Returns exit code.
 */
export async function runHermesProjectionCliMain(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  output: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  process.umask(0o077);

  let digestLock: DigestProcessLock | undefined;
  let store: MessageStore | undefined;

  try {
    const options = parseHermesProjectionOptions(argv, env);

    // Disabled path: report success without touching DB or profile.
    if (options.disabled) {
      output.stdout.write(
        `${JSON.stringify(skippedDisabledReport(options), null, 2)}\n`,
      );
      return 0;
    }

    // Digest process lock is acquired before any DB open/read/snapshot.
    digestLock = acquireDigestProcessLock(options.dbPath);
    store = new MessageStore(options.dbPath, { readOnly: true });
    const schemaVersion = store.getSchemaVersion();
    if (schemaVersion < 22) {
      throw new CliConfigError(
        "unsupported_schema",
        `Database schema version ${schemaVersion} is not supported (need >= 22).`,
      );
    }

    const report = await runProjectionWithLocks(store, {
      apply: options.apply,
      dbPath: options.dbPath,
      chatId: options.chatId,
      profileHome: options.hermesHome,
      lockTimeoutMs: options.lockTimeoutMs,
    });

    output.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof CliConfigError) {
      output.stderr.write(
        `${JSON.stringify({
          ok: false,
          error: { name: error.name, code: error.code, message: error.message },
        })}\n`,
      );
      return 1;
    }
    // Stable generic error: never leak raw exceptions or paths.
    output.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          name: "ProjectionError",
          code: "projection_failed",
          message: "Projection failed.",
        },
      })}\n`,
    );
    return 1;
  } finally {
    store?.close();
    digestLock?.release();
  }
}

function skippedDisabledReport(
  options: HermesProjectionCliOptions,
): ProjectionReport {
  return {
    ok: true,
    mode: "skipped_disabled",
    chatId: options.chatId,
    dbPath: options.dbPath,
    profileHome: "",
    contentHash: "",
    memory: {
      status: "skipped",
      managedEntries: 0,
      ownerChars: 0,
      totalChars: 0,
      limit: 0,
    },
    skills: {
      status: "skipped",
      created: 0,
      updated: 0,
      removed: 0,
      lessonsCount: 0,
    },
  };
}

export function runHermesProjectionCli(): void {
  void runHermesProjectionCliMain().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
