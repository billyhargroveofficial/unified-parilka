import assert from "node:assert/strict";
import { test } from "node:test";
import { GrammyError, HttpError } from "grammy";
import {
  GrammyBotTurnPublisher,
  type GrammyBotApiPort,
  type GrammyRichMessageOptions,
  type GrammySendMessageOptions,
} from "../src/bot/grammy-publisher.js";
import type { TelegramPublication } from "../src/bot/telegram-publication.js";

const SCREENSHOT_MARKDOWN = [
  "| Метрика | Значение |",
  "| --- | --- |",
  "| Инлайн | $E = mc^2$ |",
  "",
  "Блок:",
  "$$\\int_a^b f(x)\\,dx$$",
].join("\n");

const BASE_RICH_OPTIONS: GrammyRichMessageOptions = {
  reply_parameters: {
    message_id: 99,
    allow_sending_without_reply: false,
  },
};

const BASE_PLAIN_OPTIONS: GrammySendMessageOptions = {
  reply_parameters: {
    message_id: 99,
    allow_sending_without_reply: false,
  },
  link_preview_options: { is_disabled: true },
};

interface RichCall {
  chatId: string;
  richMessage: { markdown: string; skip_entity_detection: true };
  plainText: string;
  options: GrammyRichMessageOptions;
  signal: AbortSignal;
}

interface PlainCall {
  chatId: string;
  text: string;
  options: GrammySendMessageOptions;
  signal: AbortSignal;
}

interface FakeApiOptions {
  richResult?: () => unknown;
  plainResult?: () => unknown;
}

function makeFakeApi(fakeOptions: FakeApiOptions = {}) {
  const richCalls: RichCall[] = [];
  const plainCalls: PlainCall[] = [];
  const api: GrammyBotApiPort = {
    async sendRichMessage(input) {
      richCalls.push({
        chatId: input.chatId,
        richMessage: input.richMessage,
        plainText: input.plainText,
        options: input.options,
        signal: input.signal,
      });
      return fakeOptions.richResult?.() ?? { message_id: 701 };
    },
    async sendMessage(chatId, text, options, signal) {
      plainCalls.push({ chatId, text, options, signal });
      return fakeOptions.plainResult?.() ?? { message_id: 702 };
    },
  };
  return { api, richCalls, plainCalls };
}

function richPublication(
  markdown = "**привет**",
  plainText = "привет",
  maxChunkUtf16 = 4_096,
): TelegramPublication {
  return { mode: "rich", markdown, plainText, maxChunkUtf16 };
}

function plainPublication(
  plainText: string,
  maxChunkUtf16 = 4_096,
): TelegramPublication {
  return { mode: "plain", plainText, maxChunkUtf16 };
}

function request(publication: TelegramPublication, replyToMessageId = 99) {
  return {
    chatId: "-1004242",
    replyToMessageId,
    publication,
    signal: new AbortController().signal,
  };
}

test("publishes a rich publication as one native sendRichMessage with skip_entity_detection", async () => {
  const { api, richCalls, plainCalls } = makeFakeApi();
  const publisher = new GrammyBotTurnPublisher(api);
  const publishRequest = request(richPublication("**привет**"));

  const result = await publisher.publish(publishRequest);

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 1,
    telegramMessageId: 701,
  });
  assert.equal(richCalls.length, 1);
  assert.equal(plainCalls.length, 0);
  assert.deepEqual(richCalls[0]!.richMessage, {
    markdown: "**привет**",
    skip_entity_detection: true,
  });
  assert.deepEqual(richCalls[0]!.options, BASE_RICH_OPTIONS);
  assert.equal(richCalls[0]!.chatId, "-1004242");
  assert.equal(richCalls[0]!.signal, publishRequest.signal);
});

test("screenshot fixture reaches the fake port untouched and never calls the classic path", async () => {
  const { api, richCalls, plainCalls } = makeFakeApi();
  const publisher = new GrammyBotTurnPublisher(api);

  const result = await publisher.publish(
    request(richPublication(SCREENSHOT_MARKDOWN, "table")),
  );

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 1,
    telegramMessageId: 701,
  });
  assert.equal(richCalls.length, 1);
  assert.equal(plainCalls.length, 0);
  assert.equal(richCalls[0]!.richMessage.markdown, SCREENSHOT_MARKDOWN);
  assert.equal(richCalls[0]!.richMessage.skip_entity_detection, true);
  assert.equal("entities" in richCalls[0]!.richMessage, false);
  assert.equal("parse_mode" in richCalls[0]!.options, false);
  assert.equal("html" in richCalls[0]!.richMessage, false);
  assert.equal("blocks" in richCalls[0]!.richMessage, false);
});

