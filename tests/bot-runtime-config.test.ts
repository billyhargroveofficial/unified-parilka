import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  parseBotRuntimeConfig,
  safeBotRuntimeConfig,
} from "../src/bot/runtime-config.js";

const VALID_ENV = {
  PARILKA_BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
  PARILKA_BOT_EXCLUSIVE_POLLER: "true",
  PARILKA_BOT_CHAT_ID: "-1003179772905",
  PARILKA_BOT_ID: "123456789",
  PARILKA_BOT_USERNAME: "@ParilkaBot",
  PARILKA_BOT_DB_PATH: "/tmp/parilka-runtime.sqlite",
  TELEGRAM_DB_PATH: "/tmp/parilka-runtime.sqlite",
  PARILKA_BOT_MODEL_CONFIG_PATH: resolve("package.json"),
} as const;

test("bot runtime config is strict, bounded, and defaults to safe shadow mode", () => {
  const config = parseBotRuntimeConfig(VALID_ENV);

  assert.equal(config.allowedChatId, "-1003179772905");
  assert.equal(config.botId, "123456789");
  assert.equal(config.botUsername, "ParilkaBot");
  assert.equal(config.mode, "shadow");
  assert.equal(config.modelConfigPath, resolve("package.json"));
  assert.equal("allowedMentions" in config, false);
  assert.equal(config.workerConcurrency, 3);
  assert.equal(config.triggerCooldownMs, 5_000);
  assert.equal(config.updateMaxAttempts, 3);
  assert.deepEqual(config.memoryWriteAuthorizerIds, []);
  assert.equal(config.initialOffset, undefined);
  assert.equal(config.pollLimit, 100);
  assert.equal(config.pollTimeoutSec, 30);
  assert.equal(config.modelStepTimeoutMs, 180_000);
  assert.equal(config.publishTimeoutMs, 30_000);
  assert.equal(config.shutdownTimeoutMs, 660_000);
  assert.deepEqual(config.audioTranscribe, {
    endpoint: "http://127.0.0.1:17432",
    timeoutMs: 300_000,
  });
});

test("memory-write authorizers are a private, normalized, fail-closed allowlist", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    PARILKA_BOT_MEMORY_WRITE_SENDER_IDS: " 42, 00084 ",
  });
  assert.deepEqual(config.memoryWriteAuthorizerIds, ["42", "84"]);

  const safe = safeBotRuntimeConfig(config);
  assert.equal(safe.memoryWriteAuthorizerCount, 2);
  assert.equal("memoryWriteAuthorizerIds" in safe, false);
  assert.doesNotMatch(JSON.stringify(safe), /"42"|"84"/u);

  assert.throws(
    () => parseBotRuntimeConfig({
      ...VALID_ENV,
      PARILKA_BOT_MEMORY_WRITE_SENDER_IDS: "42,,84",
    }),
    /comma-separated list/u,
  );
  assert.throws(
    () => parseBotRuntimeConfig({
      ...VALID_ENV,
      PARILKA_BOT_MEMORY_WRITE_SENDER_IDS: "42,-84",
    }),
    /positive Telegram id/u,
  );
  assert.throws(
    () => parseBotRuntimeConfig({
      ...VALID_ENV,
      PARILKA_BOT_MEMORY_WRITE_SENDER_IDS: "42,00042",
    }),
    /duplicate Telegram user IDs/u,
  );
});

test("audio transcription stays on a bounded local Flov endpoint", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    PARILKA_BOT_AUDIO_TRANSCRIBE_ENDPOINT: "http://[::1]:17432",
    PARILKA_BOT_AUDIO_TRANSCRIBE_TIMEOUT_MS: "420000",
  });
  assert.deepEqual(config.audioTranscribe, {
    endpoint: "http://[::1]:17432",
    timeoutMs: 420_000,
  });
  assert.equal(
    parseBotRuntimeConfig({
      ...VALID_ENV,
      PARILKA_BOT_AUDIO_TRANSCRIBE_ENDPOINT: "http://flov.localhost:17432",
    }).audioTranscribe.endpoint,
    "http://flov.localhost:17432",
  );
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_AUDIO_TRANSCRIBE_ENDPOINT:
          "http://flov.example.test:17432",
      }),
    /loopback/u,
  );
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_AUDIO_TRANSCRIBE_TIMEOUT_MS: "600001",
      }),
    /PARILKA_BOT_AUDIO_TRANSCRIBE_TIMEOUT_MS/u,
  );
  assert.equal(
    parseBotRuntimeConfig({
      ...VALID_ENV,
      PARILKA_BOT_MODEL_STEP_TIMEOUT_MS: "240000",
    }).modelStepTimeoutMs,
    240_000,
  );
});

