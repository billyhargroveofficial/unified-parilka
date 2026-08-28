import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  parseBotRuntimeConfig,
  safeBotRuntimeConfig,
} from "../src/bot/runtime-config.js";

// ─── Runtime config contract ────────────────────────────────────────────────

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

test("bot runtime config defaults the web tool endpoints", () => {
  const config = parseBotRuntimeConfig(VALID_ENV);
  assert.equal(config.searxngEndpoint, "http://127.0.0.1:8080");
  assert.equal(config.firecrawlEndpoint, "http://127.0.0.1:3002");
  const safe = safeBotRuntimeConfig(config);
  assert.equal(safe.searxngEndpoint, "http://127.0.0.1:8080");
  assert.equal(safe.firecrawlEndpoint, "http://127.0.0.1:3002");
});

test("bot runtime config rejects invalid web tool endpoints", () => {
  for (const endpoint of [
    "https://127.0.0.1:8080",
    "http://example.com:8080",
    "http://10.0.0.1:8080",
    "http://127.0.0.1:8080/search",
    "http://127.0.0.1:8080?q=1",
    "http://user:pass@127.0.0.1:8080",
  ]) {
    assert.throws(
      () => parseBotRuntimeConfig({
        ...VALID_ENV,
        PARILKA_BOT_SEARXNG_ENDPOINT: endpoint,
      }),
      undefined,
    );
  }
  assert.throws(
    () => parseBotRuntimeConfig({
      ...VALID_ENV,
      PARILKA_BOT_FIRECRAWL_ENDPOINT: "http://example.com:3002",
    }),
  );
});
