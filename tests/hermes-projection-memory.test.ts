import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../src/store.js";
import { readMemoryCharLimit } from "../src/hermes-projection/apply.js";
import {
  planMemoryRender,
  assembleMemoryContent,
  countManagedEntries,
  detectMemoryDrift,
  codepointLength,
  pythonStrip,
  parseMemoryEntries,
  HERMES_MEMORY_DELIMITER,
  MANAGED_SEMANTIC_PREFIX,
  MANAGED_FAST_PREFIX,
} from "../src/hermes-projection/render-memory.js";
import { captureDreamSnapshot } from "../src/hermes-projection/snapshot.js";
import {
  CHAT_ID,
  seedMemory,
  seedFastMemory,
} from "./support/hermes-projection-helpers.js";

const CONFIG = "memory:\n  memory_char_limit: 8000\n";

function tmpProfile(configYaml: string = CONFIG): {
  home: string;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "parilka-hp-mem-"));
  mkdirSync(join(dir, "memories"), { recursive: true });
  writeFileSync(join(dir, "config.yaml"), configYaml, "utf-8");
  return {
    home: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function tmpStore(): { store: MessageStore; cleanup(): void } {
  const store = new MessageStore(":memory:");
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "T",
    kind: "channel",
    isForum: false,
  });
  return { store, cleanup: () => store.close() };
}

test("readMemoryCharLimit extracts value from config.yaml", () => {
  const profile = tmpProfile();
  try {
    assert.equal(readMemoryCharLimit(profile.home), 8000);
  } finally {
    profile.cleanup();
  }
});

test("readMemoryCharLimit accepts plain-space tail and comment", () => {
  const profile = tmpProfile(
    "memory:\n  memory_char_limit: 8000   \n  memory_enabled: true\n",
  );
  try {
    assert.equal(readMemoryCharLimit(profile.home), 8000);
  } finally {
    profile.cleanup();
  }
  const commented = tmpProfile(
    "memory:\n  # limit for consolidated memory\n  memory_char_limit: 9000 # chars\n",
  );
  try {
    assert.equal(readMemoryCharLimit(commented.home), 9000);
  } finally {
    commented.cleanup();
  }
});

test("readMemoryCharLimit skips sibling scalars and ends at top-level key", () => {
  const profile = tmpProfile(
    "memory:\n  enabled: true\n  memory_char_limit: 7000\nother:\n  memory_char_limit: 9999\n",
  );
  try {
    assert.equal(readMemoryCharLimit(profile.home), 7000);
  } finally {
    profile.cleanup();
  }
});

test("readMemoryCharLimit throws if key missing", () => {
  const profile = tmpProfile("memory:\n  memory_enabled: true\n");
  try {
    assert.throws(() => readMemoryCharLimit(profile.home));
  } finally {
    profile.cleanup();
  }
});

test("readMemoryCharLimit throws if value < 100", () => {
  const profile = tmpProfile("memory:\n  memory_char_limit: 50\n");
  try {
    assert.throws(() => readMemoryCharLimit(profile.home));
  } finally {
    profile.cleanup();
  }
});

test("readMemoryCharLimit rejects duplicate scalar", () => {
  const profile = tmpProfile(
    "memory:\n  memory_char_limit: 8000\n  memory_char_limit: 9000\n",
  );
  try {
    assert.throws(() => readMemoryCharLimit(profile.home), /[Dd]uplicate/);
  } finally {
    profile.cleanup();
  }
});

