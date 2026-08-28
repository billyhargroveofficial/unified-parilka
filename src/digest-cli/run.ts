import {
  chmodSync,
  existsSync,
} from "node:fs";
import {
  AiSdkSummaryPort,
  acquireDigestProcessLock,
  runDigestGeneration,
  DIGEST_STALE_MESSAGE_THRESHOLD,
  DIGEST_TIME_ZONE,
  type DigestGenerationReport,
  type DigestModelRouter,
  type DigestPhaseReport,
  type DigestProcessLock,
} from "../digests.js";
import type { JsonEventLogger } from "../observability/contracts.js";
import { createLogger } from "../observability/logger.js";
import { ModelRouter } from "../providers/model-router.js";
import { MessageStore } from "../store.js";
import { runDreamPass } from "./dream-pass.js";
import {
  parseOptions,
  type CliOptions,
  CliConfigError,
} from "./options.js";

/** Optional DI for tests; production main wires createLogger({ service: "cli" }). */
export interface RunDigestCliDeps {
  logger?: JsonEventLogger;
}

export async function runDigestCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  output: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
  deps: RunDigestCliDeps = {},
): Promise<number> {
  process.umask(0o077);
  let lock: DigestProcessLock | undefined;
  let store: MessageStore | undefined;
  try {
    const options: CliOptions = parseOptions(argv, env);

    // Both modes first prove that this is an already-migrated unified database.
    // Dry-runs and mistimed scheduled runs never migrate production state.
    const preflight = new MessageStore(options.dbPath, {
      readOnly: true,
    });
    preflight.close();

    if (options.apply) {
      lock = acquireDigestProcessLock(options.dbPath);
      makeDatabaseFilesPrivate(options.dbPath);
    }
    store = new MessageStore(options.dbPath, {
      readOnly: !options.apply,
    });
    const router: DigestModelRouter | undefined =
      options.apply && options.modelConfigPath
        ? ModelRouter.fromFile(options.modelConfigPath)
        : undefined;
    const summaryPort = router && !options.dreamOnly
      ? new AiSdkSummaryPort(router, {
          maxOutputTokens: 2_048,
          totalTimeoutMs: options.modelTotalTimeoutMs,
          candidateTimeoutMs: options.modelCandidateTimeoutMs,
        })
      : undefined;
    const report = options.dreamOnly
      ? emptyDigestReport(
          options.chatId,
          options.apply ? "applied" : "dry_run",
        )
      : await runDigestGeneration({
          store,
          chatId: options.chatId,
          apply: options.apply,
          all: options.all,
          summaryPort,
          maxInputChars: options.maxInputChars,
          maxOutputChars: options.maxOutputChars,
          itemTimeoutMs: options.itemTimeoutMs,
          maxDayGenerationsPerRun:
            options.maxDayGenerationsPerRun,
          maxWeekGenerationsPerRun:
            options.maxWeekGenerationsPerRun,
        });
    const dream = await runDreamPass(
      store,
      {
        chatId: options.chatId,
        apply: options.apply,
        botId: options.botId,
        modelConfigPath: options.modelConfigPath,
        modelTotalTimeoutMs: options.modelTotalTimeoutMs,
        modelCandidateTimeoutMs: options.modelCandidateTimeoutMs,
        memoryMaxChars: options.memoryMaxChars,
      },
      router,
      deps.logger,
    );
    const reportOutput = options.summaryOnly
      ? compactDigestReport(report)
      : report;
    output.stdout.write(
      `${JSON.stringify(
        {
          ...reportOutput,
          dream,
          ...(lock
            ? {
                lock: {
                  mechanism: lock.mechanism,
                },
              }
            : {}),
        },
        null,
        options.summaryOnly ? undefined : 2,
      )}\n`,
    );
    return (!options.dreamOnly && (report.days.failed > 0 || report.weeks.failed > 0)) || dream.status === "failed"
      ? 1
      : 0;
  } catch (error) {
    output.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: safeTopLevelError(error),
      })}\n`,
    );
    return 1;
  } finally {
    store?.close();
    lock?.release();
  }
}

function emptyDigestReport(
  chatId: string,
  mode: DigestGenerationReport["mode"],
): DigestGenerationReport {
  const now = new Date().toISOString();
  const emptyPhase: DigestPhaseReport = {
    scanned: 0,
    candidates: 0,
    planned: 0,
    providerCalls: 0,
    generated: 0,
    unchanged: 0,
    invalidated: 0,
    deferred: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };
  return {
    mode,
    chatId,
    timeZone: DIGEST_TIME_ZONE,
    staleMessageThreshold: DIGEST_STALE_MESSAGE_THRESHOLD,
    options: {
      all: false,
      maxDayGenerationsPerRun: 0,
      maxWeekGenerationsPerRun: 0,
    },
    startedAt: now,
    finishedAt: now,
    days: emptyPhase,
    weeks: emptyPhase,
  };
}

export function compactDigestReport(
  report: DigestGenerationReport,
): Omit<DigestGenerationReport, "days" | "weeks"> & {
  days: CompactDigestPhaseReport;
  weeks: CompactDigestPhaseReport;
} {
  return {
    ...report,
    days: compactDigestPhase(report.days),
    weeks: compactDigestPhase(report.weeks),
  };
}

type CompactDigestFailure = {
  period: string;
  reason: string;
  error?: {
    name: string;
    code: string;
  };
};

type CompactDigestPhaseReport = Omit<DigestPhaseReport, "items"> & {
  generatedPeriods: string[];
  failures: CompactDigestFailure[];
  failuresOmitted: number;
};

function compactDigestPhase(
  phase: DigestPhaseReport,
): CompactDigestPhaseReport {
  const allFailures = phase.items.filter(
    ({ status }) => status === "failed",
  );
  const failures = allFailures.slice(0, 20).map(
    ({ period, reason, error }) => ({
      period,
      reason,
      ...(error === undefined ? {} : { error }),
    }),
  );
  return {
    scanned: phase.scanned,
    candidates: phase.candidates,
    planned: phase.planned,
    providerCalls: phase.providerCalls,
    generated: phase.generated,
    unchanged: phase.unchanged,
    invalidated: phase.invalidated,
    deferred: phase.deferred,
    skipped: phase.skipped,
    failed: phase.failed,
    generatedPeriods: phase.items
      .filter(({ status }) => status === "generated")
      .map(({ period }) => period),
    failures,
    failuresOmitted: allFailures.length - failures.length,
  };
}

export function runDigestCliMain(): void {
  const logger = createLogger({ service: "cli" });
  void runDigestCli(
    process.argv.slice(2),
    process.env,
    process,
    { logger },
  ).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

function makeDatabaseFilesPrivate(dbPath: string): void {
  chmodSync(dbPath, 0o600);
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      chmodSync(sidecar, 0o600);
    }
  }
}

function safeTopLevelError(error: unknown): {
  name: string;
  code: string;
  message?: string;
} {
  if (error instanceof CliConfigError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
    };
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      name?: unknown;
      code?: unknown;
    };
    return {
      name:
        typeof candidate.name === "string"
          ? candidate.name.slice(0, 80)
          : "Error",
      code:
        typeof candidate.code === "string" ||
        typeof candidate.code === "number"
          ? String(candidate.code).slice(0, 80)
          : "digest_command_failed",
    };
  }
  return { name: "NonError", code: "digest_command_failed" };
}
