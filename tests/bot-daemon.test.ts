import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { composeBotDaemon, createProductionBotDaemon } from "../src/bot-daemon.js";
import { parseBotRuntimeConfig } from "../src/bot/runtime-config.js";
import type { BotTurnAgent } from "../src/bot/agent-contract.js";
import type { BotDaemonApi } from "../src/bot-daemon.js";
import { MessageStore } from "../src/store.js";

test("Responses composition is inert until the poller starts", async (t) => {
  const fixture = botFixture(t);
  const store = new MessageStore(fixture.config.dbPath);
  t.after(() => store.close());
  let apiCalls = 0;
  let agentCalls = 0;
  const daemon = composeBotDaemon({
    config: fixture.config,
    store,
    api: fakeApi(() => { apiCalls += 1; }),
    createAgent: () => fakeAgent(() => { agentCalls += 1; }),
  });
  assert.equal(daemon.workers.length, 1);
  assert.equal(daemon.poller.running, false);
  assert.equal(apiCalls, 0);
  assert.equal(agentCalls, 0);
  await daemon.close();
});

test("production factory validates before wiring and accepts offline Responses fakes", async (t) => {
  const fixture = botFixture(t);
  let preflight = 0;
  let apiCloses = 0;
  let vectorConfig: ReturnType<typeof parseBotRuntimeConfig>["rag"] | undefined;
  const daemon = createProductionBotDaemon({
    env: fixture.env,
    factories: {
      preflight: () => { preflight += 1; },
      createApi: () => ({
        ...fakeApi(() => assert.fail("no Bot API call during composition")),
        async close() { apiCloses += 1; },
      }),
      createVector: (_store, config) => {
        vectorConfig = config.rag;
        return undefined;
      },
      createAgent: () => fakeAgent(() => assert.fail("no Responses turn during composition")),
    },
  });
  t.after(async () => daemon.close());
  assert.equal(preflight, 1);
  assert.equal(daemon.config.responses.model, "gpt-5.6-luna");
  assert.equal(daemon.config.responses.serviceTier, "fast");
  assert.equal(vectorConfig?.vector.embeddings.backend, "local_bge_m3");
  assert.equal(daemon.workerPump.activeWorkers, 0);
  await daemon.close();
  await daemon.close();
  assert.equal(apiCloses, 1);
});

test("default synchronous configuration check requires owner-only writable Codex auth state", async (t) => {
  const fixture = botFixture(t);
  const daemon = createProductionBotDaemon({
    env: fixture.env,
    factories: {
      createApi: () => fakeApi(() => undefined),
      createAgent: () => fakeAgent(() => undefined),
      createVector: () => undefined,
    },
  });
  await daemon.close();
  chmodSync(fixture.authPath, 0o644);
  assert.throws(
    () => createProductionBotDaemon({ env: fixture.env }),
    /PARILKA_BOT_CODEX_AUTH_FILE must have mode 0600/u,
  );
});

function botFixture(t: TestContext): {
  env: Record<string, string>;
  authPath: string;
  config: ReturnType<typeof parseBotRuntimeConfig>;
} {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-daemon-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const authPath = join(directory, "codex-auth");
  writeFileSync(authPath, '{"auth_mode":"chatgpt","tokens":{"access_token":"fake","refresh_token":"fake"}}', { mode: 0o600 });
  chmodSync(authPath, 0o600);
  const dbPath = join(directory, "shared.sqlite");
  const env = {
    PARILKA_BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
    PARILKA_BOT_EXCLUSIVE_POLLER: "true",
    PARILKA_BOT_CHAT_ID: "-1003179772905",
    PARILKA_BOT_ID: "123456789",
    PARILKA_BOT_USERNAME: "ParilkaBot",
    PARILKA_BOT_DB_PATH: dbPath,
    TELEGRAM_DB_PATH: dbPath,
    PARILKA_BOT_CODEX_AUTH_FILE: authPath,
  };
  return { env, authPath, config: parseBotRuntimeConfig(env) };
}

function fakeApi(onCall: () => void): BotDaemonApi {
  return {
    async getMe() { onCall(); return { id: 123456789, is_bot: true, username: "ParilkaBot" }; },
    async deleteWebhook() { onCall(); return true; },
    async getUpdates() { onCall(); return []; },
    async sendMessage() { onCall(); return {}; },
    async sendRichMessage() { onCall(); return {}; },
    async sendTransientMessage() { onCall(); return {}; },
    async sendChatAction() { onCall(); },
    async editMessageText() { onCall(); return {}; },
    async deleteMessage() { onCall(); return true; },
    async getFile() { onCall(); return { filePath: "photos/file.jpg" }; },
    async downloadFile() { onCall(); return new Response(new Uint8Array([1])); },
  };
}

function fakeAgent(onCall: () => void): BotTurnAgent & { close(): Promise<void> } {
  return {
    async run() {
      onCall();
      return {
        kind: "final",
        text: "reply",
        telemetry: {
          finalModelId: "gpt-5.6-luna",
          finalProviderId: "openai-responses",
          steps: [],
          toolCalls: 0,
          durationMs: 0,
          incomplete: false,
        },
      };
    },
    async close() {},
  };
}
