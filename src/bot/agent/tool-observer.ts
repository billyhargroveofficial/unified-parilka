import type { ToolProgressPort } from "../tool-progress.js";
import type { ReadToolEvidence } from "../read-tools/contracts.js";
import type {
  BotToolSetExecutionCompleted,
  BotToolSetExecutionStarted,
} from "./tool-set.js";
import {
  boundedSerialize,
  maxCarriedToolResultChars,
  type CarriedToolResult,
} from "./evidence.js";

export interface BotToolTraceContext {
  readonly turnId: number;
  readonly updateId: number;
}

export interface BotToolExecutionObserverOptions {
  readonly traceContext: BotToolTraceContext;
  readonly candidate: string;
  readonly attempt: number;
  readonly approvalOrder: ReadonlyMap<string, number>;
  readonly carriedTools: CarriedToolResult[];
  readonly toolEvidence: ReadToolEvidence[];
  readonly readToolFailures: Array<{ name: string; code: string }>;
  readonly toolProgressPort?: ToolProgressPort;
  readonly onStarted: (execution: BotToolSetExecutionStarted) => void;
  readonly finishThinking: () => void;
  readonly onCompleted: (execution: BotToolSetExecutionCompleted) => void;
  readonly log: (
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
}

export interface BotToolExecutionObserver {
  readonly onExecutionStarted: (execution: BotToolSetExecutionStarted) => void;
  readonly onExecutionCompleted: (execution: BotToolSetExecutionCompleted) => void;
}

/**
 * Keeps tool accounting, UI progress, and metadata-only logs outside the
 * turn-loop barrel. The arrays intentionally belong to the whole turn so
 * provider fallback and research retries retain one bounded evidence set.
 */
export function createBotToolExecutionObserver(
  options: BotToolExecutionObserverOptions,
): BotToolExecutionObserver {
  const fallbackSequences = new Map<string, number>();
  let nextFallbackSequence = 0;

  const sequenceFor = (callId: string): number => {
    const approved = options.approvalOrder.get(callId);
    if (approved !== undefined) {
      const sequence = boundedSequence(approved);
      nextFallbackSequence = Math.max(nextFallbackSequence, sequence);
      return sequence;
    }
    const known = fallbackSequences.get(callId);
    if (known !== undefined) {
      return known;
    }
    nextFallbackSequence = Math.min(
      Number.MAX_SAFE_INTEGER,
      nextFallbackSequence + 1,
    );
    fallbackSequences.set(callId, nextFallbackSequence);
    return nextFallbackSequence;
  };

  return {
    onExecutionStarted(execution): void {
      const sequence = sequenceFor(execution.callId);
      options.onStarted(execution);
      options.finishThinking();
      options.toolProgressPort?.onToolStarted({
        toolName: execution.name,
        callId: execution.callId,
        input: execution.input,
      });
      options.log("info", "bot.agent.tool_started", {
        ...options.traceContext,
        candidate: options.candidate,
        attempt: options.attempt,
        tool: execution.name,
        kind: execution.kind,
        sequence,
      });
    },
    onExecutionCompleted(execution): void {
      const sequence = sequenceFor(execution.callId);
      options.onCompleted(execution);
      const ok = execution.output.ok;
      options.toolProgressPort?.onToolCompleted(
        { toolName: execution.name, callId: execution.callId },
        ok,
      );
      // Read and web tools both contribute evidence, failures and carried
      // bounded text results so fallback and research retries keep them.
      if (
        (execution.kind === "read" || execution.kind === "web") &&
        execution.output.ok
      ) {
        options.toolEvidence.push(...execution.output.evidence);
      }
      if (
        (execution.kind === "read" || execution.kind === "web") &&
        !execution.output.ok
      ) {
        options.readToolFailures.push({
          name: execution.name,
          code: execution.output.error.code,
        });
      }
      options.carriedTools.push({
        sequence,
        name: execution.name,
        serialized: boundedSerialize(
          execution.output,
          maxCarriedToolResultChars(execution.name),
        ),
      });
      options.log("info", "bot.agent.tool", {
        ...options.traceContext,
        candidate: options.candidate,
        attempt: options.attempt,
        tool: execution.name,
        kind: execution.kind,
        sequence,
        durationMs: Math.max(0, Date.now() - execution.startedAt),
        ok,
        ...(execution.output.ok
          ? { status: execution.output.status }
          : { errorCode: execution.output.error.code }),
      });
    },
  };
}

function boundedSequence(value: number): number {
  if (!Number.isSafeInteger(value)) {
    return 1;
  }
  return Math.max(1, value);
}
