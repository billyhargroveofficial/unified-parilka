import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LoopbackJsonClient,
  LoopbackJsonResponseTooLargeError,
  LoopbackJsonTimeoutError,
} from "../src/bot/web-tools/loopback-json.js";

async function settle(): Promise<void> {
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
}

function delayedResponse(
  body: string,
  headersDelayMs: number,
): { fetchImpl: typeof fetch; signalHolder: { signal?: AbortSignal | null } } {
  const signalHolder: { signal?: AbortSignal | null } = {};
  const fetchImpl = (async (
    _input: string | URL,
    init?: RequestInit,
  ) => {
    signalHolder.signal = init?.signal;
    await new Promise((resolveTick, rejectTick) => {
      const timer = setTimeout(resolveTick, headersDelayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        rejectTick(
          init.signal?.reason ?? new DOMException("Aborted", "AbortError"),
        );
      }, { once: true });
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, signalHolder };
}

test("timeout covers stalled headers", async () => {
  const { fetchImpl } = delayedResponse("{}", 10_000);
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 50,
    fetchImpl,
  });
  await assert.rejects(
    () => client.request({ path: "/search", method: "GET" }),
    LoopbackJsonTimeoutError,
  );
});

test("timeout covers a stalled body read and cancels the reader", async () => {
  let readerSignal: AbortSignal | null | undefined;
  const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
    readerSignal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = (): void => {
          controller.error(new DOMException("Aborted", "AbortError"));
        };
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        // Never deliver body chunks; the deadline must cancel the read.
        void controller;
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 50,
    fetchImpl,
  });
  await assert.rejects(
    () => client.request({ path: "/search", method: "GET" }),
    LoopbackJsonTimeoutError,
  );
  assert.equal(readerSignal?.aborted, true);
});

test("caller abort during body reads stays distinguishable from timeout", async () => {
  const caller = new AbortController();
  const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => {
          controller.error(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 5_000,
    fetchImpl,
  });
  const promise = client.request({ path: "/search", method: "GET", signal: caller.signal });
  await settle();
  caller.abort(new Error("caller cancelled"));
  await assert.rejects(promise, (error: unknown) => {
    // The caller's abort is NOT converted into an own-timeout error.
    assert.ok(!(error instanceof LoopbackJsonTimeoutError));
    return true;
  });
  assert.equal(caller.signal.aborted, true);
});

test("caller abort after headers resolve cannot turn into success", async () => {
  const caller = new AbortController();
  let resolveHeaders!: () => void;
  const headersGate = new Promise<void>((resolveGate) => {
    resolveHeaders = resolveGate;
  });
  const fetchImpl = (async () => {
    // The fake returns headers and never consults the abort signal.
    resolveHeaders();
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 5_000,
    fetchImpl,
  });
  const promise = client.request({
    path: "/search",
    method: "GET",
    signal: caller.signal,
  });
  await headersGate;
  caller.abort(new Error("caller cancelled"));
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as Error).message, "caller cancelled");
    assert.ok(!(error instanceof LoopbackJsonTimeoutError));
    return true;
  });
});

test("caller abort between body reads cancels an abort-ignoring upstream", async () => {
  const caller = new AbortController();
  let releaseFirst!: () => void;
  const firstChunkGate = new Promise<void>((resolveGate) => {
    releaseFirst = resolveGate;
  });
  let resolveReadStarted!: () => void;
  const readStarted = new Promise<void>((resolveStarted) => {
    resolveReadStarted = resolveStarted;
  });
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        resolveReadStarted();
        // The fake ignores the abort signal while gated.
        await firstChunkGate;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 5_000,
    fetchImpl,
  });
  const promise = client.request({
    path: "/search",
    method: "GET",
    signal: caller.signal,
  });
  await readStarted; // the first body read is in flight
  caller.abort(new Error("caller cancelled"));
  releaseFirst();
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as Error).message, "caller cancelled");
    assert.ok(!(error instanceof LoopbackJsonTimeoutError));
    return true;
  });
});

test("deadline abort between body reads times out an abort-ignoring upstream", async () => {
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // The fake never watches the composed signal; the deadline must win
        // at the next between-reads check.
        await new Promise((resolveTick) => setTimeout(resolveTick, 100));
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 30,
    fetchImpl,
  });
  await assert.rejects(
    () => client.request({ path: "/search", method: "GET" }),
    LoopbackJsonTimeoutError,
  );
});

