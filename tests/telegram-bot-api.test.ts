import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  NativeTelegramBotApi,
  TelegramBotApiError,
  TelegramBotApiRejectedError,
} from "../src/bot/telegram-bot-api.js";
import { createTelegramHttpLanes } from "../src/bot/telegram-http.js";
import type { OwnSendStore } from "../src/bot/runtime/contracts.js";

interface FetchCall {
  readonly url: URL | string;
  readonly init: RequestInit | undefined;
}

function fakeStore(): OwnSendStore & {
  readonly writes: Array<Parameters<OwnSendStore["upsertMessages"]>>;
} {
  const writes: Array<Parameters<OwnSendStore["upsertMessages"]>> = [];
  return {
    getCachedChat: () => undefined,
    upsertMessages(chat, messages) {
      writes.push([chat, messages]);
      return messages.length;
    },
    writes,
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createApi(
  responses: Array<Response | (() => Response)>,
  store = fakeStore(),
): { api: NativeTelegramBotApi; store: ReturnType<typeof fakeStore>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const api = new NativeTelegramBotApi({
    token: "12345:test-token-only-for-offline-fixture",
    baseUrl: "https://bot-api.fixture.test/api",
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected offline request");
      }
      return typeof next === "function" ? next() : next;
    },
    ownSends: { store, botId: "999", botUsername: "ParilkaBot" },
  });
  return { api, store, calls };
}

async function jsonBody(call: FetchCall): Promise<Record<string, unknown>> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function ownMessage(messageId = 17): Record<string, unknown> {
  return {
    message_id: messageId,
    date: 1_700_000_000,
    from: { id: 999, is_bot: true },
    chat: { id: "-10042", type: "supergroup", title: "парилка" },
  };
}

test("native transport sends canonical message and records it before return", async () => {
  const { api, store, calls } = createApi([
    response({ ok: true, result: ownMessage() }),
  ]);

  const result = await api.sendMessage(
    "-10042",
    "готово",
    {
      reply_parameters: {
        message_id: 9,
        allow_sending_without_reply: false,
      },
      link_preview_options: { is_disabled: true },
    },
    new AbortController().signal,
  );

  assert.equal((result as { message_id: number }).message_id, 17);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]?.url), /\/bot12345:test-token-only-for-offline-fixture\/sendMessage$/u);
  assert.deepEqual(await jsonBody(calls[0]!), {
    chat_id: "-10042",
    text: "готово",
    reply_parameters: { message_id: 9, allow_sending_without_reply: false },
    link_preview_options: { is_disabled: true },
  });
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0]?.[0].chatId, "-10042");
  assert.deepEqual(store.writes[0]?.[1][0], {
    chatId: "-10042",
    messageId: 17,
    date: "2023-11-14T22:13:20.000Z",
    senderId: "999",
    senderName: "ParilkaBot",
    text: "готово",
    replyToMessageId: 9,
    rawJson: JSON.stringify(ownMessage()),
  });
});

test("transient presentation is validated but never enters the chat corpus", async () => {
  const { api, store, calls } = createApi([
    response({ ok: true, result: ownMessage(18) }),
  ]);

  const result = await api.sendTransientMessage(
    "-10042",
    "⏳ keyword_search",
    new AbortController().signal,
  );

  assert.equal((result as { message_id: number }).message_id, 18);
  assert.deepEqual(await jsonBody(calls[0]!), {
    chat_id: "-10042",
    text: "⏳ keyword_search",
  });
  assert.equal(store.writes.length, 0);
});

