import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { z } from "zod";
import {
  MAX_MODEL_CANDIDATES_PER_ROLE,
  MODEL_ROLES,
  type ModelReasoningEffort,
  type ModelRouterEnvironment,
  type ModelRouterOptions,
} from "./contracts.js";
import {
  ModelRouterConfigError,
  type ModelRouterConfigIssue,
} from "./errors.js";

const MAX_PROVIDERS = 32;
const MAX_HEADERS_PER_PROVIDER = 32;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,199}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelReasoningEffort[];

const providerIdSchema = z
  .string()
  .trim()
  .regex(
    PROVIDER_ID_PATTERN,
    "Provider id must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens (max 64).",
  );

export const modelCandidateSchema = z
  .string()
  .trim()
  .max(265)
  .superRefine((candidate, context) => {
    const parts = splitCandidate(candidate);
    if (!parts) {
      context.addIssue({
        code: "custom",
        message: 'Candidate must use the "provider:model" format.',
      });
      return;
    }
    if (!PROVIDER_ID_PATTERN.test(parts.providerId)) {
      context.addIssue({
        code: "custom",
        message: "Candidate provider id is invalid.",
      });
    }
    if (!MODEL_ID_PATTERN.test(parts.modelId)) {
      context.addIssue({
        code: "custom",
        message:
          "Model id must start with a letter or digit and contain only letters, digits, dots, underscores, slashes, @, colons, plus signs, or hyphens (max 200).",
      });
    }
  });

const envNameSchema = z
  .string()
  .trim()
  .regex(ENV_NAME_PATTERN, "Environment reference must be a valid environment variable name.");

const headerEnvRefSchema = z
  .object({
    env: envNameSchema,
  })
  .strict();

const providerSchema = z
  .object({
    id: providerIdSchema,
    protocol: z.enum(["anthropic", "openai", "deepseek"]),
    baseUrl: z.string().trim().min(1).max(2_048),
    apiKeyEnv: envNameSchema,
    headers: z.record(z.string(), headerEnvRefSchema).optional(),
    thinkingMode: z.enum(["enabled", "disabled"]).optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  })
  .strict();

