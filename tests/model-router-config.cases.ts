import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ModelRouter,
  ModelRouterConfigError,
  loadModelRouterConfigFile,
  type ModelRouterConfig,
} from "../src/providers/model-router.js";
import {
  config,
  ENV,
  expectInvalidConfig,
} from "./support/model-router.js";

test("endpoints, subscriptions, and ordered role models swap through config only", () => {
  const first = new ModelRouter(config(), { env: ENV });
  const swappedInput = structuredClone(config());
  swappedInput.providers[0] = {
    ...swappedInput.providers[0]!,
    baseUrl: "https://gateway-b.example.test/openai/v1",
    apiKeyEnv: "OPENAI_SUBSCRIPTION_B",
    headers: {
      "x-tenant-id": { env: "TENANT_HEADER_B" },
    },
  };
  swappedInput.roles.turn = [
    "anthropic_backup:claude-sonnet-4-6",
    "openai_primary:gpt-5.6-terra",
  ];
  const second = new ModelRouter(swappedInput, {
    env: {
      ...ENV,
      OPENAI_SUBSCRIPTION_B: "openai-secret-b",
      TENANT_HEADER_B: "tenant-secret-b",
    },
  });

  assert.equal(
    first.inspectConfig().providers[0]?.baseUrl,
    "https://gateway-a.example.test/openai/v1",
  );
  assert.deepEqual(second.inspectConfig().providers[0], {
    id: "openai_primary",
    protocol: "openai",
    baseUrl: "https://gateway-b.example.test/openai/v1",
    apiKey: {
      env: "OPENAI_SUBSCRIPTION_B",
      value: "[REDACTED]",
    },
    headers: {
      "x-tenant-id": {
        env: "TENANT_HEADER_B",
        value: "[REDACTED]",
      },
    },
  });
  assert.deepEqual(
    second.resolveRole("turn").map(({ reference }) => reference),
    [
      "anthropic_backup:claude-sonnet-4-6",
      "openai_primary:gpt-5.6-terra",
    ],
  );

  const resolvedModel = second.resolveCandidate(
    "openai_primary:gpt-5.6-terra",
  );
  assert.equal(resolvedModel.modelId, "gpt-5.6-terra");
  assert.deepEqual(resolvedModel.capabilities, { vision: false });
  assert.equal(
    (resolvedModel.model as { provider?: string }).provider,
    "openai_primary.chat",
  );
});

test("capabilities are validated per exact model reference and default fail-closed", () => {
  const router = new ModelRouter(config(), { env: ENV });

  assert.deepEqual(
    router.resolveCandidate("openai_primary:gpt-5.6").capabilities,
    { vision: true },
  );
  assert.deepEqual(
    router.resolveCandidate("openai_primary:not-declared").capabilities,
    { vision: false },
  );
  assert.deepEqual(router.inspectConfig().modelCapabilities, {
    "openai_primary:gpt-5.6": { vision: true },
    "openai_primary:gpt-5.6-mini": { vision: false },
    "anthropic_backup:claude-sonnet-4-6": { vision: true },
  });

  const unknownProvider = config();
  unknownProvider.modelCapabilities["missing:model"] = { vision: true };
  expectInvalidConfig(unknownProvider, /Unknown provider "missing"/);

  const malformedReference = config();
  Object.assign(malformedReference.modelCapabilities, {
    "not a model reference": { vision: true },
  });
  expectInvalidConfig(malformedReference, /Invalid key in record/);

  const unknownCapability = config();
  Object.assign(unknownCapability.modelCapabilities, {
    "openai_primary:gpt-vision": { vision: true, audio: true },
  });
  expectInvalidConfig(unknownCapability, /Unrecognized key: "audio"/);
});

