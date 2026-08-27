import {
  closeSync,
  existsSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlRow } from "./contracts.js";

const MAX_SUPPORTED_TARGET_SCHEMA_VERSION = 23;

const LEGACY_TABLE_COLUMNS = {
  live_msg: [
    "message_id",
    "chat_id",
    "date_unix",
    "sender_id",
    "sender_name",
    "text",
    "reply_to",
    "edited_at",
    "raw_json",
    "is_bot",
  ],
  digest_day: [
    "day",
    "start_msg_id",
    "end_msg_id",
    "n_msgs",
    "in_tokens",
    "out_tokens",
    "model",
    "prompt_version",
    "text",
    "created_at",
  ],
  digest_roll: [
    "kind",
    "period",
    "day_from",
    "day_to",
    "n_days",
    "prompt_version",
    "text",
    "created_at",
  ],
  digest_month: [
    "month",
    "n_days",
    "prompt_version",
    "text",
    "created_at",
  ],
  bot_outbox: ["status"],
} as const;

const TARGET_BASE_TABLE_COLUMNS = {
  chats: ["chat_id"],
  messages: ["chat_id", "message_id", "text"],
  sync_state: ["chat_id"],
  history_jobs: ["job_id", "status", "started_at"],
} as const;

export function assertHealthyLegacySource(source: DatabaseSync): void {
  assertQuickCheck(source, "Source");
  if (!tableExists(source, "live_msg")) {
    throw new Error(
      "Source is not a par-lang-bot state database: required table live_msg is missing.",
    );
  }
  for (const [table, columns] of Object.entries(
    LEGACY_TABLE_COLUMNS,
  )) {
    if (table === "live_msg" || tableExists(source, table)) {
      assertTableColumns(source, table, columns);
    }
  }
}

export function assertSuitableTarget(targetPath: string): void {
  if (!existsSync(targetPath)) {
    return;
  }
  const target = new DatabaseSync(targetPath, { readOnly: true });
  try {
    target.exec("PRAGMA query_only = ON");
    assertQuickCheck(target, "Target");
    const tables = userTables(target);
    if (tables.length === 0) {
      return;
    }
    const version = pragmaInteger(target, "user_version");
    if (
      version < 1 ||
      version > MAX_SUPPORTED_TARGET_SCHEMA_VERSION
    ) {
      throw new Error(
        `Target schema version ${version} is unsupported; expected 1-${MAX_SUPPORTED_TARGET_SCHEMA_VERSION}.`,
      );
    }
    for (const [table, columns] of Object.entries(
      TARGET_BASE_TABLE_COLUMNS,
    )) {
      if (!tableExists(target, table)) {
        throw new Error(
          `Target is not a telegram-parilka state database: required table ${table} is missing.`,
        );
      }
      assertTableColumns(target, table, columns);
    }
  } finally {
    target.close();
  }
}

export function createPrivateTargetIfMissing(targetPath: string): void {
  if (existsSync(targetPath)) {
    return;
  }
  const descriptor = openSync(targetPath, "wx", 0o600);
  closeSync(descriptor);
}

function assertQuickCheck(
  database: DatabaseSync,
  label: string,
): void {
  const rows = database
    .prepare("PRAGMA quick_check")
    .all() as SqlRow[];
  const results = rows.map((row) => String(Object.values(row)[0]));
  if (
    results.length !== 1 ||
    results[0] !== "ok"
  ) {
    throw new Error(`${label} SQLite quick_check failed.`);
  }
}

function assertTableColumns(
  database: DatabaseSync,
  table: string,
  requiredColumns: readonly string[],
): void {
  const rows = database
    .prepare(`PRAGMA table_info("${table}")`)
    .all() as SqlRow[];
  const present = new Set(rows.map((row) => String(row.name)));
  const missing = requiredColumns.filter(
    (column) => !present.has(column),
  );
  if (missing.length > 0) {
    throw new Error(
      `Table ${table} is missing required columns: ${missing.join(", ")}.`,
    );
  }
}

function userTables(database: DatabaseSync): string[] {
  const rows = database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as SqlRow[];
  return rows.map((row) => String(row.name));
}

function pragmaInteger(
  database: DatabaseSync,
  pragma: "user_version",
): number {
  const row = database
    .prepare(`PRAGMA ${pragma}`)
    .get() as SqlRow | undefined;
  const value = Number(row?.[pragma]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`PRAGMA ${pragma} returned an invalid value.`);
  }
  return value;
}


export function tableExists(source: DatabaseSync, table: string): boolean {
  const row = source
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(table) as SqlRow | undefined;
  return row?.present === 1;
}

export function assertDistinctFiles(sourcePath: string, targetPath: string): void {
  if (resolve(sourcePath) === resolve(targetPath)) {
    throw new Error("Source and target database paths must differ.");
  }
  if (!existsSync(sourcePath) || !existsSync(targetPath)) {
    return;
  }
  const sourceReal = realpathSync(sourcePath);
  const targetReal = realpathSync(targetPath);
  const sourceStat = statSync(sourceReal);
  const targetStat = statSync(targetReal);
  if (
    sourceReal === targetReal ||
    (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)
  ) {
    throw new Error("Source and target databases refer to the same file.");
  }
}