test("Flov bearer credentials remain secret while safe inspection exposes configuration", () => {
  const secret = "private-flov-bearer-token";
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    PARILKA_BOT_AUDIO_TRANSCRIBE_BEARER_TOKEN: secret,
  });
  const safe = safeBotRuntimeConfig(config);

  assert.equal(config.audioTranscribe.bearerToken, secret);
  assert.deepEqual(safe.audioTranscribe, {
    endpoint: "http://127.0.0.1:17432",
    timeoutMs: 300_000,
    bearerTokenConfigured: true,
  });
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(secret, "u"));
  assert.throws(
    () => parseBotRuntimeConfig({
      ...VALID_ENV,
      PARILKA_BOT_AUDIO_TRANSCRIBE_BEARER_TOKEN: "bad\nheader",
    }),
    /AUDIO_TRANSCRIBE_BEARER_TOKEN/u,
  );
});

test("a migration offset is explicit, bounded, and visible in safe config", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    PARILKA_BOT_INITIAL_OFFSET: "123456789",
  });

  assert.equal(config.initialOffset, 123456789);
  assert.equal(safeBotRuntimeConfig(config).initialOffset, 123456789);
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_INITIAL_OFFSET: "-1",
      }),
    /PARILKA_BOT_INITIAL_OFFSET/u,
  );
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_INITIAL_OFFSET: String(Number.MAX_SAFE_INTEGER),
      }),
    /PARILKA_BOT_INITIAL_OFFSET/u,
  );
});

test("bot cannot claim getUpdates ownership implicitly, even in shadow mode", () => {
  const {
    PARILKA_BOT_EXCLUSIVE_POLLER: _confirmation,
    ...unconfirmed
  } = VALID_ENV;
  assert.throws(
    () => parseBotRuntimeConfig(unconfirmed),
    /PARILKA_BOT_EXCLUSIVE_POLLER/u,
  );
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_EXCLUSIVE_POLLER: "TRUE",
      }),
    /must be exactly true/u,
  );
});

test("bot and shared services cannot silently diverge onto separate databases", () => {
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        TELEGRAM_DB_PATH: "/tmp/parilka-shared.sqlite",
      }),
    /same shared SQLite file/u,
  );
});

test("model config must be an existing absolute regular file", () => {
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_MODEL_CONFIG_PATH: "models.json",
      }),
    /must be an absolute path/u,
  );
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_MODEL_CONFIG_PATH:
          "/definitely/missing/parilka-models.json",
      }),
    /existing regular file/u,
  );
});

test("optional web search is endpoint-neutral and secrets stay out of safe config", () => {
  const secret = "private-web-search-token";
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    PARILKA_BOT_WEB_SEARCH_ENDPOINT:
      "https://search.example.test/v1/query",
    PARILKA_BOT_WEB_SEARCH_BEARER_TOKEN_ENV:
      "PARILKA_TEST_WEB_TOKEN",
    PARILKA_TEST_WEB_TOKEN: secret,
  });
  const safe = safeBotRuntimeConfig(config);

  assert.deepEqual(safe.webSearch, {
    kind: "http",
    endpoint: "https://search.example.test/v1/query",
    bearerTokenConfigured: true,
  });
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(secret, "u"));
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_WEB_SEARCH_ENDPOINT:
          "http://search.example.test/query",
      }),
    /must use HTTPS/u,
  );
});

