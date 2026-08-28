import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectTypeFromMagic,
  downloadImages,
} from "../src/bot/web-tools/image-downloader.js";
import { PinnedHttpsError } from "../src/bot/read-tools/public-address.js";
import {
  createTurnImageTracker,
  MAX_IMAGES_PER_TURN,
} from "../src/bot/agent/web-images.js";

const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0, 0, 0, 0,
]);
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);
const PUBLIC_LOOKUP = async (): Promise<readonly { address: string; family: 4 | 6 }[]> =>
  [{ address: "93.184.216.34", family: 4 }];

async function settle(): Promise<void> {
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
}

test("image downloader uses the resolved public address and original host", async () => {
  const captured: Array<{ url: URL; address: { address: string; family: 4 | 6 } }> = [];
  const transport = async (request: {
    url: URL;
    address: { address: string; family: 4 | 6 };
  }) => {
    captured.push({ url: request.url, address: request.address });
    return {
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: Buffer.from(JPEG_BYTES),
    };
  };
  const tracker = createTurnImageTracker();
  const result = await downloadImages(["https://example.com/img/1.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport,
  });
  assert.equal(result.images.length, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.address.address, "93.184.216.34");
  assert.equal(captured[0]!.address.family, 4);
  assert.equal(captured[0]!.url.hostname, "example.com");
  assert.equal(result.images[0]!.mediaType, "image/jpeg");
  assert.equal(tracker.committedCount, 1);
});

test("image downloader rejects private DNS answers", async () => {
  const tracker = createTurnImageTracker();
  const result = await downloadImages(["https://example.com/1.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: async () => [{ address: "10.0.0.1", family: 4 }],
    transport: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(result.images.length, 0);
  assert.equal(result.errors[0]!.code, "unsafe_url");
});

test("image downloader rejects redirects", async () => {
  const tracker = createTurnImageTracker();
  const result = await downloadImages(["https://example.com/1.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport: async () => ({
      status: 302,
      headers: { location: "https://elsewhere.example/1.jpg" },
      body: Buffer.alloc(0),
    }),
  });
  assert.equal(result.errors[0]!.code, "redirect");
});

test("image downloader enforces content-length and streamed caps", async () => {
  const tracker = createTurnImageTracker();
  const tooBig = await downloadImages(["https://example.com/1.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport: async () => ({
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "999999999" },
      body: Buffer.from(JPEG_BYTES),
    }),
  });
  assert.equal(tooBig.errors[0]!.code, "size_limit");

  const streamed = await downloadImages(["https://example.com/2.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport: async () => ({
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: Buffer.concat([
        Buffer.from(JPEG_BYTES),
        Buffer.alloc(11 * 1024 * 1024),
      ]),
    }),
  });
  assert.equal(streamed.errors[0]!.code, "size_limit");
});

test("image downloader validates magic bytes and content-type agreement", async () => {
  assert.equal(detectTypeFromMagic(JPEG_BYTES), "image/jpeg");
  assert.equal(detectTypeFromMagic(PNG_BYTES), "image/png");

  const tracker = createTurnImageTracker();
  const mismatch = await downloadImages(["https://example.com/1.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport: async () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body: Buffer.from(JPEG_BYTES),
    }),
  });
  assert.equal(mismatch.errors[0]!.code, "type_mismatch");

  const unsupported = await downloadImages(["https://example.com/2.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from(JPEG_BYTES),
    }),
  });
  assert.equal(unsupported.errors[0]!.code, "unsupported_type");

  const fake = await downloadImages(["https://example.com/3.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport: async () => ({
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: Buffer.from("not an image at all"),
    }),
  });
  assert.equal(fake.errors[0]!.code, "invalid_image");
});

test("image downloader keeps partial successes on individual failures", async () => {
  const tracker = createTurnImageTracker();
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("network down"), { code: "download_error" });
    }
    return {
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: Buffer.from(JPEG_BYTES),
    };
  };
  const result = await downloadImages(
    ["https://example.com/bad.jpg", "https://example.com/good.jpg"],
    {
      tracker,
      signal: new AbortController().signal,
      lookup: PUBLIC_LOOKUP,
      transport,
    },
  );
  assert.equal(result.images.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(tracker.committedCount, 1);
});

test("cumulative six is atomic across concurrent calls", async () => {
  const tracker = createTurnImageTracker();
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const transport = async () => {
    started += 1;
    await gate;
    return {
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: Buffer.from(JPEG_BYTES),
    };
  };
  const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}.jpg`);
  const first = downloadImages(urls, {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport,
  });
  const second = downloadImages(urls, {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport,
  });
  await settle();
  // The synchronous reservation grants all six slots to the first call.
  assert.equal(tracker.occupiedCount, 6);
  assert.equal(started, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.images.length, 6);
  assert.equal(secondResult.images.length, 0);
  assert.equal(secondResult.skipped, 6);
  assert.equal(tracker.committedCount, 6);
  assert.equal(MAX_IMAGES_PER_TURN, 6);
});

test("turn image tracker settles and frees failed slots", () => {
  const tracker = createTurnImageTracker();
  assert.equal(tracker.reserveCount(6), 6);
  tracker.settleCount([], 6);
  assert.equal(tracker.occupiedCount, 0);
  assert.equal(tracker.reserveCount(6), 6);
  tracker.settleCount(
    [{ data: JPEG_BYTES, mediaType: "image/jpeg", sourceUrl: "https://example.com/1.jpg" }],
    6,
  );
  assert.equal(tracker.committedCount, 1);
  assert.equal(tracker.occupiedCount, 1);
  assert.equal(tracker.reserveCount(6), 5);
});

// ─── Cumulative byte budget ─────────────────────────────────────────────────

const MIB = 1024 * 1024;

function jpegBody(sizeBytes: number): Buffer {
  return Buffer.concat([
    Buffer.from(JPEG_BYTES),
    Buffer.alloc(sizeBytes - JPEG_BYTES.length),
  ]);
}

test("sequential downloads consume the 40 MiB turn budget", async () => {
  const tracker = createTurnImageTracker();
  const transport = async () => ({
    status: 200,
    headers: { "content-type": "image/jpeg" },
    body: jpegBody(7 * MIB),
  });
  const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}.jpg`);
  const result = await downloadImages(urls, {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport,
  });
  // 5 × 7 MiB = 35 MiB fit; the 6th has only 5 MiB available → size_limit.
  assert.equal(result.images.length, 5);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.code, "size_limit");
  // The over-limit stream consumed its reservation: 35 + 5 = 40 MiB.
  assert.equal(tracker.consumedBytes, 40 * MIB);
  assert.ok(tracker.cumulativeBytes <= 40 * MIB);
  assert.equal(tracker.committedCount, 5);
});

