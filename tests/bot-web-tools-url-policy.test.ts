import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPublicAddress,
  isPublicHttpsCandidate,
  validatePublicHttpsUrl,
} from "../src/bot/read-tools/public-address.js";
import { requireLoopbackHttpOrigin } from "../src/bot/web-tools/url-validation.js";

// ─── Loopback origin validation ─────────────────────────────────────────────

test("loopback origin accepts localhost and 127.x with any port", () => {
  assert.equal(
    requireLoopbackHttpOrigin("http://127.0.0.1:8080"),
    "http://127.0.0.1:8080",
  );
  assert.equal(
    requireLoopbackHttpOrigin("http://localhost:3002"),
    "http://localhost:3002",
  );
  assert.equal(
    requireLoopbackHttpOrigin("http://[::1]:8080"),
    "http://[::1]:8080",
  );
});

test("loopback origin rejects non-HTTP, remote hosts, credentials, path/query", () => {
  assert.throws(() => requireLoopbackHttpOrigin("https://127.0.0.1:8080"), /HTTP/);
  assert.throws(() => requireLoopbackHttpOrigin("http://example.com:8080"), /loopback/);
  assert.throws(() => requireLoopbackHttpOrigin("http://10.0.0.1:8080"), /loopback/);
  assert.throws(
    () => requireLoopbackHttpOrigin("http://user:pass@127.0.0.1:8080"),
    /credential/,
  );
  assert.throws(
    () => requireLoopbackHttpOrigin("http://127.0.0.1:8080/search"),
    /path/,
  );
  assert.throws(
    () => requireLoopbackHttpOrigin("http://127.0.0.1:8080?q=1"),
    /path/,
  );
});

// ─── Public-address policy ──────────────────────────────────────────────────

test("public HTTPS candidates reject credentials, IPs and private hostnames", () => {
  assert.equal(isPublicHttpsCandidate("https://example.com/page"), true);
  assert.equal(isPublicHttpsCandidate("http://example.com/page"), false);
  assert.equal(isPublicHttpsCandidate("https://user:pass@example.com/page"), false);
  assert.equal(isPublicHttpsCandidate("https://example.com:8443/page"), false);
  assert.equal(isPublicHttpsCandidate("https://localhost/page"), false);
  assert.equal(isPublicHttpsCandidate("https://x.local/page"), false);
  assert.equal(isPublicHttpsCandidate("https://x.internal/page"), false);
  assert.equal(isPublicHttpsCandidate("https://x.lan/page"), false);
  assert.equal(isPublicHttpsCandidate("https://192.168.0.1/page"), false);
  assert.equal(isPublicHttpsCandidate("https://10.0.0.1/page"), false);
});

test("resolved private/special addresses fail closed", () => {
  assert.equal(isPublicAddress({ address: "10.0.0.1", family: 4 }), false);
  assert.equal(isPublicAddress({ address: "172.16.0.1", family: 4 }), false);
  assert.equal(isPublicAddress({ address: "192.168.1.1", family: 4 }), false);
  assert.equal(isPublicAddress({ address: "127.0.0.1", family: 4 }), false);
  assert.equal(isPublicAddress({ address: "169.254.1.1", family: 4 }), false);
  assert.equal(isPublicAddress({ address: "0.0.0.0", family: 4 }), false);
  assert.equal(isPublicAddress({ address: "100.64.0.1", family: 4 }), false);
  assert.equal(isPublicAddress({ address: "198.18.0.1", family: 4 }), false);
  assert.equal(isPublicAddress({ address: "192.88.99.1", family: 4 }), false);
  assert.equal(isPublicAddress({ address: "93.184.216.34", family: 4 }), true);
  assert.equal(isPublicAddress({ address: "::1", family: 6 }), false);
  assert.equal(isPublicAddress({ address: "fc00::1", family: 6 }), false);
  assert.equal(isPublicAddress({ address: "fe80::1", family: 6 }), false);
  assert.equal(isPublicAddress({ address: "2001:db8::1", family: 6 }), false);
});

test("validatePublicHttpsUrl accepts public URLs and rejects unsafe ones", () => {
  assert.equal(
    validatePublicHttpsUrl("https://example.com/path?q=1").hostname,
    "example.com",
  );
  assert.throws(() => validatePublicHttpsUrl("https://127.0.0.1/x"));
  assert.throws(() => validatePublicHttpsUrl("https://localhost/x"));
  assert.throws(() => validatePublicHttpsUrl("https://user:pass@example.com/x"));
});