test("uses strict result shapes for polling and presentation methods", async () => {
  const { api, calls } = createApi([
    response({ ok: true, result: { id: 999, is_bot: true, username: "ParilkaBot" } }),
    response({ ok: true, result: true }),
    response({ ok: true, result: [{ update_id: 1 }] }),
    response({ ok: true, result: true }),
    response({ ok: true, result: ownMessage(21) }),
    response({ ok: true, result: true }),
  ]);
  const signal = new AbortController().signal;

  assert.deepEqual(await api.getMe(signal), { id: 999, is_bot: true, username: "ParilkaBot" });
  assert.equal(await api.deleteWebhook({ drop_pending_updates: false }, signal), true);
  assert.deepEqual(await api.getUpdates({
    offset: 2,
    timeout: 25,
    limit: 5,
    allowed_updates: ["message", "edited_message"],
  }, signal), [{ update_id: 1 }]);
  await api.sendChatAction("-10042", signal);
  assert.deepEqual(
    await api.editMessageText("-10042", 21, "статус", signal),
    ownMessage(21),
  );
  assert.equal(await api.deleteMessage("-10042", 21, signal), true);

  assert.deepEqual(await jsonBody(calls[2]!), {
    offset: 2,
    timeout: 25,
    limit: 5,
    allowed_updates: ["message", "edited_message"],
  });
  assert.deepEqual(await jsonBody(calls[3]!), { chat_id: "-10042", action: "typing" });
  assert.deepEqual(await jsonBody(calls[4]!), { chat_id: "-10042", message_id: 21, text: "статус" });
});

test("native Bot API resolves and downloads a private file without redirects", async () => {
  const { api, calls } = createApi([
    response({ ok: true, result: { file_path: "documents/image.png", file_size: 3 } }),
    new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  ]);
  const signal = new AbortController().signal;
  assert.deepEqual(await api.getFile("private_file_id", signal), {
    filePath: "documents/image.png", fileSize: 3,
  });
  const downloaded = await api.downloadFile("documents/image.png", signal);
  assert.deepEqual([...new Uint8Array(await downloaded.arrayBuffer())], [1, 2, 3]);
  assert.match(String(calls[0]?.url), /\/getFile$/u);
  assert.deepEqual(await jsonBody(calls[0]!), { file_id: "private_file_id" });
  assert.match(String(calls[1]?.url), /\/file\/bot12345:test-token-only-for-offline-fixture\/documents\/image\.png$/u);
  assert.equal(calls[1]?.init?.method, "GET");
  assert.equal(calls[1]?.init?.redirect, "error");
  await assert.rejects(
    () => api.downloadFile("../private", signal),
    (error: unknown) => error instanceof TelegramBotApiError && error.code === "DOWNLOAD_FILE_PATH_MALFORMED",
  );
});

test("a pending long poll cannot block typing on the action lane", async () => {
  let releasePoll: ((value: Response) => void) | undefined;
  const pollPending = new Promise<Response>((resolve) => {
    releasePoll = resolve;
  });
  const actionCalls: FetchCall[] = [];
  const pollCalls: FetchCall[] = [];
  const api = new NativeTelegramBotApi({
    token: "fixture-token",
    baseUrl: "https://bot-api.fixture.test",
    fetch: async (url, init) => {
      actionCalls.push({ url, init });
      return response({ ok: true, result: true });
    },
    pollFetch: async (url, init) => {
      pollCalls.push({ url, init });
      return pollPending;
    },
    ownSends: {
      store: fakeStore(),
      botId: "999",
      botUsername: "ParilkaBot",
    },
  });
  const signal = new AbortController().signal;

  const polling = api.getUpdates({
    timeout: 30,
    limit: 100,
    allowed_updates: ["message", "edited_message"],
  }, signal);
  await Promise.resolve();
  await api.sendChatAction("-10042", signal);

  assert.equal(pollCalls.length, 1);
  assert.equal(actionCalls.length, 1);
  assert.match(String(pollCalls[0]?.url), /\/getUpdates$/u);
  assert.match(String(actionCalls[0]?.url), /\/sendChatAction$/u);
  releasePoll?.(response({ ok: true, result: [] }));
  assert.deepEqual(await polling, []);
});

