import type { TurnCoordinatorOptions } from "../bot/turn-coordinator.js";
import type { JsonEventLogger } from "../bot/worker.js";

export function coordinatorTraceOptions(
  logger: JsonEventLogger | undefined,
): Pick<TurnCoordinatorOptions, "onTrace"> | Record<never, never> {
  if (!logger) {
    return {};
  }
  return {
    onTrace(event) {
      const durableTurnId = numericDurableTurnId(event.turnId);
      try {
        logger.info(
          durableTurnId === undefined
            ? event
            : {
                ...event,
                turnId: durableTurnId,
                coordinatorTurnId: event.turnId,
              },
        );
      } catch {
        // Coordinator tracing must never alter turn admission or completion.
      }
    },
  };
}

/** Production coordinator IDs are decimal SQLite turn IDs; generic IDs stay intact. */
function numericDurableTurnId(value: string): number | undefined {
  const turnId = Number(value);
  return Number.isSafeInteger(turnId) && turnId > 0 && String(turnId) === value
    ? turnId
    : undefined;
}

export function safeDaemonLog(
  logger: JsonEventLogger | undefined,
  level: "info" | "warn" | "error",
  record: Readonly<Record<string, unknown>>,
): void {
  try {
    logger?.[level](record);
  } catch {
    // Telemetry cannot control signal delivery, shutdown, or store ownership.
  }
}