test("vertex web search is enabled by provider flag and exposes no secrets", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    PARILKA_BOT_WEB_SEARCH_PROVIDER: "vertex",
  });
  const safe = safeBotRuntimeConfig(config);

  assert.deepEqual(safe.webSearch, {
    kind: "vertex",
    project: "project-2eb13fe3-79a9-4d2b-83c",
    model: "gemini-3.6-flash",
    region: "global",
    maxOutputTokens: 2000,
    gcloudPathConfigured: false,
  });
  assert.equal(config.webSearch?.kind, "vertex");
});

test("vertex web search honors explicit project and gcloud path", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    PARILKA_BOT_WEB_SEARCH_PROVIDER: "vertex",
    PARILKA_VERTEX_PROJECT: "project-custom-123",
    PARILKA_GCLOUD_PATH: "~/.local/bin/gcloud",
  });

  assert.equal(config.webSearch?.kind, "vertex");
  if (config.webSearch?.kind !== "vertex") {
    throw new Error("expected vertex web search config");
  }
  assert.equal(config.webSearch.project, "project-custom-123");
  assert.ok(config.webSearch.gcloudPath?.endsWith("/gcloud"));
  const safe = safeBotRuntimeConfig(config);
  assert.equal(
    safe.webSearch?.kind === "vertex"
      ? safe.webSearch.gcloudPathConfigured
      : undefined,
    true,
  );
});

test("auto web search stays disabled without endpoint or vertex project", () => {
  const config = parseBotRuntimeConfig(VALID_ENV);
  const safe = safeBotRuntimeConfig(config);

  assert.equal(config.webSearch, undefined);
  assert.equal(safe.webSearch, undefined);
});

test("private research gateway exposes only enablement and timeout in safe config", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    PARILKA_BOT_RESEARCH_GATEWAY_SOCKET:
      "/run/user/1000/hh-research-gateway/gateway.sock",
    PARILKA_BOT_RESEARCH_GATEWAY_TIMEOUT_MS: "23000",
  });
  const safe = safeBotRuntimeConfig(config);

  assert.equal(
    config.researchGateway?.socketPath,
    "/run/user/1000/hh-research-gateway/gateway.sock",
  );
  assert.deepEqual(safe.researchGateway, {
    configured: true,
    timeoutMs: 23_000,
  });
  assert.doesNotMatch(JSON.stringify(safe), /hh-research-gateway\/gateway\.sock/u);
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_RESEARCH_GATEWAY_SOCKET: "relative.sock",
      }),
    /absolute Unix socket path/u,
  );
});

test("explicit http provider without endpoint is rejected", () => {
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_WEB_SEARCH_PROVIDER: "http",
      }),
    /PARILKA_BOT_WEB_SEARCH_ENDPOINT is required/u,
  );
});

test("safe config projection cannot expose the Bot API token", () => {
  const config = parseBotRuntimeConfig(VALID_ENV);
  const safe = safeBotRuntimeConfig(config);
  const serialized = JSON.stringify(safe);

  assert.equal(safe.tokenConfigured, true);
  assert.equal("token" in safe, false);
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz_ABCD/u);
});

test("secret validation errors never interpolate the rejected token", () => {
  const secret = "THIS_IS_A_PRIVATE_BUT_INVALID_TOKEN";
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_TOKEN: secret,
      }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.doesNotMatch((error as Error).message, new RegExp(secret, "u"));
      return true;
    },
  );
});

test("one negative chat, pinned bot identity, and at most three workers are enforced", () => {
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_CHAT_ID: "123",
      }),
    /negative Telegram id/u,
  );
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_ID: "-123",
      }),
    /positive Telegram id/u,
  );
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_USERNAME: "not-a-username",
      }),
    /Telegram bot username/u,
  );
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_WORKERS: "4",
      }),
    /between 1 and 3/u,
  );
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_POLL_BACKOFF_INITIAL_MS: "2000",
        PARILKA_BOT_POLL_BACKOFF_MAX_MS: "1000",
    }),
    /must be greater than or equal/u,
  );
  assert.throws(
    () => parseBotRuntimeConfig({
      ...VALID_ENV,
      PARILKA_BOT_MODEL_STEP_TIMEOUT_MS: "900001",
    }),
    /PARILKA_BOT_MODEL_STEP_TIMEOUT_MS/u,
  );
});
