import type { LanguageModel } from "ai";

export const MODEL_ROLES = ["turn", "summary"] as const;
export const MAX_MODEL_CANDIDATES_PER_ROLE = 8;
export const REDACTED = "[REDACTED]" as const;

export type ModelRole = (typeof MODEL_ROLES)[number];
export type ModelRouterEnvironment = Readonly<Record<string, string | undefined>>;
export type ModelReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ModelFallbackReason =
  | "abort"
  | "auth"
  | "validation"
  | "content_filter"
  | "invalid_output"
  | "rate_limit"
  | "server_error"
  | "transport"
  | "client_error"
  | "other";

export interface ModelFallbackDecision {
  fallback: boolean;
  reason: ModelFallbackReason;
}

/**
 * Explicit model features that callers may rely on. Capabilities are declared
 * per exact `provider:model` reference, rather than inferred from provider or
 * model names. An undeclared model is deliberately featureless.
 */
export interface ModelCapabilities {
  vision: boolean;
  /**
   * Declared maximum context window in tokens for this exact model reference.
   * Telemetry rendering uses it as the denominator of the occupancy display;
   * it is never guessed from the model name. Absent when not declared.
   */
  contextWindowTokens?: number;
}

export interface ResolvedModelCandidate {
  reference: string;
  providerId: string;
  modelId: string;
  model: LanguageModel;
  capabilities: ModelCapabilities;
  providerOptions?: {
    deepseek?: {
      thinking: {
        type: "enabled" | "disabled";
      };
    };
    openai?: {
      reasoningEffort: ModelReasoningEffort;
    };
  };
}

export interface ModelAttemptRecord {
  candidate: string;
  providerId: string;
  modelId: string;
  attempt: number;
  decision: ModelFallbackDecision;
}


export interface ModelRouterInspection {
  allowInsecureLocal: boolean;
  providers: Array<{
    id: string;
    protocol: "anthropic" | "openai" | "deepseek";
    baseUrl: string;
    thinkingMode?: "enabled" | "disabled";
    reasoningEffort?: ModelReasoningEffort;
    apiKey: {
      env: string;
      value: typeof REDACTED;
    };
    headers: Record<
      string,
      {
        env: string;
        value: typeof REDACTED;
      }
    >;
  }>;
  roles: Record<ModelRole, string[]>;
  modelCapabilities: Record<string, ModelCapabilities>;
}

export interface ModelExecutionResult<T> {
  value: T;
  candidate: ResolvedModelCandidate;
  attempt: number;
  failures: readonly ModelAttemptRecord[];
}

export interface ModelRouterOptions {
  env?: ModelRouterEnvironment;
}
