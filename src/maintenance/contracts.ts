export const MIN_SUPPORTED_SCHEMA_VERSION = 11;
export const MAX_SUPPORTED_SCHEMA_VERSION = 24;
export const FTS_REBUILD_JOB = "messages_fts_rebuild";
export const EMBEDDING_MEMBERSHIP_JOB =
  "embedding_chunk_membership_backfill";

export interface MaintenanceOptions {
  dbPath: string;
  apply: boolean;
  historyRetentionDays: number;
  botRetentionDays: number;
  sendOutboxRetentionDays: number;
  staleHistoryHours: number;
  keepHistoryJobs: number;
  keepSendOutboxRows: number;
  deferredBatchSize: number;
  deferredMaxBatches: number;
}

export type DeferredMaintenanceStatus =
  | "not_pending"
  | "pending"
  | "completed";

export interface DeferredMaintenanceJobReport {
  name: typeof FTS_REBUILD_JOB | typeof EMBEDDING_MEMBERSHIP_JOB;
  status: DeferredMaintenanceStatus;
  batches: number;
  processedRows: number;
  remainingRows: number;
}

export interface WalCheckpointReport {
  busy: number;
  log: number;
  checkpointed: number;
  remainingFrames: number;
  pageSizeBytes: number;
  approximateRemainingBytes: number;
}

export interface RetentionCounts {
  staleRunningHistoryJobs: number;
  terminalHistoryJobs: number;
  terminalBotTurns: number;
  terminalBotUpdates: number;
  terminalSendOutbox: number;
  throttleState: number;
}

export interface MaintenanceReport {
  mode: "dry_run" | "applied";
  dbPath: string;
  integrity: string[];
  candidates: {
    staleRunningHistoryJobs: number;
    terminalHistoryJobs: number;
    terminalBotTurns: number;
    orphanTerminalBotUpdates: number;
    terminalSendOutbox: number;
    throttleState: number;
  };
  changed: RetentionCounts;
  deferredMaintenance: DeferredMaintenanceJobReport[];
  walCheckpoint?: WalCheckpointReport;
  warnings: string[];
}

export type MaintenancePhase =
  | "options"
  | "open"
  | "inspect"
  | "retention"
  | "deferred_fts"
  | "deferred_embedding_membership"
  | "optimize"
  | "checkpoint"
  | "report";

export type MaintenanceFailureCode =
  | "invalid_options"
  | "database_missing"
  | "database_open_failed"
  | "quick_check_failed"
  | "incompatible_schema"
  | "retention_failed"
  | "deferred_fts_failed"
  | "deferred_embedding_failed"
  | "maintenance_failed";

export interface MaintenanceExecutionState {
  phase: MaintenancePhase;
  completedPhases: MaintenancePhase[];
  retentionMayBeCommitted: boolean;
  deferredMaintenanceMayBeCommitted: boolean;
}

export interface MaintenanceFailureReport {
  event: "state_maintenance_failed";
  phase: MaintenancePhase;
  completedPhases: MaintenancePhase[];
  stateMayBePartiallyModified: boolean;
  retentionMayBeCommitted: boolean;
  deferredMaintenanceMayBeCommitted: boolean;
  error: {
    code: MaintenanceFailureCode;
  };
}

export interface MaintenanceJobRow {
  name: string;
  status: "pending" | "completed";
  reason?: string;
  details: Record<string, unknown>;
  updatedAt: string;
}

export class MaintenanceError extends Error {
  readonly code: MaintenanceFailureCode;

  constructor(
    code: MaintenanceFailureCode,
    internalMessage: string,
    options?: ErrorOptions,
  ) {
    super(internalMessage, options);
    this.name = "MaintenanceError";
    this.code = code;
  }
}
