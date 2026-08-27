import assert from "node:assert/strict";
import { test } from "node:test";
import { BotWorkerPump, type BotWorkerPort } from "../src/bot/runtime.js";

test("worker pump caps concurrency and drains a durable backlog", async () => {
  let remaining = 5; let active = 0; let maximum = 0;
  const workers: BotWorkerPort[] = Array.from({ length: 3 }, () => ({ async runOnce() { active += 1; maximum = Math.max(maximum, active); await new Promise<void>((done) => setImmediate(done)); active -= 1; return remaining-- > 0 ? { status: "sent" as const, turnId: remaining } : { status: "idle" as const }; } }));
  const pump = new BotWorkerPump({ workers }); pump.start();
  assert.deepEqual(await pump.drain(2_000), { drained: true, activeWorkers: 0 });
  assert.equal(maximum, 3);
});

test("retryable idle result schedules a single wake-up", async () => {
  let calls = 0; let wake: (() => void) | undefined;
  const pump = new BotWorkerPump({ workers: [{ async runOnce() { calls += 1; return calls === 1 ? { status: "idle" as const, retryAfterMs: 50 } : { status: "idle" as const }; } }], setTimeout: ((callback: () => void) => { wake = callback; return 1 as never; }) as unknown as typeof setTimeout, clearTimeout: (() => {}) as typeof clearTimeout });
  pump.start(); await new Promise<void>((done) => setImmediate(done)); wake?.(); await new Promise<void>((done) => setImmediate(done));
  assert.equal(calls, 2); await pump.stop(1_000);
});

test("stop settles when an in-flight terminal result completes during shutdown", async () => {
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const pump = new BotWorkerPump({ workers: [{ async runOnce() {
    calls += 1;
    started();
    await pending;
    return { status: "dispatch_rejected" as const, turnId: 1, retryable: true, retryAfterMs: 21_000 };
  } }] });
  pump.start();
  await active;
  const stopping = pump.stop(1_000);
  finish();

  assert.deepEqual(await stopping, { drained: true, activeWorkers: 0 });
  assert.equal(calls, 1);
});

test("a hanging maintenance send cannot occupy a user-turn worker slot", async () => {
  let maintenanceStarted!: () => void;
  const started = new Promise<void>((resolve) => { maintenanceStarted = resolve; });
  let releaseMaintenance!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
  const maintenance = new BotWorkerPump({ workers: [{ async runOnce() {
    maintenanceStarted();
    await blocked;
    return { status: "idle" };
  } }] });
  let userCalls = 0;
  const users = new BotWorkerPump({ workers: [{ async runOnce() {
    userCalls += 1;
    return { status: "idle" };
  } }] });

  maintenance.start();
  await started;
  users.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(userCalls, 1);
  await users.stop(1_000);
  releaseMaintenance();
  assert.deepEqual(await maintenance.stop(1_000), {
    drained: true,
    activeWorkers: 0,
  });
});