function assertCharLimitRejected(profileHome: string, configYaml: string): void {
  try {
    readMemoryCharLimit(profileHome);
    assert.fail(`expected rejection for config: ${JSON.stringify(configYaml)}`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
  }
}

test("readMemoryCharLimit rejects junk suffix and invalid values", () => {
  for (const configYaml of [
    "memory:\n  memory_char_limit: 8000x\n",
    "memory:\n  memory_char_limit: abc\n",
    'memory:\n  memory_char_limit: "8000"\n',
    "memory:\n  memory_char_limit: -5\n",
    "memory:\n  memory_char_limit:\n",
    "memory:\n  memory_char_limit: 8000#comment\n",
    "memory:\n  memory_char_limit: 12345678901234567890\n",
  ]) {
    const profile = tmpProfile(configYaml);
    try {
      assertCharLimitRejected(profile.home, configYaml);
    } finally {
      profile.cleanup();
    }
  }
});

test("readMemoryCharLimit rejects tabs anywhere", () => {
  for (const configYaml of [
    "memory:\n\tmemory_char_limit: 8000\n",
    "memory:\n  memory_char_limit:\t8000\n",
    "memory:\n  memory_char_limit: 8000\t\n",
  ]) {
    const profile = tmpProfile(configYaml);
    try {
      assertCharLimitRejected(profile.home, configYaml);
    } finally {
      profile.cleanup();
    }
  }
});

test("readMemoryCharLimit rejects nested or wrong indentation", () => {
  for (const configYaml of [
    "memory:\n    memory_char_limit: 8000\n",
    "memory:\n   memory_char_limit: 8000\n",
    "memory:\n memory_char_limit: 8000\n",
    "memory:\n  x:\n    memory_char_limit: 8000\n",
  ]) {
    const profile = tmpProfile(configYaml);
    try {
      assertCharLimitRejected(profile.home, configYaml);
    } finally {
      profile.cleanup();
    }
  }
});

test("readMemoryCharLimit requires a top-level memory block", () => {
  for (const configYaml of [
    "other:\n  memory_char_limit: 8000\n",
    " memory:\n  memory_char_limit: 8000\n",
    "memory: true\n",
  ]) {
    const profile = tmpProfile(configYaml);
    try {
      assertCharLimitRejected(profile.home, configYaml);
    } finally {
      profile.cleanup();
    }
  }
});

test("pythonStrip matches Python str.strip set and skips FEFF", () => {
  assert.equal(pythonStrip("  padded  "), "padded");
  assert.equal(pythonStrip("\t\n x \u3000"), "x");
  assert.equal(pythonStrip("\u001c\u001d\u001e\u001fx\u001f"), "x");
  assert.equal(pythonStrip("\u0085\u00a0\u1680x\u2000\u200a\u2028\u2029\u202f\u205f"), "x");
  // U+FEFF is not Python whitespace and must survive.
  assert.equal(pythonStrip("\uFEFFx\uFEFF"), "\uFEFFx\uFEFF");
  assert.equal(pythonStrip("\uFEFF"), "\uFEFF");
});

test("snapshot hash is deterministic and covers content", () => {
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "test memory", 1, 42);
    seedFastMemory(store, CHAT_ID, "note1", "value1", 1000);
    const snap1 = captureDreamSnapshot(store, CHAT_ID);
    const snap2 = captureDreamSnapshot(store, CHAT_ID);
    assert.equal(snap1.contentHash, snap2.contentHash);
    seedMemory(store, CHAT_ID, "different memory", 2);
    assert.notEqual(
      snap1.contentHash,
      captureDreamSnapshot(store, CHAT_ID).contentHash,
    );
  } finally {
    cleanup();
  }
});

test("delimiter is exact \\n§\\n and entries are stripped non-empty", () => {
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "managed", 1);
    const plan = planMemoryRender(
      captureDreamSnapshot(store, CHAT_ID),
      "owner1\n§\nowner2",
    );
    assert.deepEqual(plan.ownerEntries, ["owner1", "owner2"]);
    // Python-style whitespace around entries is stripped by the Hermes parse.
    const trimmed = planMemoryRender(
      captureDreamSnapshot(store, CHAT_ID),
      "  padded  \n§\n\nowner",
    );
    assert.deepEqual(trimmed.ownerEntries, ["padded", "owner"]);
  } finally {
    cleanup();
  }
});

test("parseMemoryEntries strips Python whitespace only", () => {
  assert.deepEqual(parseMemoryEntries("a\x1c\n§\nb\u3000"), ["a", "b"]);
  assert.deepEqual(parseMemoryEntries("a\uFEFF\n§\nb\uFEFF"), [
    "a\uFEFF",
    "b\uFEFF",
  ]);
});

test("managed entries are never owner entries", () => {
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "semantic", 1, 42);
    seedFastMemory(store, CHAT_ID, "fast", "note", 1000);
    const managed = planMemoryRender(
      captureDreamSnapshot(store, CHAT_ID),
      undefined,
    );
    const withManagedOwner = planMemoryRender(
      captureDreamSnapshot(store, CHAT_ID),
      `${MANAGED_SEMANTIC_PREFIX} old\n§\nreal owner`,
    );
    assert.deepEqual(withManagedOwner.ownerEntries, ["real owner"]);
    assert.ok(managed.semanticEntry.includes(MANAGED_SEMANTIC_PREFIX));
    assert.ok(managed.semanticEntry.includes("rev:1"));
    assert.ok(managed.semanticEntry.includes("msg:42"));
    assert.ok(managed.fastEntries[0]!.includes(MANAGED_FAST_PREFIX));
  } finally {
    cleanup();
  }
});

test("fast entries are newest-first in the plan", () => {
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "semantic", 1);
    seedFastMemory(store, CHAT_ID, "older", "first", 1000);
    seedFastMemory(store, CHAT_ID, "newer", "second", 3000);
    seedFastMemory(store, CHAT_ID, "middle", "third", 2000);
    const plan = planMemoryRender(
      captureDreamSnapshot(store, CHAT_ID),
      undefined,
    );
    assert.ok(plan.fastEntries[0]!.includes("newer"));
    assert.ok(plan.fastEntries[1]!.includes("middle"));
    assert.ok(plan.fastEntries[2]!.includes("older"));
  } finally {
    cleanup();
  }
});

test("drift: well-formed content roundtrips", () => {
  assert.equal(detectMemoryDrift(undefined, 8000), undefined);
  assert.equal(detectMemoryDrift("owner1\n§\nowner2", 8000), undefined);
  assert.equal(
    detectMemoryDrift("😀".repeat(100) + "\n§\n" + "x".repeat(500), 8000),
    undefined,
  );
});