test("production HTTP pools dispatch typing while the poll socket is occupied", async (t) => {
  let releasePoll = (): void => undefined;
  let markPollReceived: (() => void) | undefined;
  const pollReceived = new Promise<void>((resolve) => {
    markPollReceived = resolve;
  });
  const server = createServer((request, serverResponse) => {
    request.resume();
    const method = request.url?.split("/").at(-1);
    if (method === "getUpdates") {
      releasePoll = () => {
        if (!serverResponse.writableEnded) {
          serverResponse.writeHead(200, { "content-type": "application/json" });
          serverResponse.end(JSON.stringify({ ok: true, result: [] }));
        }
      };
      markPollReceived?.();
      return;
    }
    assert.equal(method, "sendChatAction");
    serverResponse.writeHead(200, { "content-type": "application/json" });
    serverResponse.end(JSON.stringify({ ok: true, result: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const http = createTelegramHttpLanes();
  const api = new NativeTelegramBotApi({
    token: "fixture-token",
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    fetch: http.actionFetch,
    pollFetch: http.pollFetch,
    close: () => http.close(),
    ownSends: {
      store: fakeStore(),
      botId: "999",
      botUsername: "ParilkaBot",
    },
  });
  t.after(async () => {
    releasePoll();
    await api.close();
    await closeServer(server);
  });

  const polling = api.getUpdates({
    timeout: 30,
    limit: 100,
    allowed_updates: ["message", "edited_message"],
  }, new AbortController().signal);
  await pollReceived;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      api.sendChatAction("-10042", new AbortController().signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("typing waited behind long poll")), 1_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  releasePoll();
  assert.deepEqual(await polling, []);
});

test("closes an owned HTTP transport once", async () => {
  let closeCalls = 0;
  const api = new NativeTelegramBotApi({
    token: "fixture-token",
    fetch: async () => response({ ok: true, result: true }),
    close: async () => { closeCalls += 1; },
    ownSends: {
      store: fakeStore(),
      botId: "999",
      botUsername: "ParilkaBot",
    },
  });

  await Promise.all([api.close(), api.close()]);
  assert.equal(closeCalls, 1);
});

test("rich outgoing request preserves its native payload and canonical plain cache text", async () => {
  const { api, store, calls } = createApi([
    response({ ok: true, result: ownMessage(25) }),
  ]);
  await api.sendRichMessage({
    chatId: "-10042",
    richMessage: { markdown: "# заголовок", skip_entity_detection: true },
    plainText: "заголовок",
    options: { reply_parameters: { message_id: 9, allow_sending_without_reply: false } },
    signal: new AbortController().signal,
  });

  assert.deepEqual(await jsonBody(calls[0]!), {
    chat_id: "-10042",
    rich_message: { markdown: "# заголовок", skip_entity_detection: true },
    reply_parameters: { message_id: 9, allow_sending_without_reply: false },
  });
  assert.equal(store.writes[0]?.[1][0]?.text, "заголовок");
});

test("Bot API rejections are structured while their Error message never leaks endpoint credentials", async () => {
  const token = "12345:test-token-only-for-offline-fixture";
  const { api } = createApi([
    response({
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse markdown",
    }),
  ]);

  await assert.rejects(
    api.sendMessage("-10042", "x", undefined, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof TelegramBotApiRejectedError);
      assert.equal(error.error_code, 400);
      assert.equal(error.ok, false);
      assert.equal(error.message, "TELEGRAM_400");
      assert.doesNotMatch(error.message, new RegExp(token, "u"));
      assert.doesNotMatch(error.message, /bot-api\.fixture/u);
      return true;
    },
  );
});

test("rejects malformed or oversized responses before they reach the runtime", async () => {
  const oversized = new Response("x".repeat(1_025), {
    headers: { "content-length": "1025" },
  });
  const store = fakeStore();
  const api = new NativeTelegramBotApi({
    token: "fixture-token",
    fetch: async () => oversized,
    maxResponseBytes: 1_024,
    ownSends: { store, botId: "999", botUsername: "ParilkaBot" },
  });
  await assert.rejects(
    api.getMe(new AbortController().signal),
    (error: unknown) => error instanceof TelegramBotApiError && error.code === "TELEGRAM_RESPONSE_TOO_LARGE",
  );
});

test("sanitizes a fetch failure that includes the tokenized request URL", async () => {
  const token = "fixture-token-that-must-not-escape";
  const store = fakeStore();
  const api = new NativeTelegramBotApi({
    token,
    baseUrl: "https://bot-api.fixture.test",
    fetch: async (url) => {
      throw new Error(`network failure for ${String(url)}`);
    },
    ownSends: { store, botId: "999", botUsername: "ParilkaBot" },
  });
  await assert.rejects(
    api.getMe(new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof TelegramBotApiError);
      assert.equal(error.message, "TELEGRAM_TRANSPORT");
      assert.doesNotMatch(error.message, new RegExp(token, "u"));
      return true;
    },
  );
});

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
