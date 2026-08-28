import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDigestCli } from "../src/digest-cli/run.js";
import { SCHEMA_VERSION } from "../src/storage/constants.js";
import { MessageStore } from "../src/store.js";
import {
  capturingDreamLogger,
  DREAM_BOT_SENDER_ID,
  DREAM_CHAT_ID,
} from "./support/dream.js";

const MODEL_KEY_ENV = "PARILKA_DREAM_CLI_TEST_KEY";

function capturedOutput(): {
  output: Pick<NodeJS.Process, "stdout" | "stderr">;
  stdoutText: () => string;
  stderrText: () => string;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const output = {
    stdout: {
      write(chunk: unknown): boolean {
        stdoutChunks.push(String(chunk));
        return true;
      },
    },
    stderr: {
      write(chunk: unknown): boolean {
        stderrChunks.push(String(chunk));
        return true;
      },
    },
  } as unknown as Pick<NodeJS.Process, "stdout" | "stderr">;
  return {
    output,
    stdoutText: () => stdoutChunks.join(""),
    stderrText: () => stderrChunks.join(""),
  };
}

/**
 * Local loopback model-router fixture. Empty Dream days never start a model
 * call, so the base URL is configured but never dialed.
 */
function writeLocalModelRouterFixture(path: string): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        allowInsecureLocal: true,
        providers: [
          {
            id: "localdream",
            protocol: "openai",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKeyEnv: MODEL_KEY_ENV,
          },
        ],
        modelCapabilities: {
          "localdream:dream-test": { vision: false },
        },
        roles: {
          turn: ["localdream:dream-test"],
          summary: ["localdream:dream-test"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("runDigestCli wires the injected logger through a real Dream pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-cli-dream-"));
  const dbPath = join(directory, "shared.sqlite");
  const modelConfigPath = join(directory, "model-router.json");
  const previousKeyValue = process.env[MODEL_KEY_ENV];
  process.env[MODEL_KEY_ENV] = "local-fixture-key";
  const { logger, events } = capturingDreamLogger();
  const { output, stdoutText, stderrText } = capturedOutput();
  try {
    const setup = new MessageStore(dbPath);
    assert.equal(setup.getSchemaVersion(), SCHEMA_VERSION);
    setup.upsertChat({
      chatId: DREAM_CHAT_ID,
      requested: DREAM_CHAT_ID,
      title: "Digest CLI Dream Test",
      kind: "channel",
      isForum: false,
    });
    setup.close();
    writeLocalModelRouterFixture(modelConfigPath);

    const exitCode = await runDigestCli(
      [
        "--apply",
        "--dream-only",
        "--chat",
        DREAM_CHAT_ID,
        "--db",
        dbPath,
        "--model-config",
        modelConfigPath,
        "--bot-id",
        DREAM_BOT_SENDER_ID,
      ],
      {},
      output,
      { logger },
    );

    assert.equal(stderrText(), "");
    assert.equal(exitCode, 0);
    const report = JSON.parse(stdoutText()) as {
      mode: string;
      dream: { status: string; reviewedDays?: number };
    };
    // The empty Dream-only digest report must carry the actual run mode,
    // never a false dry_run label in apply mode.
    assert.equal(report.mode, "applied");
    assert.equal(report.dream.status, "success");
    assert.equal(report.dream.reviewedDays, 0);

    // Bootstrap seeds seven empty Dream days; the injected logger must see
    // the real progress events for each of them.
    const dayStarted = events.filter((e) => e.event === "bot.dream.day_started");
    const dayCompleted = events.filter(
      (e) => e.event === "bot.dream.day_completed",
    );
    assert.equal(dayStarted.length, 7);
    assert.equal(dayCompleted.length, 7);
    for (const started of dayStarted) {
      assert.equal(started.fields.chatId, DREAM_CHAT_ID);
      assert.equal(started.fields.interactionCount, 0);
      assert.equal(started.fields.batchCount, 0);
    }
    // Empty days must not start batches, i.e. the configured provider is
    // never dialed during this run.
    assert.equal(
      events.some((e) => e.event === "bot.dream.batch_started"),
      false,
    );
    assert.equal(events.some((e) => e.level !== "info"), false);

    const verify = new MessageStore(dbPath, { readOnly: true });
    try {
      const days = verify.listDreamDays({ chatId: DREAM_CHAT_ID });
      assert.equal(days.length, 7);
      assert.ok(days.every((day) => day.status === "completed"));
    } finally {
      verify.close();
    }
  } finally {
    if (previousKeyValue === undefined) {
      delete process.env[MODEL_KEY_ENV];
    } else {
      process.env[MODEL_KEY_ENV] = previousKeyValue;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
