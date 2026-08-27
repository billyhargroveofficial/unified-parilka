import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexSubscriptionAuthError,
  CodexSubscriptionAuthProcessState,
  CodexSubscriptionAuthStore,
  redactCodexSubscriptionSecrets,
} from "../src/openai-responses/codex-subscription-auth.js";

test("reads chatgpt OAuth auth.json and derives account and expiry from JWT", async () => {
  const authFile = await authFixture({
    access_token: jwt({ exp: 2_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" } }),
    refresh_token: "refresh-secret",
  });
  const auth = new CodexSubscriptionAuthStore({ authFile, now: () => 1_000 });
  const snapshot = await auth.snapshot();
  assert.equal(snapshot.accountId, "acct-jwt");
  assert.equal(snapshot.expiresAtMs, 2_000_000_000_000);
  assert.match(snapshot.accessToken, /^eyJ/u);
});

test("proactively refreshes once and atomically persists rotated OAuth tokens", async () => {
  const authFile = await authFixture({
    access_token: jwt({ exp: 10, chatgpt_account_id: "acct-old" }),
    refresh_token: "refresh-old",
  });
  let refreshCalls = 0;
  const auth = new CodexSubscriptionAuthStore({
    authFile,
    now: () => 20_000,
    fetch: async (_input, init) => {
      refreshCalls += 1;
      assert.deepEqual(JSON.parse(String(init?.body)), {
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: "refresh-old",
      });
      return Response.json({
        access_token: jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct-new" }),
        refresh_token: "refresh-new",
      });
    },
  });
  const snapshot = await auth.snapshot();
  assert.equal(refreshCalls, 1);
  assert.equal(snapshot.accountId, "acct-new");
  const saved = JSON.parse(await readFile(authFile, "utf8")) as { tokens: Record<string, string>; last_refresh: string };
  assert.equal(saved.tokens.refresh_token, "refresh-new");
  assert.match(saved.last_refresh, /^1970-01-01T00:00:20\.000Z$/u);
  assert.equal((await stat(authFile)).mode & 0o777, 0o600);
});

test("shares one proactive refresh between concurrent store instances", async () => {
  const authFile = await authFixture({ access_token: jwt({ exp: 10, chatgpt_account_id: "acct-old" }), refresh_token: "refresh-old" });
  let calls = 0;
  const fetch = async (): Promise<Response> => {
    calls += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    return Response.json({ access_token: jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct" }), refresh_token: "refresh-new" });
  };
  const options = { authFile, now: () => 20_000, fetch };
  const [left, right] = await Promise.all([
    new CodexSubscriptionAuthStore(options).snapshot(),
    new CodexSubscriptionAuthStore(options).snapshot(),
  ]);
  assert.equal(calls, 1);
  assert.equal(left.accessToken, right.accessToken);
});

test("filesystem refresh lease coordinates independent runtime state maps", async () => {
  const authFile = await authFixture({ access_token: jwt({ exp: 10, chatgpt_account_id: "acct-old" }), refresh_token: "refresh-old" });
  let calls = 0;
  const fetch = async (): Promise<Response> => {
    calls += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    return Response.json({ access_token: jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct-new" }), refresh_token: "refresh-new" });
  };
  const common = { authFile, now: () => 20_000, fetch };
  const [left, right] = await Promise.all([
    new CodexSubscriptionAuthStore({ ...common, processState: new CodexSubscriptionAuthProcessState() }).snapshot(),
    new CodexSubscriptionAuthStore({ ...common, processState: new CodexSubscriptionAuthProcessState() }).snapshot(),
  ]);
  assert.equal(calls, 1);
  assert.equal(left.accessToken, right.accessToken);
});

test("rejects insecure and symlinked auth files before reading credentials", async () => {
  const authFile = await authFixture({ access_token: jwt({ exp: 2_000_000_000 }) });
  await chmod(authFile, 0o644);
  await assert.rejects(new CodexSubscriptionAuthStore({ authFile }).snapshot(), CodexSubscriptionAuthError);

  const target = await authFixture({ access_token: jwt({ exp: 2_000_000_000 }) });
  const link = `${target}.link`;
  await symlink(target, link);
  await assert.rejects(new CodexSubscriptionAuthStore({ authFile: link }).snapshot(), /not a symlink/u);
});

test("refresh errors redact OAuth credentials", async () => {
  const access = jwt({ exp: 10, chatgpt_account_id: "acct-old" });
  const authFile = await authFixture({ access_token: access, refresh_token: "refresh-secret" });
  const auth = new CodexSubscriptionAuthStore({
    authFile,
    now: () => 20_000,
    fetch: async () => new Response(`bad ${access} refresh-secret`, { status: 401 }),
  });
  await assert.rejects(auth.snapshot(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /refresh-secret/u);
    assert.doesNotMatch(error.message, new RegExp(access.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(error.message, /\[redacted\]/u);
    return true;
  });
  assert.equal(redactCodexSubscriptionSecrets("Bearer abcdef"), "Bearer [redacted]");
});

test("uses a cross-process refresh winner when this process receives a refresh failure", async () => {
  const authFile = await authFixture({ access_token: jwt({ exp: 10, chatgpt_account_id: "acct-old" }), refresh_token: "refresh-old" });
  const winner = jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct-winner" });
  const auth = new CodexSubscriptionAuthStore({
    authFile,
    now: () => 20_000,
    fetch: async () => {
      setTimeout(() => {
        void writeFile(authFile, `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: winner, refresh_token: "refresh-winner" } })}\n`, { mode: 0o600 });
      }, 20);
      return new Response("refresh failed", { status: 500 });
    },
  });
  const snapshot = await auth.snapshot();
  assert.equal(snapshot.accessToken, winner);
  assert.equal(snapshot.accountId, "acct-winner");
});

test("stale owner-only refresh lock is recovered and an active lock wait is abortable", async () => {
  const authFile = await authFixture({ access_token: jwt({ exp: 10, chatgpt_account_id: "acct-old" }), refresh_token: "refresh-old" });
  const lockFile = `${authFile}.refresh.lock`;
  await writeFile(lockFile, `${await exitedChildPid()}:${"a".repeat(24)}:${Date.now() - 60_000}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockFile, old, old);
  const auth = new CodexSubscriptionAuthStore({
    authFile,
    now: () => 20_000,
    fetch: async () => Response.json({ access_token: jwt({ exp: 2_000_000_000, chatgpt_account_id: "acct-new" }) }),
  });
  assert.equal((await auth.snapshot()).accountId, "acct-new");
  await assert.rejects(stat(lockFile));

  await writeFile(lockFile, "active\n", { mode: 0o600 });
  const controller = new AbortController();
  const waiting = new CodexSubscriptionAuthStore({ authFile, now: () => 3_000_000_000_000, fetch: async () => Response.json({}) }).snapshot(controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waiting, /Abort/u);
});

test("an old valid lock owned by this live process is never reclaimed by mtime alone", async () => {
  const authFile = await authFixture({ access_token: jwt({ exp: 10, chatgpt_account_id: "acct-old" }), refresh_token: "refresh-old" });
  const lockFile = `${authFile}.refresh.lock`;
  await writeFile(lockFile, `${process.pid}:${"b".repeat(24)}:${Date.now() - 60_000}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockFile, old, old);
  const controller = new AbortController();
  let fetchCalls = 0;
  const waiting = new CodexSubscriptionAuthStore({
    authFile,
    now: () => 20_000,
    fetch: async () => { fetchCalls += 1; return Response.json({}); },
  }).snapshot(controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waiting, /Abort/u);
  assert.equal(fetchCalls, 0);
  await stat(lockFile);
});

test("refresh error body is bounded by cancelling the stream instead of draining it", async () => {
  const authFile = await authFixture({ access_token: jwt({ exp: 10, chatgpt_account_id: "acct-old" }), refresh_token: "refresh-old" });
  let cancelled = false;
  const auth = new CodexSubscriptionAuthStore({
    authFile,
    now: () => 20_000,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(8_192))); },
      cancel() { cancelled = true; },
    }), { status: 500 }),
  });
  await assert.rejects(auth.snapshot(), /truncated/u);
  assert.equal(cancelled, true);
});

async function authFixture(tokens: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "parilka-codex-auth-"));
  await chmod(directory, 0o700);
  const path = join(directory, "auth.json");
  await writeFile(path, `${JSON.stringify({ auth_mode: "chatgpt", tokens })}\n`, { mode: 0o600 });
  return path;
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(child.pid && child.pid > 0);
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", () => resolveExit());
    child.once("error", rejectExit);
  });
  return child.pid;
}