test("concurrent downloads share one byte budget", async () => {
  const tracker = createTurnImageTracker();
  let gateA!: () => void;
  let gateB!: () => void;
  const promiseA = new Promise<void>((resolveGate) => {
    gateA = resolveGate;
  });
  const promiseB = new Promise<void>((resolveGate) => {
    gateB = resolveGate;
  });
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls % 2 === 1) {
      await promiseA;
    } else {
      await promiseB;
    }
    return {
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: jpegBody(7 * MIB),
    };
  };
  const urls = Array.from({ length: 3 }, (_, i) => `https://example.com/${i}.jpg`);
  const first = downloadImages(urls, {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport,
  });
  const second = downloadImages(urls, {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport,
  });
  await settle();
  // Two transfers are in flight; consumed + reserved stays within 40 MiB.
  assert.ok(tracker.cumulativeBytes <= 40 * MIB);
  assert.equal(tracker.occupiedCount, 6);
  gateA();
  gateB();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  // Whatever the microtask interleaving, the byte budget never exceeds
  // 40 MiB and the second call ends with a size_limit error.
  assert.ok(tracker.cumulativeBytes <= 40 * MIB);
  assert.equal(firstResult.images.length + secondResult.images.length, 5);
  assert.ok(secondResult.errors.some((error) => error.code === "size_limit"));
  // All successful bytes are counted; failed transfers consumed their
  // reservations instead of bypassing the budget.
  assert.ok(tracker.consumedBytes >= 5 * 7 * MIB);
});

test("invalid-image bytes still consume the turn budget", async () => {
  const tracker = createTurnImageTracker();
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls === 1) {
      // Invalid magic bytes that were actually received.
      return {
        status: 200,
        headers: { "content-type": "image/jpeg" },
        body: Buffer.alloc(2 * MIB, 0x41),
      };
    }
    return {
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: jpegBody(8 * MIB),
    };
  };
  const result = await downloadImages(
    ["https://example.com/bad.jpg", "https://example.com/1.jpg",
      "https://example.com/2.jpg", "https://example.com/3.jpg",
      "https://example.com/4.jpg", "https://example.com/5.jpg"],
    {
      tracker,
      signal: new AbortController().signal,
      lookup: PUBLIC_LOOKUP,
      transport,
    },
  );
  assert.equal(result.errors[0]!.code, "invalid_image");
  // 2 MiB of failed bytes are consumed, then 8+8+8+8 = 32 MiB of successes,
  // then the 6th slot has 6 MiB available → its 8 MiB body is over-limit and
  // consumes the 6 MiB reservation: 2 + 32 + 6 = 40 MiB exactly.
  assert.equal(result.images.length, 4);
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[1]!.code, "size_limit");
  assert.equal(tracker.consumedBytes, 40 * MIB);
  assert.ok(tracker.cumulativeBytes <= 40 * MIB);
});

test("status 0 and invalid statuses are rejected", async () => {
  const tracker = createTurnImageTracker();
  const result = await downloadImages(["https://example.com/1.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport: async () => ({
      status: 0,
      headers: {},
      body: Buffer.from(JPEG_BYTES),
    }),
  });
  assert.equal(result.errors[0]!.code, "http_error");
  assert.equal(tracker.committedCount, 0);
});

// ─── Pinned transport error codes ───────────────────────────────────────────

test("pinned transport failures are not size_limit and free the reservation", async () => {
  const tracker = createTurnImageTracker();
  const result = await downloadImages(["https://example.com/1.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport: async () => {
      throw new PinnedHttpsError("transport", "connection refused");
    },
  });
  assert.equal(result.errors[0]!.code, "provider_unavailable");
  // Nothing was received, so the full 10 MiB reservation is released
  // instead of being consumed as if the payload had hit the cap.
  assert.equal(tracker.consumedBytes, 0);
  assert.equal(tracker.reservedBytes, 0);
  assert.equal(tracker.committedCount, 0);
});

test("pinned response_too_large stays size_limit and consumes the reservation", async () => {
  const tracker = createTurnImageTracker();
  const result = await downloadImages(["https://example.com/1.jpg"], {
    tracker,
    signal: new AbortController().signal,
    lookup: PUBLIC_LOOKUP,
    transport: async () => {
      throw new PinnedHttpsError("response_too_large", "Response exceeded the byte limit.");
    },
  });
  assert.equal(result.errors[0]!.code, "size_limit");
  assert.equal(tracker.consumedBytes, 10 * 1024 * 1024);
  assert.equal(tracker.reservedBytes, 0);
});
