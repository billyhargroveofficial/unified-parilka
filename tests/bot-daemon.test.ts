import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { AppConfig } from "../src/config.js";
import {
  assertBotDaemonConfiguration,
  composeBotDaemon,
  createProductionBotDaemon,
  runBotDaemonLifecycle,
  type BotDaemonApi,
  type BotDaemonSignalSource,
} from "../src/bot-daemon.js";
import type { TurnModelRouter } from "../src/bot/ai-agent.js";
import type { BotVectorSearchPort } from "../src/bot/read-cache.js";
import type { WebSearchProvider } from "../src/bot/read-tools.js";
import { parseBotRuntimeConfig } from "../src/bot/runtime-config.js";
import type { BotWorkerDrainResult } from "../src/bot/runtime.js";
import type { JsonEventLogger } from "../src/bot/worker.js";
import { MessageStore } from "../src/store.js";

const CHAT_ID = "-1003179772905";

test("composition wires all worker slots without performing external I/O", async (t) => {
  const { store, dbPath } = fixtureStore(t);
  const config = botConfig(dbPath, {
    PARILKA_BOT_WORKERS: "2",
    PARILKA_BOT_MODEL_STEP_TIMEOUT_MS: "180000",
    PARILKA_BOT_SHUTDOWN_TIMEOUT_MS: "220000",
    // The production default allows a six-minute local audio turn. This
    PARILKA_BOT_AUDIO_TRANSCRIBE_TIMEOUT_MS: "120000",
  });
  let apiCalls = 0;
  const webSearch: WebSearchProvider = {
    async search({ query }) {
      return { text: `web:${query}` };
    },
  };
  const vector: BotVectorSearchPort = {
    async search() {
      return { available: false, hits: [] };
    },
    hybrid() {
      return [];
    },
  };
  const records: Readonly<Record<string, unknown>>[] = [];
  const composition = composeBotDaemon({
    config,
    store,
    api: noNetworkApi(() => {
      apiCalls += 1;
    }),
    router: noNetworkRouter(),
    vector,
    webSearch,
    workerIdPrefix: "test-bot",
    logger: memoryLogger((record) => records.push(record)),
  });

  assert.equal(composition.workers.length, 2);
  assert.equal(composition.coordinator.availableTurnSlots, 2);
  assert.equal(composition.poller.running, false);
  assert.equal(apiCalls, 0);
  composition.coordinator.startTurn({
    turnId: "traceable-turn",
    ownerSenderId: "42",
  });
  assert.deepEqual(records.at(-1), {
    event: "turn.started",
    turnId: "traceable-turn",
    ownerSenderId: "42",
    startWatermark: 0,
  });
  assert.deepEqual(
    await composition.readTools.callTool("web_search", {
      query: "provider swap",
    }),
    {
      ok: true,
      tool: "web_search",
      status: "done",
      result: {
        query: "provider swap",
        text: "web:provider swap",
        sourceCount: 0,
      },
      evidence: [],
    },
  );
  assert.equal(apiCalls, 0);
});

test("production factory composition is dependency-injected and defaults to shadow", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-production-"));
  const dbPath = join(directory, "shared.sqlite");
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  let apiFactoryCalls = 0;
  let routerFactoryCalls = 0;
  let vectorFactoryCalls = 0;
  const deployment = createProductionBotDaemon({
    env: botEnv(dbPath),
    appConfig: minimalAppConfig(dbPath),
    workerIdPrefix: "production-test",
    factories: {
      createApi() {
        apiFactoryCalls += 1;
        return noNetworkApi(() => {
          assert.fail("production composition performed Bot API I/O");
        });
      },
      createRouter() {
        routerFactoryCalls += 1;
        return noNetworkRouter();
      },
      createVector() {
        vectorFactoryCalls += 1;
        return {
          isConfigured: false,
          async search() {
            assert.fail("disabled vector adapter was invoked");
          },
          hybrid() {
            assert.fail("disabled vector adapter was invoked");
          },
        };
      },
    },
  });

  assert.equal(deployment.config.mode, "shadow");
  assert.equal(deployment.config.dbPath, dbPath);
  assert.equal(deployment.workers.length, 3);
  assert.equal(deployment.vectorEnabled, false);
  assert.equal(deployment.webSearchEnabled, false);
  assert.equal(apiFactoryCalls, 1);
  assert.equal(routerFactoryCalls, 1);
  assert.equal(vectorFactoryCalls, 1);
  deployment.close();
  deployment.close();
});

