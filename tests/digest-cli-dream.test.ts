import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDigestCli, type RunDigestCliDeps } from "../src/digest-cli/run.js";
import type { SummaryTextRunner } from "../src/digest/summary-text-port.js";
import type { DreamTextRunner } from "../src/dream/text-runner.js";
import { SCHEMA_VERSION } from "../src/storage/constants.js";
import { MessageStore } from "../src/store.js";
import {
  capturingDreamLogger,
  DREAM_BOT_SENDER_ID,
  DREAM_CHAT_ID,
} from "./support/dream.js";

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

test("runDigestCli wires the injected logger through a real Dream pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-cli-dream-"));
  const dbPath = join(directory, "shared.sqlite");
  const authPath = join(directory, "codex-auth.json");
  writeFileSync(authPath, "{}\n", { mode: 0o600 });
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
    const exitCode = await runDigestCli(
      [
        "--apply",
        "--dream-only",
        "--chat",
        DREAM_CHAT_ID,
        "--db",
        dbPath,
        "--bot-id",
        DREAM_BOT_SENDER_ID,
      ],
      {
        PARILKA_DIGEST_CODEX_AUTH_FILE: authPath,
      },
      output,
      { logger, createResponsesRunner: fakeResponsesRunners },
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
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dry-run does not require a Responses credential or construct its runner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digest-cli-dry-run-"));
  const dbPath = join(directory, "shared.sqlite");
  const { output, stderrText } = capturedOutput();
  let constructed = 0;
  try {
    const setup = new MessageStore(dbPath);
    setup.upsertChat({
      chatId: DREAM_CHAT_ID,
      requested: DREAM_CHAT_ID,
      title: "Digest CLI Dry Run Test",
      kind: "channel",
      isForum: false,
    });
    setup.close();

    const exitCode = await runDigestCli(
      ["--chat", DREAM_CHAT_ID, "--db", dbPath],
      {},
      output,
      {
        createResponsesRunner: () => {
          constructed += 1;
          throw new Error("must not construct Responses in dry-run");
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderrText(), "");
    assert.equal(constructed, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const fakeResponsesRunners: NonNullable<RunDigestCliDeps["createResponsesRunner"]> = () => {
  const runner = {
    async runText(options: Parameters<SummaryTextRunner["runText"]>[0] | Parameters<DreamTextRunner["runText"]>[0]) {
      if ("dynamicTools" in options) {
        return {
          text: "unused",
          finishReason: "stop",
          toolCalls: 0,
          model: "gpt-5.6-luna",
          providerId: "openai-responses",
        };
      }
      return {
        text: "unused",
        model: "gpt-5.6-luna",
        providerId: "openai-responses",
      };
    },
  } as SummaryTextRunner & DreamTextRunner;
  return { summary: runner, dream: runner };
};
