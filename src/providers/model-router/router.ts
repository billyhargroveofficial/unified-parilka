import type {
  ModelAttemptRecord,
  ModelExecutionResult,
  ModelRouterInspection,
  ModelRouterOptions,
  ModelRole,
  ResolvedModelCandidate,
} from "./contracts.js";
import { readModelRouterConfigJson } from "./config.js";
import { ModelRoutingError } from "./errors.js";
import {
  ModelProviderResolver,
  type ModelProviderRegistry,
} from "./registry.js";
import { abortErrorFrom, classifyModelFallback } from "./fallback.js";

export class ModelRouter {
  readonly registry: ModelProviderRegistry;
  readonly #resolver: ModelProviderResolver;

  constructor(input: unknown, options: ModelRouterOptions = {}) {
    this.#resolver = new ModelProviderResolver(input, options);
    this.registry = this.#resolver.registry;
  }

  static fromFile(path: string, options: ModelRouterOptions = {}): ModelRouter {
    return new ModelRouter(readModelRouterConfigJson(path), options);
  }

  resolveCandidate(reference: string): ResolvedModelCandidate {
    return this.#resolver.resolveCandidate(reference);
  }

  resolveRole(role: ModelRole): ResolvedModelCandidate[] {
    return this.#resolver.resolveRole(role);
  }

  inspectConfig(): ModelRouterInspection {
    return this.#resolver.inspectConfig();
  }

  async executeWithFallback<T>(
    role: ModelRole,
    attempt: (candidate: ResolvedModelCandidate, attemptNumber: number) => Promise<T>,
  ): Promise<ModelExecutionResult<T>> {
    const candidates = this.resolveRole(role);
    const failures: ModelAttemptRecord[] = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const attemptNumber = index + 1;
      try {
        return {
          value: await attempt(candidate, attemptNumber),
          candidate,
          attempt: attemptNumber,
          failures,
        };
      } catch (error) {
        const decision = classifyModelFallback(error);
        failures.push({
          candidate: candidate.reference,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          attempt: attemptNumber,
          decision,
        });

        // Cancellation is control flow, not a provider failure. Preserve the
        // AbortError identity so callers can stop work without accidentally
        // turning a shutdown/deadline into a retryable model failure.
        if (decision.reason === "abort") {
          throw abortErrorFrom(error);
        }
        if (decision.fallback && attemptNumber < candidates.length) {
          continue;
        }
        throw new ModelRoutingError(
          decision.fallback ? "candidates_exhausted" : "terminal_error",
          role,
          failures,
          error,
        );
      }
    }

    throw new ModelRoutingError("candidates_exhausted", role, failures, undefined);
  }
}