test("a parser-related 400 before ACK opens exactly one classic plain fallback", async () => {
  let richCalls = 0;
  let plainCalls = 0;
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      richCalls += 1;
      throw telegramError(400, "Bad Request: can't parse markdown");
    },
    async sendMessage(chatId, text, options, signal) {
      plainCalls += 1;
      assert.equal(chatId, "-1004242");
      assert.deepEqual(options, BASE_PLAIN_OPTIONS);
      assert.equal(signal instanceof AbortSignal, true);
      return { message_id: 501 };
    },
  };
  const publisher = new GrammyBotTurnPublisher(api);

  const result = await publisher.publish(
    request(richPublication("**x**", "canonical plain text")),
  );

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 1,
    telegramMessageId: 501,
  });
  assert.equal(richCalls, 1);
  assert.equal(plainCalls, 1);
});

test("a long canonical plain text is losslessly split across fallback chunks at the guarded limit", async () => {
  const plainText = "x".repeat(200);
  const sentTexts: string[] = [];
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      throw telegramError(400, "can't parse markdown");
    },
    async sendMessage(chatId, text, options, signal) {
      sentTexts.push(text);
      return { message_id: 500 + sentTexts.length };
    },
  };

  const result = await new GrammyBotTurnPublisher(api).publish(
    request(richPublication("**x**", plainText, 64)),
  );

  assert.deepEqual(sentTexts.map((text) => text.length), [64, 64, 64, 8]);
  assert.equal(sentTexts.join(""), plainText);
  assert.deepEqual(result, {
    ok: true,
    chunksSent: 4,
    telegramMessageId: 501,
  });
});

test("the fallback is attempted at most once: a second parse 400 never resends", async () => {
  let plainCalls = 0;
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      throw telegramError(400, "can't parse markdown");
    },
    async sendMessage() {
      plainCalls += 1;
      throw telegramError(400, "can't parse entities");
    },
  };

  const result = await new GrammyBotTurnPublisher(api).publish(
    request(richPublication("**x**", "plain")),
  );

  assert.equal(plainCalls, 1);
  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: {
      kind: "telegram_rejected",
      code: "TELEGRAM_400",
      retryable: false,
    },
  });
});

test("a generic 400 is not masked as a parse failure and never opens the fallback", async () => {
  let plainCalls = 0;
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      throw telegramError(400, "Bad Request: message is too long");
    },
    async sendMessage() {
      plainCalls += 1;
      return { message_id: 1 };
    },
  };

  const result = await new GrammyBotTurnPublisher(api).publish(
    request(richPublication("**x**", "plain")),
  );

  assert.equal(plainCalls, 0);
  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: {
      kind: "telegram_rejected",
      code: "TELEGRAM_400",
      retryable: false,
    },
  });
});

test("timeout, network and aborted signals never resend", async (t) => {
  await t.test("HttpError stays network without fallback", async () => {
    const socketError = Object.assign(new Error("socket details"), {
      code: "ECONNRESET",
    });
    const api: GrammyBotApiPort = {
      async sendRichMessage() {
        throw new HttpError("network request failed", socketError);
      },
      async sendMessage() {
        throw new Error("must not fall back on transport failure");
      },
    };
    assert.deepEqual(await new GrammyBotTurnPublisher(api).publish(
      request(richPublication()),
    ), {
      ok: false,
      chunksSent: 0,
      error: { kind: "network", code: "ECONNRESET" },
    });
  });

  await t.test("timeout code stays timeout", async () => {
    const api: GrammyBotApiPort = {
      async sendRichMessage() {
        throw Object.assign(new Error("timed out"), {
          code: "ETIMEDOUT",
        });
      },
      async sendMessage() {
        throw new Error("must not fall back on timeout");
      },
    };
    assert.deepEqual(await new GrammyBotTurnPublisher(api).publish(
      request(richPublication()),
    ), {
      ok: false,
      chunksSent: 0,
      error: { kind: "timeout", code: "ETIMEDOUT" },
    });
  });

  await t.test("pre-aborted signal makes no API call at all", async () => {
    let calls = 0;
    const api: GrammyBotApiPort = {
      async sendRichMessage() {
        calls += 1;
        return { message_id: 1 };
      },
      async sendMessage() {
        calls += 1;
        return { message_id: 2 };
      },
    };
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));
    const result = await new GrammyBotTurnPublisher(api).publish({
      ...request(richPublication()),
      signal: controller.signal,
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, {
      ok: false,
      chunksSent: 0,
      error: { kind: "timeout", code: "ABORTED" },
    });
  });
});