const modelCapabilitiesSchema = z
  .object({
    vision: z.boolean(),
    // Declared per exact model reference; telemetry renders an unknown
    // denominator as "?" instead of guessing from the model name.
    contextWindowTokens: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();

const roleCandidatesSchema = z
  .array(modelCandidateSchema)
  .min(1)
  .max(
    MAX_MODEL_CANDIDATES_PER_ROLE,
    `A role can contain at most ${MAX_MODEL_CANDIDATES_PER_ROLE} candidates.`,
  );

export const modelRouterConfigSchema = z
  .object({
    allowInsecureLocal: z.boolean().default(false),
    providers: z.array(providerSchema).min(1).max(MAX_PROVIDERS),
    // Capabilities are declared per exact model reference: two models behind
    // one provider can differ. Missing entries resolve fail-closed later.
    modelCapabilities: z
      .record(modelCandidateSchema, modelCapabilitiesSchema)
      .default({}),
    roles: z
      .object({
        turn: roleCandidatesSchema,
        summary: roleCandidatesSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const providerIds = new Set<string>();

    config.providers.forEach((provider, providerIndex) => {
      if (providerIds.has(provider.id)) {
        context.addIssue({
          code: "custom",
          path: ["providers", providerIndex, "id"],
          message: `Duplicate provider id "${provider.id}".`,
        });
      }
      providerIds.add(provider.id);

      const urlError = validateBaseUrl(provider.baseUrl, config.allowInsecureLocal);
      if (urlError) {
        context.addIssue({
          code: "custom",
          path: ["providers", providerIndex, "baseUrl"],
          message: urlError,
        });
      }

      const headers = Object.entries(provider.headers ?? {});
      if (
        provider.thinkingMode !== undefined &&
        provider.protocol !== "deepseek"
      ) {
        context.addIssue({
          code: "custom",
          path: ["providers", providerIndex, "thinkingMode"],
          message: "thinkingMode is supported only by the deepseek protocol.",
        });
      }
      if (
        provider.reasoningEffort !== undefined &&
        provider.protocol !== "openai"
      ) {
        context.addIssue({
          code: "custom",
          path: ["providers", providerIndex, "reasoningEffort"],
          message: "reasoningEffort is supported only by the openai protocol.",
        });
      }
      if (headers.length > MAX_HEADERS_PER_PROVIDER) {
        context.addIssue({
          code: "custom",
          path: ["providers", providerIndex, "headers"],
          message: `A provider can contain at most ${MAX_HEADERS_PER_PROVIDER} headers.`,
        });
      }
      const normalizedHeaders = new Set<string>();
      headers.forEach(([headerName], headerIndex) => {
        if (!HEADER_NAME_PATTERN.test(headerName)) {
          context.addIssue({
            code: "custom",
            path: ["providers", providerIndex, "headers", headerName],
            message: "Header name must be a valid HTTP token.",
          });
        }
        const normalized = headerName.toLowerCase();
        if (normalizedHeaders.has(normalized)) {
          context.addIssue({
            code: "custom",
            path: ["providers", providerIndex, "headers", headerName],
            message: `Duplicate case-insensitive header name at index ${headerIndex}.`,
          });
        }
        normalizedHeaders.add(normalized);
      });
    });

    Object.keys(config.modelCapabilities).forEach((candidate) => {
      const parts = splitCandidate(candidate);
      if (parts && !providerIds.has(parts.providerId)) {
        context.addIssue({
          code: "custom",
          path: ["modelCapabilities", candidate],
          message: `Unknown provider "${parts.providerId}".`,
        });
      }
    });

    for (const role of MODEL_ROLES) {
      const candidates = config.roles[role];
      const seenCandidates = new Set<string>();
      candidates.forEach((candidate, candidateIndex) => {
        if (seenCandidates.has(candidate)) {
          context.addIssue({
            code: "custom",
            path: ["roles", role, candidateIndex],
            message: `Duplicate candidate "${candidate}" in role "${role}".`,
          });
        }
        seenCandidates.add(candidate);

        const parts = splitCandidate(candidate);
        if (parts && !providerIds.has(parts.providerId)) {
          context.addIssue({
            code: "custom",
            path: ["roles", role, candidateIndex],
            message: `Unknown provider "${parts.providerId}".`,
          });
        }
      });
    }
  });

export type ModelRouterConfig = z.infer<typeof modelRouterConfigSchema>;

export function parseModelRouterConfig(
  input: unknown,
  options: ModelRouterOptions = {},
): ModelRouterConfig {
  const result = modelRouterConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
    throw new ModelRouterConfigError(
      "invalid_config",
      `Invalid model router config: ${issues.map(formatIssue).join("; ")}`,
      issues,
      result.error,
    );
  }

  const env = options.env ?? process.env;
  const missing = missingEnvironmentIssues(result.data, env);
  if (missing.length > 0) {
    throw new ModelRouterConfigError(
      "missing_environment",
      `Model router environment is incomplete: ${missing.map(formatIssue).join("; ")}`,
      missing,
    );
  }
  return result.data;
}

export function loadModelRouterConfigFile(
  path: string,
  options: ModelRouterOptions = {},
): ModelRouterConfig {
  return parseModelRouterConfig(readModelRouterConfigJson(path), options);
}

export function readModelRouterConfigJson(path: string): unknown {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new ModelRouterConfigError(
      "config_read_failed",
      `Could not read model router config file "${path}".`,
      [],
      error,
    );
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new ModelRouterConfigError(
      "invalid_json",
      `Model router config file "${path}" is not valid JSON.`,
      [],
      error,
    );
  }
}

export function splitCandidate(candidate: string): { providerId: string; modelId: string } | undefined {
  const separator = candidate.indexOf(":");
  if (separator <= 0 || separator === candidate.length - 1) {
    return undefined;
  }
  return {
    providerId: candidate.slice(0, separator),
    modelId: candidate.slice(separator + 1),
  };
}

function validateBaseUrl(raw: string, allowInsecureLocal: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Provider baseUrl must be an absolute URL.";
  }
  if (url.username || url.password || url.search || url.hash) {
    return "Provider baseUrl cannot contain credentials, query parameters, or a fragment.";
  }
  if (url.protocol === "https:") {
    return undefined;
  }
  if (url.protocol === "http:" && allowInsecureLocal && isLoopbackHostname(url.hostname)) {
    return undefined;
  }
  return "Provider baseUrl must use HTTPS; HTTP is allowed only for a loopback host when allowInsecureLocal is true.";
}

function isLoopbackHostname(rawHostname: string): boolean {
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return normalized.split(".")[0] === "127";
  }
  return ipVersion === 6 && (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1");
}

function missingEnvironmentIssues(
  config: ModelRouterConfig,
  env: ModelRouterEnvironment,
): ModelRouterConfigIssue[] {
  const issues: ModelRouterConfigIssue[] = [];
  config.providers.forEach((provider, providerIndex) => {
    if (!environmentValue(env, provider.apiKeyEnv)) {
      issues.push({
        path: `providers.${providerIndex}.apiKeyEnv`,
        message: `Environment variable "${provider.apiKeyEnv}" is missing or empty.`,
      });
    }
    for (const [headerName, reference] of Object.entries(provider.headers ?? {})) {
      if (!environmentValue(env, reference.env)) {
        issues.push({
          path: `providers.${providerIndex}.headers.${headerName}.env`,
          message: `Environment variable "${reference.env}" is missing or empty.`,
        });
      }
    }
  });
  return issues;
}

export function resolveHeaders(
  references: Record<string, { env: string }> | undefined,
  env: ModelRouterEnvironment,
): Record<string, string> | undefined {
  if (!references || Object.keys(references).length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(references).map(([headerName, reference]) => [
      headerName,
      requireEnvironmentValue(env, reference.env),
    ]),
  );
}

export function requireEnvironmentValue(env: ModelRouterEnvironment, name: string): string {
  const value = environmentValue(env, name);
  if (!value) {
    throw new ModelRouterConfigError(
      "missing_environment",
      `Environment variable "${name}" is missing or empty.`,
      [{ path: name, message: `Environment variable "${name}" is missing or empty.` }],
    );
  }
  return value;
}

function environmentValue(env: ModelRouterEnvironment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function formatIssue(issue: ModelRouterConfigIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}
