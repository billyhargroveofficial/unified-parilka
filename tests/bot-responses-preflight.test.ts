import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  runBotResponsesPreflight,
  type BotResponsesPreflightProbe,
} from "../src/bot-daemon/preflight.js";

test("Responses preflight streams the subscription Fast/priority contract and hosted-web registration", async (t) => {
  const env = fixtureEnvironment(t);
  const events: string[] = [];
  const config = await runBotResponsesPreflight({
    env,
    createProbe(value) {
      events.push(`probe:${value.serviceTier}`);
      return successfulProbe(events);
    },
  });

  assert.deepEqual(events, ["probe:fast", "create:gpt-5.6-luna:priority:web_search:none", "close"]);
  assert.equal(config.model, "gpt-5.6-luna");
  assert.equal(config.serviceTier, "fast");
});

test("Responses preflight fails before network construction for invalid owner-only auth state", async (t) => {
  const env = fixtureEnvironment(t);
  chmodSync(env.PARILKA_BOT_CODEX_AUTH_FILE, 0o644);
  let constructed = false;
  await assert.rejects(
    runBotResponsesPreflight({
      env,
      createProbe: () => {
        constructed = true;
        return successfulProbe([]);
      },
    }),
    /mode 0600/u,
  );
  assert.equal(constructed, false);
});

test("Responses preflight rejects a substituted model and always closes the stream probe", async (t) => {
  const env = fixtureEnvironment(t);
  let closed = false;
  await assert.rejects(
    runBotResponsesPreflight({
      env,
      createProbe: () => ({
        async create() { return streamOf(completedResponse("gpt-5.6-terra")); },
        async close() { closed = true; },
      }),
    }),
    /unexpected model/u,
  );
  assert.equal(closed, true);
});

for (const [name, event, expected] of [
  ["failed response", { type: "response.failed" }, /did not complete/u],
  ["incomplete response", { type: "response.incomplete" }, /did not complete/u],
  ["default tier that transport failed to normalize", completedResponse("gpt-5.6-luna", { service_tier: "default" }), /Fast \(priority\) tier/u],
  ["null tier", completedResponse("gpt-5.6-luna", { service_tier: null }), /Fast \(priority\) tier/u],
  ["raw fast instead of priority normalization", completedResponse("gpt-5.6-luna", { service_tier: "fast" }), /Fast \(priority\) tier/u],
  ["empty reply", completedResponse("gpt-5.6-luna", { output_text: "   " }), /empty reply/u],
] as const) {
  test(`Responses preflight rejects ${name}`, async (t) => {
    const env = fixtureEnvironment(t);
    await assert.rejects(
      runBotResponsesPreflight({
        env,
        createProbe: () => ({ async create() { return streamOf(event); } }),
      }),
      expected,
    );
  });
}

test("Responses preflight aborts and closes a stalled subscription stream", async (t) => {
  const env = fixtureEnvironment(t);
  let closed = false;
  let aborted = false;
  await assert.rejects(
    runBotResponsesPreflight({
      env,
      timeoutMs: 1_000,
      createProbe: () => ({
        async create(_request, { signal }) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
                aborted = true;
                reject(signal.reason);
              }, { once: true }));
            },
          };
        },
        async close() { closed = true; },
      }),
    }),
    /timed out/u,
  );
  assert.equal(aborted, true);
  assert.equal(closed, true);
});

function fixtureEnvironment(t: TestContext): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), "parilka-responses-preflight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const authFile = join(directory, "codex-auth");
  writeFileSync(authFile, '{"auth_mode":"chatgpt","tokens":{"access_token":"fake","refresh_token":"fake"}}', { mode: 0o600 });
  chmodSync(authFile, 0o600);
  return { PARILKA_BOT_CODEX_AUTH_FILE: authFile };
}

function successfulProbe(events: string[]): BotResponsesPreflightProbe {
  return {
    async create(request) {
      events.push(`create:${request.model}:${request.service_tier}:${request.tools[0].type}:${request.tool_choice}`);
      assert.deepEqual(request, {
        model: "gpt-5.6-luna",
        service_tier: "priority",
        reasoning: { effort: "max" },
        store: false,
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "Responses preflight: reply exactly READY." }] }],
        tools: [{ type: "web_search", search_context_size: "low" }],
        tool_choice: "none",
        parallel_tool_calls: false,
        max_output_tokens: 64,
      });
      return streamOf(completedResponse(request.model));
    },
    async close() { events.push("close"); },
  };
}

function streamOf(event: unknown): AsyncIterable<{ type: string; response?: ReturnType<typeof responseBody> }> {
  return {
    async *[Symbol.asyncIterator]() {
      if (isCompleted(event)) {
        yield { type: "response.completed", response: event };
      } else {
        yield event as { type: string };
      }
    },
  };
}

function isCompleted(value: unknown): value is ReturnType<typeof responseBody> {
  return typeof value === "object" && value !== null && "model" in value;
}

function completedResponse(
  model: string,
  overrides: Partial<{
    status: string;
    service_tier: string | null;
    output_text: string;
  }> = {},
) {
  return responseBody(model, overrides);
}

function responseBody(
  model: string,
  overrides: Partial<{
    status: string;
    service_tier: string | null;
    output_text: string;
  }> = {},
) {
  return {
    model,
    status: "completed",
    service_tier: "priority",
    output_text: "READY",
    ...overrides,
  };
}
