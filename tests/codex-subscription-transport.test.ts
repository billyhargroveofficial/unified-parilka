import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexSubscriptionAuthStore,
} from "../src/openai-responses/codex-subscription-auth.js";
import {
  CodexSubscriptionResponsesTransport,
  parseCodexSubscriptionSse,
} from "../src/openai-responses/codex-subscription-transport.js";
import { OpenAiResponsesTurnClient } from "../src/openai-responses/client.js";
import type { ResponsesCreateRequest } from "../src/openai-responses/contracts.js";

test("posts directly to Codex backend, refreshes exactly once after 401, and replays priority request", async () => {
  const oldAccess = jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct-old" });
  const authFile = await authFixture({ access_token: oldAccess, refresh_token: "refresh-old" });
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let upstreamCalls = 0;
  const transport = new CodexSubscriptionResponsesTransport({
    auth: new CodexSubscriptionAuthStore({
      authFile,
      fetch: async (_url, init) => {
        assert.equal(init?.method, "POST");
        return Response.json({ access_token: jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct-new" }), refresh_token: "refresh-new" });
      },
    }),
    sessionId: "session-test",
    originator: "parilka-test",
    userAgent: "parilka-test/1",
    fetch: async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      upstreamCalls += 1;
      if (upstreamCalls === 1) return new Response("expired", { status: 401 });
      return sseResponse([
        'data: {"type":"response.output_text.delta","delta":"ok"}', "",
        'data: {"type":"response.done","response":{"id":"resp-1","model":"gpt-5.6-luna","status":"completed","service_tier":"default","output":[]}}', "",
      ]);
    },
  });
  const events = await collect(await transport.create(request(), { signal: new AbortController().signal }));
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
  const firstHeaders = new Headers(seen[0]?.init.headers);
  assert.equal(firstHeaders.get("authorization"), `Bearer ${oldAccess}`);
  assert.equal(firstHeaders.get("chatgpt-account-id"), "acct-old");
  assert.equal(firstHeaders.get("originator"), "parilka-test");
  assert.equal(firstHeaders.get("user-agent"), "parilka-test/1");
  assert.equal(firstHeaders.get("session-id"), "session-test");
  assert.equal(firstHeaders.get("accept"), "text/event-stream");
  assert.equal(firstHeaders.get("content-type"), "application/json");
  assert.equal(firstHeaders.get("openai-beta"), "responses=experimental");
  assert.equal(firstHeaders.get("x-client-request-id"), "session-test");
  const wireBody = JSON.parse(String(seen[1]?.init.body)) as Record<string, unknown>;
  assert.equal(wireBody.service_tier, "priority");
  assert.equal(wireBody.prompt_cache_key, "parilka:responses:v2");
  assert.equal("max_output_tokens" in wireBody, false);
  assert.equal("max_tool_calls" in wireBody, false);
  const completed = events.at(-1) as unknown as { type: string; response: { service_tier: string; output_text: string } };
  assert.equal(completed.type, "response.completed");
  assert.equal(completed.response.service_tier, "priority");
  assert.equal(completed.response.output_text, "ok");
  assert.equal((completed.response as Record<string, unknown>).codex_subscription_raw_service_tier, "default");
});

test("aggregates output items and text before yielding a terminal response.done", async () => {
  const source = [
    "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc-1\",\"call_id\":\"call-1\",\"name\":\"lookup\"}}\r",
    "\r",
    "data: {\"type\":\"response.output_item.done\",\r",
    "data: \"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc-1\",\"call_id\":\"call-1\",\"name\":\"lookup\",\"arguments\":\"{}\",\"status\":\"completed\"}}\r",
    "\r",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Готово\"}\r",
    "\r",
    "data: {\"type\":\"response.output_text.annotation.added\",\"annotation\":{\"type\":\"url_citation\",\"start_index\":0,\"end_index\":6,\"title\":\"Источник\",\"url\":\"https://example.test\"}}\r",
    "\r",
    "data: {\"type\":\"response.done\",\"response\":{\"id\":\"resp-2\",\"model\":\"gpt-5.6-luna\",\"status\":\"completed\",\"service_tier\":\"default\",\"output\":[]}}\r",
    "\r",
  ].join("\n");
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(source)); controller.close(); },
  });
  const events = await collect(parseCodexSubscriptionSse(body, new AbortController().signal, "priority"));
  const completed = events.at(-1) as unknown as { type: string; response: { service_tier: string; output_text: string; output: Array<Record<string, unknown>> } };
  assert.equal(completed.type, "response.completed");
  assert.equal(completed.response.service_tier, "priority");
  assert.equal(completed.response.output_text, "Готово");
  assert.deepEqual(completed.response.output[0], {
    type: "function_call", id: "fc-1", call_id: "call-1", name: "lookup", arguments: "{}", status: "completed",
  });
  const message = completed.response.output[1] as { content: Array<{ text: string; annotations: unknown[] }> };
  assert.equal(message.content[0]?.text, "Готово");
  assert.equal(message.content[0]?.annotations.length, 1);
});

