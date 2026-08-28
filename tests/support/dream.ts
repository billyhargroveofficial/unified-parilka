import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamConsolidator } from "../../src/dream/consolidator.js";
import type { DigestModelRouter } from "../../src/digests.js";
import { MessageStore } from "../../src/store.js";
import type { StoredMessage } from "../../src/store.js";
import {
  ModelRouter,
  type ResolvedModelCandidate,
} from "../../src/providers/model-router.js";
import type { DreamReviewModelOutput } from "../../src/dream/review.js";

export const DREAM_CHAT_ID = "-1003179772905";
export const DREAM_BOT_SENDER_ID = "100000000";
export const DREAM_HUMAN_SENDER_ID = "200000000";
/**
 * Fixed test clock. Moscow 'today' is 2026-08-01, so the planner's yesterday
 * is exactly DREAM_YESTERDAY; every helper that runs the planner must inject
 * this clock instead of the wall clock.
 */
export const DREAM_NOW_ISO = "2026-08-01T12:00:00.000Z";
export const DREAM_YESTERDAY = "2026-07-31";

export function dreamNow(): Date {
  return new Date(DREAM_NOW_ISO);
}

export type DreamReviewOptions = Parameters<
  typeof import("../../src/dream/review.js").runDreamReview
>[0];

export function dreamFixtureStore(prefix = "parilka-dream-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const store = new MessageStore(join(directory, "shared.sqlite"));
  store.upsertChat({
    chatId: DREAM_CHAT_ID,
    requested: DREAM_CHAT_ID,
    title: "Dream Test",
    kind: "channel",
    isForum: false,
  });
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function dreamFakeRouter(
  output: DreamReviewModelOutput,
): DigestModelRouter {
  return {
    async executeWithFallback<T>() {
      return {
        value: output as T,
        candidate: {
          reference: "provider/model",
          providerId: "provider",
          modelId: "model",
          model: {} as ResolvedModelCandidate["model"],
          capabilities: { vision: false },
        },
        attempt: 1,
        failures: [],
      };
    },
  };
}

export const DREAM_ROUTER_FIXTURE_ENV = {
  DREAM_TIMEOUT_TEST_KEY: "local-fixture-key",
} as const;

/**
 * Real ModelRouter fixture: unlike a hand-rolled fake it must invoke the
 * attempt callback and runs the production classifyModelFallback path.
 * The provider base URL is never dialed because generate is faked.
 */
export function dreamTimeoutRouter(
  summaryCandidates: readonly string[],
): ModelRouter {
  return new ModelRouter(
    {
      allowInsecureLocal: false,
      providers: [
        {
          id: "timeouttest",
          protocol: "openai",
          baseUrl: "https://timeout.example.test/v1",
          apiKeyEnv: "DREAM_TIMEOUT_TEST_KEY",
        },
      ],
      modelCapabilities: Object.fromEntries(
        summaryCandidates.map((reference) => [reference, { vision: false }]),
      ),
      roles: {
        turn: [summaryCandidates[0]],
        summary: [...summaryCandidates],
      },
    },
    { env: { ...DREAM_ROUTER_FIXTURE_ENV } },
  );
}

/** DOM-style provider abort: AbortError with the numeric DOM code 20. */
export function dreamDomAbortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Node-style provider abort: AbortError with the ABORT_ERR string code. */
export function dreamNodeAbortError(): Error {
  return Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

export function seedDreamInteraction(
  store: MessageStore,
  options: {
    day: string;
    triggerId: number;
    answerId: number;
    answerText?: string;
  },
): void {
  store.upsertMessages(
    {
      chatId: DREAM_CHAT_ID,
      requested: DREAM_CHAT_ID,
      title: "Dream Test",
      kind: "channel",
      isForum: false,
    },
    [
      {
        chatId: DREAM_CHAT_ID,
        messageId: options.triggerId,
        date: new Date(`${options.day}T12:00:00Z`).toISOString(),
        senderId: DREAM_HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "human trigger",
      },
      {
        chatId: DREAM_CHAT_ID,
        messageId: options.answerId,
        date: new Date(`${options.day}T12:00:01Z`).toISOString(),
        senderId: DREAM_BOT_SENDER_ID,
        senderName: "Bot",
        text: options.answerText ?? "bot answer",
        replyToMessageId: options.triggerId,
      },
    ],
  );
}

/** Two non-overlapping large windows that force multi-batch projection. */
export function seedDreamTwoBatches(store: MessageStore): void {
  seedDreamInteraction(store, {
    day: DREAM_YESTERDAY,
    triggerId: 1,
    answerId: 2,
    answerText: "x".repeat(80_000),
  });
  const filler: StoredMessage[] = [];
  for (let i = 3; i <= 50; i += 1) {
    filler.push({
      chatId: DREAM_CHAT_ID,
      messageId: i,
      date: new Date(
        `${DREAM_YESTERDAY}T12:${String(i).padStart(2, "0")}:00Z`,
      ).toISOString(),
      senderId: DREAM_HUMAN_SENDER_ID,
      senderName: "Alice",
      text: `filler ${i}`,
    });
  }
  store.upsertMessages(
    {
      chatId: DREAM_CHAT_ID,
      requested: DREAM_CHAT_ID,
      title: "Dream Test",
      kind: "channel",
      isForum: false,
    },
    filler,
  );
  seedDreamInteraction(store, {
    day: DREAM_YESTERDAY,
    triggerId: 51,
    answerId: 52,
    answerText: "x".repeat(80_000),
  });
}

export function makeDreamConsolidator(
  router: DigestModelRouter,
  options: {
    maxInputChars?: number;
    maxMemoryChars?: number;
    maxCandidateAttempts?: number;
    now?: () => Date;
    runReview?: typeof import("../../src/dream/review.js").runDreamReview;
    shortenMemory?: typeof import("../../src/dream/shorten-memory.js").shortenDreamMemoryBlock;
    logger?: import("../../src/observability/contracts.js").JsonEventLogger;
  } = {},
): DreamConsolidator {
  return new DreamConsolidator({
    router,
    botSenderId: DREAM_BOT_SENDER_ID,
    maxInputChars: options.maxInputChars ?? 120_000,
    maxMemoryChars: options.maxMemoryChars ?? 2_000,
    maxCandidateAttempts: options.maxCandidateAttempts,
    now: options.now ?? dreamNow,
    runReview: options.runReview,
    shortenMemory: options.shortenMemory,
    logger: options.logger,
  });
}

/** In-memory JsonEventLogger for Dream progress tests. */
export function capturingDreamLogger(): {
  logger: import("../../src/observability/contracts.js").JsonEventLogger;
  events: Array<{ level: string; event: string; fields: Record<string, unknown> }>;
} {
  const events: Array<{
    level: string;
    event: string;
    fields: Record<string, unknown>;
  }> = [];
  const push =
    (level: string) =>
    (record: Readonly<Record<string, unknown>>): void => {
      const { event, ...fields } = record as { event?: unknown } & Record<
        string,
        unknown
      >;
      events.push({
        level,
        event: typeof event === "string" ? event : "unknown",
        fields,
      });
    };
  return {
    events,
    logger: {
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

export function writeDreamKnowledge(
  store: DreamReviewOptions["store"],
  sourceMessageId: number,
): void {
  store.upsertFastChatMemory({
    chatId: DREAM_CHAT_ID,
    title: "fast-note",
    note: "staged note",
    sourceMessageId,
  });
  store.upsertChatLesson({
    chatId: DREAM_CHAT_ID,
    title: "lesson",
    problem: "p",
    solution: "s",
    whenToApply: "w",
    sourceMessageId,
  });
  store.upsertChatSkill({
    chatId: DREAM_CHAT_ID,
    name: "skill",
    description: "desc",
    instructions: "trigger; procedure; pitfalls; verify",
    sourceMessageId,
  });
}