test("invalid model routing fails before the shared SQLite file is opened", () => {
  const dbPath = join(
    tmpdir(),
    `parilka-model-invalid-${process.pid}.sqlite`,
  );
  let storeFactoryCalls = 0;

  assert.throws(
    () =>
      createProductionBotDaemon({
        env: botEnv(dbPath),
        appConfig: minimalAppConfig(dbPath),
        factories: {
          createRouter() {
            throw new Error("invalid model routing config");
          },
          createStore() {
            storeFactoryCalls += 1;
            assert.fail("SQLite must not open after model validation fails");
          },
        },
      }),
    /invalid model routing config/u,
  );
  assert.equal(storeFactoryCalls, 0);
});

test("custom bot env cannot be mixed with app config from global process.env", () => {
  const dbPath = join(
    tmpdir(),
    `parilka-env-mixing-${process.pid}.sqlite`,
  );
  assert.throws(
    () =>
      createProductionBotDaemon({
        env: botEnv(dbPath),
      }),
    /custom bot environment requires an explicit appConfig/u,
  );
});

test("combined configuration enforces the shared DB and chat allowlist", (t) => {
  const { dbPath } = fixtureStore(t);
  const config = botConfig(dbPath);

  assert.doesNotThrow(() =>
    assertBotDaemonConfiguration(
      config,
      minimalAppConfig(dbPath),
    ),
  );
  assert.throws(
    () =>
      assertBotDaemonConfiguration(
        config,
        minimalAppConfig(`${dbPath}.other`),
      ),
    /same SQLite database/u,
  );
  assert.throws(
    () =>
      assertBotDaemonConfiguration(
        config,
        minimalAppConfig(dbPath, "-100999"),
      ),
    /TELEGRAM_ALLOWED_CHAT_IDS/u,
  );
});

test("signal lifecycle stops intake and always closes the owned store", async () => {
  const signals = new FakeSignalSource();
  let requestedStops = 0;
  let closed = 0;
  const seenSignals: string[] = [];
  const logger = memoryLogger((record) => {
    if (record.event === "bot.runtime.signal") {
      seenSignals.push(String(record.signal));
    }
  });
  const runtime = {
    async run(signal?: AbortSignal): Promise<BotWorkerDrainResult> {
      assert.ok(signal);
      return new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () =>
            resolve({
              drained: true,
              activeWorkers: 0,
            }),
          { once: true },
        );
      });
    },
    requestStop() {
      requestedStops += 1;
    },
  };

  const running = runBotDaemonLifecycle(
    {
      runtime,
      close() {
        closed += 1;
      },
      logger,
    },
    { signalSource: signals },
  );
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  const result = await running;

  assert.deepEqual(result, {
    drained: true,
    activeWorkers: 0,
  });
  assert.equal(requestedStops, 1);
  assert.equal(closed, 1);
  assert.deepEqual(seenSignals, ["SIGTERM"]);
  assert.equal(signals.listenerCount, 0);
});

test("lifecycle closes SQLite ownership when runtime startup fails", async () => {
  const signals = new FakeSignalSource();
  let closed = 0;

  await assert.rejects(
    runBotDaemonLifecycle(
      {
        runtime: {
          async run() {
            throw new Error("startup failed");
          },
          requestStop() {},
        },
        close() {
          closed += 1;
        },
      },
      { signalSource: signals },
    ),
    /startup failed/u,
  );
  assert.equal(closed, 1);
  assert.equal(signals.listenerCount, 0);
});

