import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_MODEL_CANDIDATES_PER_ROLE,
  ModelProviderResponseTooLargeError,
  classifyModelFallback,
  createHardenedProviderFetch,
} from "../src/providers/model-router.js";
import {
  config,
  ENV,
  expectInvalidConfig,
} from "./support/model-router.js";

test("provider fetch rejects redirects before credentials can be replayed", async () => {
  let observedRedirect: string | undefined;
  const providerFetch = createHardenedProviderFetch({
    transport: async (_input, init) => {
      observedRedirect = init?.redirect;
      throw new TypeError("fetch failed: redirect mode is error");
    },
  });

  await assert.rejects(
    () =>
      providerFetch("https://provider.example.test/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
        body: '{"prompt":"private"}',
        redirect: "follow",
      }),
    /redirect mode is error/u,
  );
  assert.equal(observedRedirect, "error");
});

test("provider fetch caps declared and streamed response bodies", async () => {
  let declaredCancelled = false;
  const declared = createHardenedProviderFetch({
    maxResponseBytes: 4,
    transport: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            declaredCancelled = true;
          },
        }),
        { headers: { "content-length": "5" } },
      ),
  });
  await assert.rejects(
    () => declared("https://provider.example.test"),
    ModelProviderResponseTooLargeError,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(declaredCancelled, true);

  let streamedCancelled = false;
  const streamed = createHardenedProviderFetch({
    maxResponseBytes: 4,
    transport: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1, 2, 3));
            controller.enqueue(Uint8Array.of(4, 5));
          },
          cancel() {
            streamedCancelled = true;
          },
        }),
      ),
  });
  const response = await streamed(
    "https://provider.example.test",
  );
  await assert.rejects(
    () => response.arrayBuffer(),
    ModelProviderResponseTooLargeError,
  );
  assert.equal(streamedCancelled, true);
  assert.deepEqual(
    classifyModelFallback(
      new ModelProviderResponseTooLargeError(4),
    ),
    { fallback: true, reason: "invalid_output" },
  );
});

test("unknown providers, duplicates, invalid ids, and oversized role chains are rejected", () => {
  const unknown = config();
  unknown.roles.turn = ["missing:gpt-5.6"];
  expectInvalidConfig(unknown, /Unknown provider "missing"/);

  const duplicate = config();
  duplicate.providers.push({
    ...duplicate.providers[0]!,
    apiKeyEnv: "DUPLICATE_KEY",
  });
  expectInvalidConfig(duplicate, /Duplicate provider id "openai_primary"/, {
    ...ENV,
    DUPLICATE_KEY: "duplicate-secret",
  });

  const invalidProvider = config();
  invalidProvider.providers[0]!.id = "OpenAI primary";
  expectInvalidConfig(invalidProvider, /Provider id must start/);

  const invalidModel = config();
  invalidModel.roles.turn = ["openai_primary:model with spaces"];
  expectInvalidConfig(invalidModel, /Model id must start/);

  const oversized = config();
  oversized.roles.turn = Array.from(
    { length: MAX_MODEL_CANDIDATES_PER_ROLE + 1 },
    (_, index) => `openai_primary:model-${index}`,
  );
  expectInvalidConfig(oversized, /at most 8 candidates/);
});

test("literal API keys and literal header values are not part of the accepted schema", () => {
  const literalSecretInput = {
    ...config(),
    providers: [
      {
        ...config().providers[0],
        apiKey: "literal-secret",
        headers: {
          authorization: "literal-secret",
        },
      },
    ],
    roles: {
      turn: ["openai_primary:gpt-5.6"],
      summary: ["openai_primary:gpt-5.6-mini"],
    },
  };

  expectInvalidConfig(literalSecretInput, /Unrecognized key|expected object/i);
});
