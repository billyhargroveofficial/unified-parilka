import type { ModelAttemptRecord, ModelRole } from "./contracts.js";

export interface ModelRouterConfigIssue {
  path: string;
  message: string;
}

export type ModelRouterConfigErrorCode =
  | "invalid_config"
  | "missing_environment"
  | "config_read_failed"
  | "invalid_json";

export class ModelRouterConfigError extends Error {
  readonly name = "ModelRouterConfigError";

  constructor(
    readonly code: ModelRouterConfigErrorCode,
    message: string,
    readonly issues: readonly ModelRouterConfigIssue[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export type ModelRouterResolutionErrorCode =
  | "invalid_candidate"
  | "unknown_provider"
  | "unknown_role"
  | "model_resolution_failed";

export class ModelRouterResolutionError extends Error {
  readonly name = "ModelRouterResolutionError";

  constructor(
    readonly code: ModelRouterResolutionErrorCode,
    message: string,
    readonly reference?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export class ModelContentFilterError extends Error {
  readonly name = "ModelContentFilterError";
  readonly code = "content_filter";
  readonly finishReason = "content-filter";
}

export class ModelProviderResponseTooLargeError extends Error {
  readonly name = "ModelProviderResponseTooLargeError";
  readonly code = "MODEL_RESPONSE_TOO_LARGE";
  readonly modelFallback = true;

  constructor(maxResponseBytes: number) {
    super(
      `Model provider response exceeded ${maxResponseBytes} bytes.`,
    );
  }
}

export type ModelRoutingErrorCode = "terminal_error" | "candidates_exhausted";

export class ModelRoutingError extends Error {
  readonly name = "ModelRoutingError";

  constructor(
    readonly code: ModelRoutingErrorCode,
    readonly role: ModelRole,
    readonly attempts: readonly ModelAttemptRecord[],
    cause: unknown,
  ) {
    super(
      code === "candidates_exhausted"
        ? `All configured candidates for role "${role}" failed.`
        : `Model candidate for role "${role}" failed with a non-fallback error.`,
      { cause },
    );
  }
}