test("shutdown timeout never closes SQLite under a still-active worker", async () => {
  const signals = new FakeSignalSource();
  let closed = 0;
  const records: Readonly<Record<string, unknown>>[] = [];

  const result = await runBotDaemonLifecycle(
    {
      runtime: {
        async run() {
          return {
            drained: false,
            activeWorkers: 1,
          };
        },
        requestStop() {},
      },
      activeWorkerCount() {
        return 1;
      },
      close() {
        closed += 1;
      },
      logger: memoryLogger((record) => records.push(record)),
    },
    { signalSource: signals },
  );

  assert.deepEqual(result, {
    drained: false,
    activeWorkers: 1,
  });
  assert.equal(closed, 0);
  assert.equal(
    records.some(
      (record) =>
        record.event === "bot.runtime.sqlite_close_deferred" &&
        record.activeWorkers === 1,
    ),
    true,
  );
  assert.equal(signals.listenerCount, 0);
});

function fixtureStore(t: TestContext): {
  store: MessageStore;
  dbPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-daemon-"));
  const dbPath = join(directory, "shared.sqlite");
  const store = new MessageStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, dbPath };
}

function botConfig(
  dbPath: string,
  overrides: Readonly<Record<string, string>> = {},
) {
  return parseBotRuntimeConfig({
    ...botEnv(dbPath),
    ...overrides,
  });
}

function botEnv(
  dbPath: string,
): Readonly<Record<string, string>> {
  return {
    PARILKA_BOT_TOKEN:
      "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
    PARILKA_BOT_EXCLUSIVE_POLLER: "true",
    PARILKA_BOT_CHAT_ID: CHAT_ID,
    PARILKA_BOT_ID: "123456789",
    PARILKA_BOT_USERNAME: "ParilkaBot",
    PARILKA_BOT_DB_PATH: dbPath,
    TELEGRAM_DB_PATH: dbPath,
    PARILKA_BOT_MODEL_CONFIG_PATH: resolve("package.json"),
  };
}

function minimalAppConfig(
  dbPath: string,
  allowedChatId = CHAT_ID,
): AppConfig {
  return {
    storage: { dbPath },
    telegram: {
      allowedChatIds: [allowedChatId],
    },
  } as unknown as AppConfig;
}

function noNetworkRouter(): TurnModelRouter {
  return {
    async executeWithFallback<T>(): Promise<never> {
      throw new Error(
        "model router must not execute during composition",
      );
    },
  };
}

function noNetworkApi(onCall: () => void): BotDaemonApi {
  return {
    async getMe() {
      onCall();
      throw new Error("unexpected Bot API call");
    },
    async deleteWebhook() {
      onCall();
      throw new Error("unexpected Bot API call");
    },
    async getUpdates() {
      onCall();
      throw new Error("unexpected Bot API call");
    },
    async sendMessage() {
      onCall();
      throw new Error("unexpected Bot API call");
    },
  } as unknown as BotDaemonApi;
}

class FakeSignalSource implements BotDaemonSignalSource {
  readonly #listeners = new Map<
    "SIGINT" | "SIGTERM",
    (signal: NodeJS.Signals) => void
  >();

  get listenerCount(): number {
    return this.#listeners.size;
  }

  once(
    event: "SIGINT" | "SIGTERM",
    listener: (signal: NodeJS.Signals) => void,
  ): void {
    this.#listeners.set(event, listener);
  }

  off(
    event: "SIGINT" | "SIGTERM",
    listener: (signal: NodeJS.Signals) => void,
  ): void {
    if (this.#listeners.get(event) === listener) {
      this.#listeners.delete(event);
    }
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    const listener = this.#listeners.get(signal);
    if (listener) {
      this.#listeners.delete(signal);
      listener(signal);
    }
  }
}

function memoryLogger(
  onRecord: (record: Readonly<Record<string, unknown>>) => void,
): JsonEventLogger {
  return {
    info: onRecord,
    warn: onRecord,
    error: onRecord,
  };
}
