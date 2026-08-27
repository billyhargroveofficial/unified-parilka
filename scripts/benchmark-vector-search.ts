import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  blobToVector,
  cosineSimilarity,
  createBlobCosineScorer,
  vectorToBlob,
} from "../src/embeddings.js";
import { MessageStore } from "../src/store.js";

const candidateCount = intArg("--candidates", 20_000);
const dimensions = intArg("--dimensions", 256);
const runs = intArg("--runs", 25);
const targetP95Ms = intArg("--target-p95-ms", 250);
const coverageMessages = intArg("--coverage-messages", 0);
const coverageTargetMs = intArg("--coverage-target-ms", 2_000);

if (coverageMessages > 0) {
  runCoverageBenchmark(coverageMessages, coverageTargetMs);
} else if (process.argv.includes("--blob-hot-path")) {
  runBlobHotPathBenchmark();
} else {
  runVectorBenchmark();
}

function runVectorBenchmark(): void {
  const query = normalizedVector(dimensions, 1);
  const candidates = Array.from({ length: candidateCount }, (_, index) => normalizedVector(dimensions, index + 2));
  const durations: number[] = [];

  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    let best = -Infinity;
    for (const candidate of candidates) {
      const score = cosineSimilarity(query, candidate);
      if (score > best) {
        best = score;
      }
    }
    durations.push(performance.now() - started);
  }

  durations.sort((left, right) => left - right);
  const p95 = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
  const rssMb = process.memoryUsage().rss / (1024 * 1024);
  const ok = p95 <= targetP95Ms;

  console.log(
    JSON.stringify(
      {
        ok,
        candidateCount,
        dimensions,
        runs,
        targetP95Ms,
        p95Ms: Number(p95.toFixed(2)),
        rssMb: Number(rssMb.toFixed(2)),
        note: "Synthetic cosine loop only; use before raising TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT.",
      },
      null,
      2,
    ),
  );

  if (!ok) {
    process.exitCode = 1;
  }
}

/**
 * Regression microbenchmark for the production dense BLOB path. It reports
 * the retired copy/decode+cosine path alongside the one-pass scorer so a
 * candidate-cap increase can be evaluated without involving SQLite I/O.
 */
function runBlobHotPathBenchmark(): void {
  const query = normalizedVector(dimensions, 1);
  const blobs = Array.from(
    { length: candidateCount },
    (_, index) => vectorToBlob(Array.from(normalizedVector(dimensions, index + 2))),
  );
  const scoreBlob = createBlobCosineScorer(query);
  const directDurations: number[] = [];
  const legacyDurations: number[] = [];

  // Let V8 optimize both loops before recording timings.
  scoreAllBlobs(blobs, (blob) => scoreBlob(blob, dimensions));
  scoreAllBlobs(blobs, (blob) => cosineSimilarity(query, blobToVector(blob, dimensions)));
  for (let run = 0; run < runs; run += 1) {
    let started = performance.now();
    scoreAllBlobs(blobs, (blob) => scoreBlob(blob, dimensions));
    directDurations.push(performance.now() - started);

    started = performance.now();
    scoreAllBlobs(blobs, (blob) => cosineSimilarity(query, blobToVector(blob, dimensions)));
    legacyDurations.push(performance.now() - started);
  }

  directDurations.sort((left, right) => left - right);
  legacyDurations.sort((left, right) => left - right);
  const directP95 = percentile95(directDurations);
  const legacyP95 = percentile95(legacyDurations);
  const ok = directP95 <= targetP95Ms;
  console.log(
    JSON.stringify(
      {
        ok,
        candidateCount,
        dimensions,
        runs,
        targetP95Ms,
        directOnePassBlobP95Ms: Number(directP95.toFixed(2)),
        legacyCopyDecodeP95Ms: Number(legacyP95.toFixed(2)),
        speedup: Number((legacyP95 / directP95).toFixed(2)),
        rssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2)),
        note: "Synthetic dense BLOB scoring only; excludes SQLite row fetch and ranked-hit hydration.",
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
}

function scoreAllBlobs(
  blobs: readonly Uint8Array[],
  score: (blob: Uint8Array) => number,
): number {
  let best = -Infinity;
  for (const blob of blobs) {
    const value = score(blob);
    if (value > best) best = value;
  }
  return best;
}

function percentile95(durations: readonly number[]): number {
  return durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
}

function runCoverageBenchmark(messageCount: number, targetMs: number): void {
  const chatId = "-100coverage";
  const dir = mkdtempSync(join(tmpdir(), "telegram-coverage-benchmark-"));
  const dbPath = join(dir, "messages.sqlite");
  try {
    const bootstrap = new MessageStore(dbPath);
    bootstrap.close();

    const db = new DatabaseSync(dbPath);
    db.exec("BEGIN IMMEDIATE");
    const stmt = db.prepare(
      `INSERT INTO messages (chat_id, message_id, sender_name, text, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    );
    for (let id = 1; id <= messageCount; id += 1) {
      stmt.run(chatId, id, `sender-${id % 10}`, `coverage benchmark message ${id}`);
    }
    db.exec("COMMIT");
    db.close();

    const store = new MessageStore(dbPath);
    const startedRssMb = process.memoryUsage().rss / (1024 * 1024);
    const started = performance.now();
    const coverage = store.getEmbeddingCoverageStats({
      chatId,
      namespace: "benchmark",
      model: "benchmark-model",
      dimensions,
    });
    const durationMs = performance.now() - started;
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    store.close();

    const ok =
      durationMs <= targetMs &&
      coverage.cache_messages === messageCount &&
      coverage.uncovered_messages === messageCount &&
      coverage.uncovered_ranges === 1;
    console.log(
      JSON.stringify(
        {
          ok,
          messageCount,
          dimensions,
          targetMs,
          durationMs: Number(durationMs.toFixed(2)),
          rssDeltaMb: Number((rssMb - startedRssMb).toFixed(2)),
          rssMb: Number(rssMb.toFixed(2)),
          coverage,
          note: "Synthetic zero-embedding cache benchmark for getEmbeddingCoverageStats().",
        },
        null,
        2,
      ),
    );
    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function normalizedVector(length: number, seed: number): Float32Array {
  const values = new Float32Array(length);
  let sum = 0;
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const value = (state / 0xffffffff) * 2 - 1;
    values[index] = value;
    sum += value * value;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let index = 0; index < values.length; index += 1) {
    values[index] /= norm;
  }
  return values;
}

function intArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const parsed = Number(process.argv[index + 1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