test("drift: FEFF is kept, never a false positive (Python strip)", () => {
  assert.equal(detectMemoryDrift("\uFEFFabc\n§\ndef", 8000), undefined);
  assert.equal(detectMemoryDrift("abc\uFEFF\n§\ndef", 8000), undefined);
  assert.equal(detectMemoryDrift("abc\n§\ndef\uFEFF", 8000), undefined);
});

test("drift: C0 controls are stripped like Python strip", () => {
  // Trailing U+001C..U+001F is stripped by str.strip → clean roundtrip.
  assert.equal(detectMemoryDrift("abc\n§\ndef\x1c", 8000), undefined);
  assert.equal(detectMemoryDrift("abc\n§\ndef\x1f", 8000), undefined);
  assert.equal(detectMemoryDrift("abc\n§\ndef\x1c\x1d\x1e\x1f", 8000), undefined);
  // Interior C0 is stripped per entry but not at the raw boundary → drift.
  const reason = detectMemoryDrift("abc\x1c\n§\ndef", 8000);
  assert.ok(reason, "expected drift reason");
  assert.ok(reason!.includes("roundtrip"));
});

test("drift: internal whitespace breaks roundtrip", () => {
  const reason = detectMemoryDrift("abc  \n§\ndef", 8000);
  assert.ok(reason, "expected drift reason");
  assert.ok(reason!.includes("roundtrip"));
  const reason2 = detectMemoryDrift("abc\n§\n def", 8000);
  assert.ok(reason2, "expected drift reason");
});

test("drift: empty entries break roundtrip", () => {
  assert.ok(detectMemoryDrift("abc\n§\n\n§\ndef", 8000));
});

test("drift: single entry over full char limit in codepoints", () => {
  // 8001 codepoints > 8000 limit → drift, even though bytes are way above.
  assert.ok(detectMemoryDrift("😀".repeat(8001), 8000));
  // Exactly at the limit in codepoints (16002 UTF-16 units) → no drift.
  assert.equal(detectMemoryDrift("😀".repeat(8000), 8000), undefined);
});

test("assemble: owner first, then semantic, then fast", () => {
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "semantic text", 1);
    seedFastMemory(store, CHAT_ID, "fast", "note", 1000);
    const plan = planMemoryRender(
      captureDreamSnapshot(store, CHAT_ID),
      "owner note",
    );
    const assembled = assembleMemoryContent(plan, 8000)!;
    assert.ok(assembled);
    const ownerAt = assembled.content.indexOf("owner note");
    const semanticAt = assembled.content.indexOf(MANAGED_SEMANTIC_PREFIX);
    const fastAt = assembled.content.indexOf(MANAGED_FAST_PREFIX);
    assert.ok(ownerAt >= 0 && ownerAt < semanticAt && semanticAt < fastAt);
  } finally {
    cleanup();
  }
});

test("assemble: maximal newest-first fast prefix, not all or nothing", () => {
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "s", 1);
    for (let i = 0; i < 5; i++) {
      seedFastMemory(store, CHAT_ID, `note${i}`, "f".repeat(100), 1000 + i);
    }
    const plan = planMemoryRender(
      captureDreamSnapshot(store, CHAT_ID),
      "o",
    );
    // Each fast entry is ~160 codepoints with its marker line; limit 400
    // admits exactly two of them after owner + semantic.
    const assembled = assembleMemoryContent(plan, 400)!;
    assert.ok(assembled);
    const fastCount = assembled.content
      .split(HERMES_MEMORY_DELIMITER)
      .filter((entry) => entry.startsWith(MANAGED_FAST_PREFIX)).length;
    assert.equal(fastCount, 2);
    assert.equal(assembled.managedEntries, 3);
    // Newest-first prefix: the two newest entries fit, the rest are dropped.
    assert.ok(assembled.content.includes("note4"));
    assert.ok(assembled.content.includes("note3"));
    assert.ok(!assembled.content.includes("note2"));
  } finally {
    cleanup();
  }
});

test("assemble: owner + semantic overflow returns undefined", () => {
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "s".repeat(4000), 1);
    const plan = planMemoryRender(
      captureDreamSnapshot(store, CHAT_ID),
      "y".repeat(5000),
    );
    assert.equal(assembleMemoryContent(plan, 8000), undefined);
  } finally {
    cleanup();
  }
});

test("assemble: content has no trailing newline and is exact", () => {
  const { store, cleanup } = tmpStore();
  try {
    seedMemory(store, CHAT_ID, "semantic", 1);
    seedFastMemory(store, CHAT_ID, "note", "value", 1000);
    const plan = planMemoryRender(
      captureDreamSnapshot(store, CHAT_ID),
      "owner",
    );
    const assembled = assembleMemoryContent(plan, 8000)!;
    assert.ok(assembled);
    assert.equal(assembled.content.endsWith("\n"), false);
    assert.equal(assembled.content.trim(), assembled.content);
    assert.equal(countManagedEntries(plan), assembled.managedEntries);
  } finally {
    cleanup();
  }
});
