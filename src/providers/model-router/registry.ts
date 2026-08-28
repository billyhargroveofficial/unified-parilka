import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import {
  createProviderRegistry,
  type ProviderRegistryProvider,
} from "ai";
import {
  REDACTED,
  type ModelCapabilities,
  type ModelRouterEnvironment,
  type ModelRouterInspection,
  type ModelRouterOptions,
  type ModelRole,
  type ResolvedModelCandidate,
} from "./contracts.js";
import {
  modelCandidateSchema,
  parseModelRouterConfig,
  requireEnvironmentValue,
  resolveHeaders,
  splitCandidate,
  type ModelRouterConfig,
} from "./config.js";
import { hardenedProviderFetch } from "./hardened-fetch.js";
import { ModelRouterResolutionError } from "./errors.js";

type ConfiguredProvider =
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createDeepSeek>
  | ReturnType<typeof createAnthropic>;
export type ModelProviderRegistry =
  ProviderRegistryProvider<Record<string, ConfiguredProvider>>;

export class ModelProviderResolver {
  readonly registry: ModelProviderRegistry;
  readonly #config: ModelRouterConfig;
  readonly #providerIds: ReadonlySet<string>;

  constructor(input: unknown, options: ModelRouterOptions = {}) {
    const env = options.env ?? process.env;
    this.#config = parseModelRouterConfig(input, { env });
    this.#providerIds = new Set(this.#config.providers.map(({ id }) => id));

    const providers: Record<string, ConfiguredProvider> = {};
    for (const provider of this.#config.providers) {
      const apiKey = requireEnvironmentValue(env, provider.apiKeyEnv);
      const headers = resolveHeaders(provider.headers, env);
      providers[provider.id] =
        provider.protocol === "anthropic"
          ? createAnthropic({
              name: provider.id,
              baseURL: provider.baseUrl,
              apiKey,
              headers,
              fetch: hardenedProviderFetch,
            })
          : provider.protocol === "deepseek"
            ? createDeepSeek({
                baseURL: provider.baseUrl,
                apiKey,
                headers,
                fetch: hardenedProviderFetch,
              })
          : createOpenAIChatCompletionsProvider({
              name: provider.id,
              baseURL: provider.baseUrl,
              apiKey,
              headers,
            });
    }
    this.registry = createProviderRegistry(providers);
  }


  resolveCandidate(reference: string): ResolvedModelCandidate {
    const result = modelCandidateSchema.safeParse(reference);
    if (!result.success) {
      throw new ModelRouterResolutionError(
        "invalid_candidate",
        'Model candidate must use a valid "provider:model" reference.',
        reference,
        result.error,
      );
    }
    const parts = splitCandidate(result.data);
    if (!parts) {
      throw new ModelRouterResolutionError(
        "invalid_candidate",
        'Model candidate must use a valid "provider:model" reference.',
        reference,
      );
    }
    if (!this.#providerIds.has(parts.providerId)) {
      throw new ModelRouterResolutionError(
        "unknown_provider",
        `Unknown model provider "${parts.providerId}".`,
        result.data,
      );
    }

    try {
      const provider = this.#config.providers.find(
        ({ id }) => id === parts.providerId,
      );
      const providerOptions =
        provider?.protocol === "deepseek"
          ? {
              deepseek: {
                thinking: {
                  type: provider.thinkingMode ?? "disabled",
                },
              },
            }
          : provider?.reasoningEffort
            ? {
                openai: {
                  reasoningEffort: provider.reasoningEffort,
                },
              }
            : undefined;
      return {
        reference: result.data,
        ...parts,
        model: this.registry.languageModel(result.data as `${string}:${string}`),
        capabilities: this.capabilitiesFor(result.data),
        ...(providerOptions === undefined ? {} : { providerOptions }),
      };
    } catch (error) {
      throw new ModelRouterResolutionError(
        "model_resolution_failed",
        `Could not resolve model candidate "${result.data}".`,
        result.data,
        error,
      );
    }
  }

  resolveRole(role: ModelRole): ResolvedModelCandidate[] {
    const candidates = this.#config.roles[role];
    if (!candidates) {
      throw new ModelRouterResolutionError("unknown_role", `Unknown model role "${String(role)}".`);
    }
    return candidates.map((candidate) => this.resolveCandidate(candidate));
  }

  inspectConfig(): ModelRouterInspection {
    return {
      allowInsecureLocal: this.#config.allowInsecureLocal,
      providers: this.#config.providers.map((provider) => ({
        id: provider.id,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        ...(provider.protocol === "deepseek"
          ? { thinkingMode: provider.thinkingMode ?? "disabled" }
          : {}),
        ...(provider.protocol === "openai" && provider.reasoningEffort
          ? { reasoningEffort: provider.reasoningEffort }
          : {}),
        apiKey: {
          env: provider.apiKeyEnv,
          value: REDACTED,
        },
        headers: Object.fromEntries(
          Object.entries(provider.headers ?? {}).map(([headerName, reference]) => [
            headerName,
            {
              env: reference.env,
              value: REDACTED,
            },
          ]),
        ),
      })),
      roles: {
        turn: [...this.#config.roles.turn],
        summary: [...this.#config.roles.summary],
      },
      modelCapabilities: Object.fromEntries(
        Object.entries(this.#config.modelCapabilities).map(
          ([reference, capabilities]) => [reference, { ...capabilities }],
        ),
      ),
    };
  }

  private capabilitiesFor(reference: string): ModelCapabilities {
    const configured = this.#config.modelCapabilities[reference];
    return configured ? { ...configured } : { vision: false };
  }
}

/**
 * `protocol: "openai"` means the broadly supported Chat Completions wire
 * format. The AI SDK's generic OpenAI provider defaults its callable and
 * `languageModel()` surfaces to the newer Responses API, which turns a valid
 * OpenAI-compatible endpoint such as DeepSeek into a `/responses` 404.
 *
 * Keep the complete provider surface for the registry, but make both generic
 * language-model entrypoints resolve to `.chat()`.
 */
function createOpenAIChatCompletionsProvider(options: {
  name: string;
  baseURL: string;
  apiKey: string;
  headers: Record<string, string> | undefined;
}): ReturnType<typeof createOpenAI> {
  const provider = createOpenAI({
    ...options,
    fetch: hardenedProviderFetch,
  });
  return Object.assign(
    (modelId: string) => provider.chat(modelId),
    provider,
    {
      languageModel: (modelId: string) => provider.chat(modelId),
    },
  );
}
