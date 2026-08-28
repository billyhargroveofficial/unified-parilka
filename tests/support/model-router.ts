import assert from "node:assert/strict";
import { APICallError } from "ai";
import {
  ModelRouter,
  ModelRouterConfigError,
  type ModelRouterConfig,
} from "../../src/providers/model-router.js";

export const ENV = {
  OPENAI_SUBSCRIPTION_A: "openai-secret-a",
  ANTHROPIC_SUBSCRIPTION: "anthropic-secret",
  TENANT_HEADER_A: "tenant-secret-a",
} as const;

export function config(): ModelRouterConfig {
  return {
    allowInsecureLocal: false,
    providers: [
      {
        id: "openai_primary",
        protocol: "openai",
        baseUrl: "https://gateway-a.example.test/openai/v1",
        apiKeyEnv: "OPENAI_SUBSCRIPTION_A",
        headers: {
          "x-tenant-id": {
            env: "TENANT_HEADER_A",
          },
        },
      },
      {
        id: "anthropic_backup",
        protocol: "anthropic",
        baseUrl: "https://gateway.example.test/anthropic/v1",
        apiKeyEnv: "ANTHROPIC_SUBSCRIPTION",
      },
    ],
    modelCapabilities: {
      "openai_primary:gpt-5.6": { vision: true },
      "openai_primary:gpt-5.6-mini": { vision: false },
      "anthropic_backup:claude-sonnet-4-6": { vision: true },
    },
    roles: {
      turn: [
        "openai_primary:gpt-5.6",
        "anthropic_backup:claude-sonnet-4-6",
      ],
      summary: ["openai_primary:gpt-5.6-mini"],
    },
  };
}

export function expectInvalidConfig(
  input: unknown,
  message: RegExp,
  env: Record<string, string> = ENV,
): void {
  assert.throws(
    () => new ModelRouter(input, { env }),
    (error) => {
      assert.ok(error instanceof ModelRouterConfigError);
      assert.equal(error.code, "invalid_config");
      assert.match(error.message, message);
      return true;
    },
  );
}

export function apiError(statusCode?: number, isRetryable?: boolean): APICallError {
  return new APICallError({
    message: `provider failed${statusCode == null ? "" : ` (${statusCode})`}`,
    url: "https://provider.example.test/v1/messages",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

export function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw.");
}
