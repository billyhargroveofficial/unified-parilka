import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOOLEAN_ENV_RULES,
  loadConfig,
  redactedConfig,
} from "../src/config.js";

test("openclaw projection defaults to disabled when unset", () => {
  withEnv({ PARILKA_OPENCLAW_PROJECTION_ENABLED: undefined }, () => {
    assert.equal(loadConfig().openclawProjection!.enabled, false);
  });
});

test("openclaw projection accepts truthy boolean values", () => {
  for (const raw of ["1", "true", "yes", "on"]) {
    withEnv({ PARILKA_OPENCLAW_PROJECTION_ENABLED: raw }, () => {
      assert.equal(loadConfig().openclawProjection!.enabled, true, raw);
    });
  }
});

test("redacted config reports the openclaw kill switch without the env name", () => {
  withEnv({ PARILKA_OPENCLAW_PROJECTION_ENABLED: "1" }, () => {
    const config = redactedConfig(loadConfig()) as {
      openclawProjection: { enabled: boolean };
    };
    assert.equal(config.openclawProjection.enabled, true);
    assert.doesNotMatch(
      JSON.stringify(config),
      /PARILKA_OPENCLAW_PROJECTION_ENABLED/,
    );
  });
});

function unsetBooleanEnv(): Record<string, undefined> {
  return Object.fromEntries(
    Object.keys(BOOLEAN_ENV_RULES).map((name) => [name, undefined]),
  ) as Record<string, undefined>;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "telegram-config-oc-"));
  const applied: Record<string, string | undefined> = {
    TELEGRAM_DB_PATH: join(dir, "messages.sqlite"),
    TELEGRAM_DEFAULT_CHAT_ID: "-1000000000000",
    TELEGRAM_ALLOWED_CHAT_IDS: "-1000000000000",
    ...unsetBooleanEnv(),
    ...vars,
  };
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(applied)) {
    previous.set(key, process.env[key]);
    const value = applied[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