test("a malformed rich ACK is an unknown failure without resend", async () => {
  let plainCalls = 0;
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      return { ok: true };
    },
    async sendMessage() {
      plainCalls += 1;
      return { message_id: 1 };
    },
  };

  const result = await new GrammyBotTurnPublisher(api).publish(
    request(richPublication()),
  );

  assert.equal(plainCalls, 0);
  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: { kind: "unknown", code: "MALFORMED_SUCCESS_RESPONSE" },
  });
});

test("a plain publication goes straight through classic sendMessage", async () => {
  const { api, richCalls, plainCalls } = makeFakeApi();
  const result = await new GrammyBotTurnPublisher(api).publish(
    request(plainPublication("первый <b>не HTML</b>")),
  );

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 1,
    telegramMessageId: 702,
  });
  assert.equal(richCalls.length, 0);
  assert.equal(plainCalls.length, 1);
  assert.equal(plainCalls[0]!.text, "первый <b>не HTML</b>");
  assert.deepEqual(plainCalls[0]!.options, BASE_PLAIN_OPTIONS);
});

test("a rejection on the second fallback chunk reports partial delivery", async () => {
  const plainText = "x".repeat(5_000);
  let plainCalls = 0;
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      throw telegramError(400, "can't parse markdown");
    },
    async sendMessage() {
      plainCalls += 1;
      if (plainCalls === 1) {
        return { message_id: 801 };
      }
      throw telegramError(400, "second chunk rejected");
    },
  };

  const result = await new GrammyBotTurnPublisher(api).publish(
    request(richPublication("**x**", plainText)),
  );

  assert.equal(plainCalls, 2);
  assert.deepEqual(result, {
    ok: false,
    chunksSent: 1,
    error: { kind: "unknown", code: "PARTIAL_DELIVERY" },
  });
});

test("a definitive Telegram 429 on the rich path stays retryable", async () => {
  let plainCalls = 0;
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      throw telegramError(429, "flood wait");
    },
    async sendMessage() {
      plainCalls += 1;
      return { message_id: 1 };
    },
  };

  assert.deepEqual(await new GrammyBotTurnPublisher(api).publish(
    request(richPublication()),
  ), {
    ok: false,
    chunksSent: 0,
    error: {
      kind: "telegram_rejected",
      code: "TELEGRAM_429",
      retryable: true,
    },
  });
  assert.equal(plainCalls, 0);
});

test("an invalid publish request is rejected without any API call", async () => {
  const { api, richCalls, plainCalls } = makeFakeApi();
  const result = await new GrammyBotTurnPublisher(api).publish({
    ...request(richPublication()),
    publication: { mode: "rich" } as unknown as TelegramPublication,
  });

  assert.equal(richCalls.length, 0);
  assert.equal(plainCalls.length, 0);
  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: { kind: "unknown", code: "INVALID_PUBLISH_REQUEST" },
  });
});

test("extracts and clamps retry_after from a raw 429 rejection on the fallback path", async () => {
  const raw = {
    ok: false,
    error_code: 429,
    description: "Too Many Requests",
    parameters: { retry_after: 61 },
  };
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      throw telegramError(400, "can't parse markdown");
    },
    async sendMessage() {
      return raw;
    },
  };

  assert.deepEqual(await new GrammyBotTurnPublisher(api).publish(
    request(richPublication("**x**", "plain")),
  ), {
    ok: false,
    chunksSent: 0,
    error: {
      kind: "telegram_rejected",
      code: "TELEGRAM_429",
      retryable: true,
      retryAfterMs: 61_000,
    },
  });

  raw.parameters.retry_after = 999_999;
  const clamped = await new GrammyBotTurnPublisher(api).publish(
    request(richPublication("**x**", "plain")),
  ) as { ok: false; error: { retryAfterMs?: number } };
  assert.equal(clamped.error.retryAfterMs, 15 * 60_000);
});

function telegramError(
  errorCode: number,
  description: string,
): GrammyError {
  return new GrammyError(
    "Call to sendRichMessage failed",
    {
      ok: false,
      error_code: errorCode,
      description,
    },
    "sendRichMessage",
    {},
  );
}