test("contextWindowTokens is declared per exact model reference and validated", () => {
  const input = config();
  input.modelCapabilities["openai_primary:gpt-5.6"] = {
    vision: true,
    contextWindowTokens: 1_000_000,
  };
  const router = new ModelRouter(input, { env: ENV });

  assert.deepEqual(
    router.resolveCandidate("openai_primary:gpt-5.6").capabilities,
    { vision: true, contextWindowTokens: 1_000_000 },
  );
  // Undeclared references stay unknown rather than guessed from the name.
  assert.deepEqual(
    router.resolveCandidate("openai_primary:gpt-5.6-mini").capabilities,
    { vision: false },
  );
  assert.deepEqual(router.inspectConfig().modelCapabilities["openai_primary:gpt-5.6"], {
    vision: true,
    contextWindowTokens: 1_000_000,
  });

  for (const contextWindowTokens of [
    0,
    -1,
    1.5,
    "1000000",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const invalid = config();
    invalid.modelCapabilities["openai_primary:gpt-5.6"] = {
      vision: true,
      contextWindowTokens: contextWindowTokens as never,
    };
    expectInvalidConfig(invalid, /contextWindowTokens/);
  }
});

test("production router config targets DeepSeek V4 Flash for both roles", () => {
  const path = fileURLToPath(
    new URL("../config/model-router.production.json", import.meta.url),
  );
  const parsed = loadModelRouterConfigFile(path, {
    env: { PARILKA_DEEPSEEK_API_KEY: "test-placeholder" },
  });

  assert.deepEqual(parsed.providers, [
    {
      id: "deepseek",
      protocol: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "PARILKA_DEEPSEEK_API_KEY",
      thinkingMode: "enabled",
    },
  ]);
  assert.deepEqual(parsed.roles, {
    turn: ["deepseek:deepseek-v4-flash"],
    summary: ["deepseek:deepseek-v4-flash"],
  });
  assert.deepEqual(parsed.modelCapabilities, {
    "deepseek:deepseek-v4-flash": {
      vision: false,
      contextWindowTokens: 1_000_000,
    },
  });
  assert.doesNotMatch(JSON.stringify(parsed), /qwen/i);

  const router = new ModelRouter(parsed, {
    env: { PARILKA_DEEPSEEK_API_KEY: "test-placeholder" },
  });
  assert.equal(router.inspectConfig().providers[0]?.thinkingMode, "enabled");
  assert.deepEqual(
    router.resolveCandidate("deepseek:deepseek-v4-flash").providerOptions,
    {
      deepseek: {
        thinking: {
          type: "enabled",
        },
      },
    },
  );
  assert.deepEqual(
    router.resolveRole("turn").map(({ reference }) => reference),
    ["deepseek:deepseek-v4-flash"],
  );
  assert.deepEqual(
    router.resolveRole("summary").map(({ reference }) => reference),
    ["deepseek:deepseek-v4-flash"],
  );
});

test("JSON files use the same schema and do not perform provider requests", () => {
  const directory = mkdtempSync(join(tmpdir(), "model-router-"));
  const path = join(directory, "providers.json");
  try {
    writeFileSync(path, JSON.stringify(config()));

    assert.deepEqual(loadModelRouterConfigFile(path, { env: ENV }).roles, config().roles);
    const router = ModelRouter.fromFile(path, { env: ENV });
    assert.deepEqual(
      router.resolveRole("summary").map(({ reference }) => reference),
      ["openai_primary:gpt-5.6-mini"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DeepSeek uses its native adapter and disables thinking by default", () => {
  const input: ModelRouterConfig = {
    allowInsecureLocal: false,
    providers: [
      {
        id: "deepseek_primary",
        protocol: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_SUBSCRIPTION",
      },
    ],
    modelCapabilities: {
      "deepseek_primary:deepseek-v4-flash": { vision: false },
    },
    roles: {
      turn: ["deepseek_primary:deepseek-v4-flash"],
      summary: ["deepseek_primary:deepseek-v4-flash"],
    },
  };
  const router = new ModelRouter(input, {
    env: { DEEPSEEK_SUBSCRIPTION: "deepseek-secret" },
  });
  const candidate = router.resolveCandidate(
    "deepseek_primary:deepseek-v4-flash",
  );

  assert.equal(
    (candidate.model as { provider?: string }).provider,
    "deepseek.chat",
  );
  assert.deepEqual(candidate.providerOptions, {
    deepseek: {
      thinking: {
        type: "disabled",
      },
    },
  });
  assert.equal(
    router.inspectConfig().providers[0]?.thinkingMode,
    "disabled",
  );
});

test("OpenAI-compatible provider profiles may lower reasoning effort per role", () => {
  const input = config();
  input.providers[0]!.reasoningEffort = "low";
  const router = new ModelRouter(input, { env: ENV });
  const candidate = router.resolveCandidate("openai_primary:gpt-5.6-mini");

  assert.deepEqual(candidate.providerOptions, {
    openai: {
      reasoningEffort: "low",
    },
  });
  assert.equal(router.inspectConfig().providers[0]?.reasoningEffort, "low");
});

test("inspect output redacts every resolved secret while retaining env references", () => {
  const router = new ModelRouter(config(), { env: ENV });
  const inspection = router.inspectConfig();
  const serialized = JSON.stringify(inspection);

  for (const secret of Object.values(ENV)) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /OPENAI_SUBSCRIPTION_A/);
  assert.match(serialized, /ANTHROPIC_SUBSCRIPTION/);
  assert.match(serialized, /TENANT_HEADER_A/);
  assert.equal(
    inspection.providers.every(({ apiKey }) => apiKey.value === "[REDACTED]"),
    true,
  );
  assert.equal(
    Object.values(inspection.providers[0]?.headers ?? {}).every(
      ({ value }) => value === "[REDACTED]",
    ),
    true,
  );
});

test("missing API key and header environment variables fail before registry use", () => {
  assert.throws(
    () =>
      new ModelRouter(config(), {
        env: {
          ANTHROPIC_SUBSCRIPTION: "present",
        },
      }),
    (error) => {
      assert.ok(error instanceof ModelRouterConfigError);
      assert.equal(error.code, "missing_environment");
      assert.deepEqual(
        error.issues.map(({ path }) => path),
        [
          "providers.0.apiKeyEnv",
          "providers.0.headers.x-tenant-id.env",
        ],
      );
      assert.doesNotMatch(error.message, /openai-secret|tenant-secret/);
      return true;
    },
  );
});

test("provider URLs require HTTPS except explicitly enabled loopback HTTP", () => {
  for (const [baseUrl, allowInsecureLocal] of [
    ["http://remote.example.test/v1", false],
    ["http://remote.example.test/v1", true],
    ["http://127.0.0.1:11434/v1", false],
    ["https://user:secret@remote.example.test/v1", false],
    ["https://remote.example.test/v1?api_key=secret", false],
  ] as const) {
    const input = config();
    input.allowInsecureLocal = allowInsecureLocal;
    input.providers[0]!.baseUrl = baseUrl;
    assert.throws(
      () => new ModelRouter(input, { env: ENV }),
      (error) =>
        error instanceof ModelRouterConfigError &&
        error.code === "invalid_config" &&
        error.issues.some(({ path }) => path === "providers.0.baseUrl"),
      baseUrl,
    );
  }

  const local = config();
  local.allowInsecureLocal = true;
  local.providers[0]!.baseUrl = "http://127.0.0.1:11434/v1";
  assert.doesNotThrow(() => new ModelRouter(local, { env: ENV }));

  const unsupportedThinking = config();
  unsupportedThinking.providers[0]!.thinkingMode = "disabled";
  expectInvalidConfig(
    unsupportedThinking,
    /thinkingMode is supported only by the deepseek protocol/,
  );

  const unsupportedReasoning = config();
  unsupportedReasoning.providers[1]!.reasoningEffort = "low";
  expectInvalidConfig(
    unsupportedReasoning,
    /reasoningEffort is supported only by the openai protocol/,
  );
});
