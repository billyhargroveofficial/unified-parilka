import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexSubscriptionUsageClient,
  CODEX_SUBSCRIPTION_USAGE_URL,
  parseCodexSubscriptionUsage,
} from "../src/openai-responses/codex-subscription-usage.js";

test("Codex subscription usage reads the canonical OAuth endpoint and caches its bounded snapshot", async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const client = new CodexSubscriptionUsageClient({
    auth: { async snapshot() { return { accessToken: "test-token", accountId: "account-1" }; } },
    now: () => now,
    fetch: async (url, init) => {
      calls += 1;
      assert.equal(url, CODEX_SUBSCRIPTION_USAGE_URL);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer test-token");
      assert.equal(headers.get("ChatGPT-Account-ID"), "account-1");
      return Response.json({
        rate_limit: {
          primary_window: { used_percent: 21, limit_window_seconds: 18_000, reset_after_seconds: 3_600 },
          secondary_window: { used_percent: 29, limit_window_seconds: 604_800, reset_at: 1_700_456_800 },
        },
      });
    },
  });

  const first = await client.get();
  assert.deepEqual(first, {
    primary: { usedPercent: 21, windowSeconds: 18_000, resetAtMs: now + 3_600_000 },
    secondary: { usedPercent: 29, windowSeconds: 604_800, resetAtMs: 1_700_456_800_000 },
  });
  now += 30_000;
  assert.deepEqual(await client.get(), first);
  assert.equal(calls, 1);
  now += 60_001;
  assert.deepEqual(await client.get(), first, "expired data stays visible while a refresh runs in background");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

test("Codex subscription usage fails open on malformed and failed replies", async () => {
  assert.equal(parseCodexSubscriptionUsage("{bad", 1), undefined);
  const client = new CodexSubscriptionUsageClient({
    auth: { async snapshot() { return { accessToken: "test-token" }; } },
    fetch: async () => new Response("no", { status: 503 }),
  });
  assert.equal(await client.get(), undefined);
});

test("a failed refresh retains the last confirmed usage window", async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const client = new CodexSubscriptionUsageClient({
    auth: { async snapshot() { return { accessToken: "test-token" }; } },
    now: () => now,
    cacheTtlMs: 100,
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ rate_limit: { primary_window: {
            used_percent: 32, limit_window_seconds: 604_800, reset_after_seconds: 10_000,
          } } })
        : new Response("temporary", { status: 503 });
    },
  });
  const confirmed = await client.get();
  now += 101;
  assert.deepEqual(await client.get(), confirmed);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await client.get(), confirmed);
  assert.equal(calls, 2);
});

test("Codex subscription usage rejects noncanonical endpoint overrides", () => {
  assert.throws(
    () => new CodexSubscriptionUsageClient({
      auth: { async snapshot() { return { accessToken: "test-token" }; } },
      usageUrl: "http://not-https.example/usage",
    }),
    /canonical HTTPS/u,
  );
});