test("401 recovery reuses a newer shared auth file before attempting another refresh", async () => {
  const oldAccess = jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct-old" });
  const newAccess = jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct-new" });
  const authFile = await authFixture({ access_token: oldAccess, refresh_token: "refresh-old" });
  let refreshCalls = 0;
  let upstreamCalls = 0;
  const transport = new CodexSubscriptionResponsesTransport({
    auth: new CodexSubscriptionAuthStore({
      authFile,
      fetch: async () => { refreshCalls += 1; return Response.json({}); },
    }),
    fetch: async (_url, init) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        await writeFile(authFile, `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: newAccess, refresh_token: "refresh-new" } })}\n`, { mode: 0o600 });
        return new Response("unauthorized", { status: 401 });
      }
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${newAccess}`);
      return sseResponse(['data: {"type":"response.done","response":{"id":"resp","model":"gpt-5.6-luna","status":"completed","service_tier":"default","output":[]}}', ""]);
    },
  });
  await collect(await transport.create(request(), { signal: new AbortController().signal }));
  assert.equal(refreshCalls, 0);
  assert.equal(upstreamCalls, 2);
});

test("does not normalize default tier unless the wire request was priority", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"service_tier":"default","output":[]}}\n\n'));
      controller.close();
    },
  });
  const [event] = await collect(parseCodexSubscriptionSse(body, new AbortController().signal, "fast"));
  assert.equal((event as unknown as { response: { service_tier: string } }).response.service_tier, "default");
});

test("direct transport gives the existing turn core synthesized functions, final text, and citations", async () => {
  const authFile = await authFixture({
    access_token: jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct" }), refresh_token: "refresh",
  });
  let requestCount = 0;
  const transport = new CodexSubscriptionResponsesTransport({
    auth: new CodexSubscriptionAuthStore({ authFile }),
    fetch: async () => {
      requestCount += 1;
      if (requestCount === 1) return sseResponse([
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc-1","call_id":"call-1","name":"lookup","arguments":"{\\"q\\":\\"баня\\"}","status":"completed"}}', "",
        'data: {"type":"response.done","response":{"id":"resp-tool","model":"gpt-5.6-luna","status":"completed","service_tier":"default","output":[]}}', "",
      ]);
      return sseResponse([
        'data: {"type":"response.output_text.delta","delta":"Нашёл [1]"}', "",
        'data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","start_index":7,"end_index":10,"title":"Источник","url":"https://example.test/a"}}', "",
        'data: {"type":"response.done","response":{"id":"resp-final","model":"gpt-5.6-luna","status":"completed","service_tier":"default","output":[]}}', "",
      ]);
    },
  });
  const calls: unknown[] = [];
  const result = await new OpenAiResponsesTurnClient(transport).run({
    text: "найди", instructions: "x", effort: "low",
    localFunctions: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    dispatcher: { async dispatch(call) { calls.push(call); return { success: true, text: "результат" }; } },
  });
  assert.equal(requestCount, 2);
  assert.deepEqual(calls, [{ callId: "call-1", name: "lookup", arguments: { q: "баня" } }]);
  assert.equal(result.text, "Нашёл [1]");
  assert.deepEqual(result.annotations, [{ startIndex: 7, endIndex: 10, title: "Источник", url: "https://example.test/a" }]);
  assert.equal(result.functionCalls, 1);
});

test("SSE reader cancels a pending stream when its caller aborts", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const controller = new AbortController();
  const iterator = parseCodexSubscriptionSse(body, controller.signal, "priority");
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, /Abort/u);
  assert.equal(cancelled, true);
});

test("transport cancels oversized HTTP errors and SSE pending data", async () => {
  const authFile = await authFixture({ access_token: jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct" }), refresh_token: "refresh" });
  let errorCancelled = false;
  const transport = new CodexSubscriptionResponsesTransport({
    auth: new CodexSubscriptionAuthStore({ authFile }),
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(8_192))); },
      cancel() { errorCancelled = true; },
    }), { status: 500 }),
  });
  await assert.rejects(transport.create(request(), { signal: new AbortController().signal }), /truncated/u);
  assert.equal(errorCancelled, true);

  let sseCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(600 * 1024))); },
    cancel() { sseCancelled = true; },
  });
  await assert.rejects(collect(parseCodexSubscriptionSse(body, new AbortController().signal, "priority")), /safe size limit/u);
  assert.equal(sseCancelled, true);
});

function request(): ResponsesCreateRequest {
  return {
    model: "gpt-5.6-luna", service_tier: "priority", reasoning: { effort: "low" }, store: false, stream: true, prompt_cache_key: "parilka:responses:v2",
    instructions: "x", input: [], tools: [], include: ["reasoning.encrypted_content"], max_tool_calls: 1, parallel_tool_calls: false,
    max_output_tokens: 64,
  };
}

function sseResponse(lines: readonly string[]): Response {
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/event-stream" } });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function authFixture(tokens: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "parilka-codex-transport-"));
  await chmod(directory, 0o700);
  const path = join(directory, "auth.json");
  await writeFile(path, `${JSON.stringify({ auth_mode: "chatgpt", tokens })}\n`, { mode: 0o600 });
  return path;
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}