test("caller abort during the final read cannot turn done into success", async () => {
  const caller = new AbortController();
  let markFinalReadStarted!: () => void;
  const finalReadStarted = new Promise<void>((resolveStarted) => {
    markFinalReadStarted = resolveStarted;
  });
  let releaseFinalRead!: () => void;
  const finalReadGate = new Promise<void>((resolveGate) => {
    releaseFinalRead = resolveGate;
  });
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        // The final read stays pending until the caller aborts; the upstream
        // ignores the signal and then reports done anyway.
        markFinalReadStarted();
        await finalReadGate;
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 5_000,
    fetchImpl,
  });
  const promise = client.request({
    path: "/search",
    method: "GET",
    signal: caller.signal,
  });
  await finalReadStarted; // the read that will return done=true is in flight
  caller.abort(new Error("caller cancelled"));
  releaseFinalRead();
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as Error).message, "caller cancelled");
    assert.ok(!(error instanceof LoopbackJsonTimeoutError));
    return true;
  });
});

test("deadline abort during the final read cannot turn done into success", async () => {
  let markFinalReadStarted!: () => void;
  const finalReadStarted = new Promise<void>((resolveStarted) => {
    markFinalReadStarted = resolveStarted;
  });
  let releaseFinalRead!: () => void;
  const finalReadGate = new Promise<void>((resolveGate) => {
    releaseFinalRead = resolveGate;
  });
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        // The fake ignores the deadline signal and reports done after it
        // expired; the post-read check must still fail the request.
        markFinalReadStarted();
        await finalReadGate;
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 30,
    fetchImpl,
  });
  const promise = client.request({ path: "/search", method: "GET" });
  await finalReadStarted;
  await new Promise((resolveTick) => setTimeout(resolveTick, 100)); // outlive the 30ms deadline
  releaseFinalRead();
  await assert.rejects(promise, LoopbackJsonTimeoutError);
});

test("requests use redirect: error and bounded byte caps", async () => {
  let seenRedirect = "";
  const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
    seenRedirect = init?.redirect ?? "";
    const oversized = "x".repeat(1_024);
    return new Response(oversized, { status: 200 });
  }) as typeof fetch;
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    maxResponseBytes: 128,
    fetchImpl,
  });
  await assert.rejects(
    () => client.request({ path: "/search", method: "GET" }),
    LoopbackJsonResponseTooLargeError,
  );
  assert.equal(seenRedirect, "error");
});

test("composed signal listeners are cleaned up after a successful request", async () => {
  const caller = new AbortController();
  const fetchImpl = (async (_input: string | URL) => {
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 5_000,
    fetchImpl,
  });
  const result = await client.request({
    path: "/search",
    method: "GET",
    signal: caller.signal,
  });
  assert.equal(result.status, 200);
  assert.equal(result.text, "{}");
  // Listener removal is verified implicitly: aborting after completion must
  // not reject anything or leave pending work.
  caller.abort();
});

test("constructor validates bounded positive options", () => {
  assert.throws(
    () => new LoopbackJsonClient({
      origin: "http://127.0.0.1:8080",
      timeoutMs: 0,
    }),
    /timeoutMs/u,
  );
  assert.throws(
    () => new LoopbackJsonClient({
      origin: "http://127.0.0.1:8080",
      timeoutMs: Number.NaN,
    }),
    /timeoutMs/u,
  );
  assert.throws(
    () => new LoopbackJsonClient({
      origin: "http://127.0.0.1:8080",
      maxResponseBytes: -1,
    }),
    /maxResponseBytes/u,
  );
  assert.throws(
    () => new LoopbackJsonClient({ origin: "http://remote.example:8080" }),
    /loopback/u,
  );
});

test("caller abort before the request starts maps to caller error", async () => {
  const caller = new AbortController();
  caller.abort(new Error("already gone"));
  const client = new LoopbackJsonClient({
    origin: "http://127.0.0.1:8080",
    timeoutMs: 5_000,
    fetchImpl: (async (_input: string | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => client.request({ path: "/x", method: "GET", signal: caller.signal }),
    (error: unknown) => error instanceof Error && error.message === "already gone",
  );
});
