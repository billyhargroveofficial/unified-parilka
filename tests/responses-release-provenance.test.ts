import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type ProvenanceModule = {
  RESPONSES_SOURCE_MANIFEST_NAME: string;
  createResponsesReleaseProvenance(
    projectDir: string,
    files: readonly string[],
  ): unknown;
  serializeResponsesReleaseProvenance(provenance: unknown): string;
  verifyResponsesReleaseProvenance(
    projectDir: string,
    releaseDir: string,
    files: readonly string[],
  ): void;
};

type ReleaseBuilderModule = {
  acquireResponsesReleaseBuildLock(lockDir: string): unknown;
  releaseResponsesReleaseBuildLock(lock: unknown): void;
  switchCurrentPointer(
    target: string,
    options: Readonly<{ pointer: string; pointerDirectory: string; temporaryName: string }>,
  ): unknown;
  restoreCurrentPointerIfOwned(
    previousReleaseDir: string | undefined,
    activation: unknown,
    options: Readonly<{ pointer: string; pointerDirectory: string; temporaryName: string }>,
  ): boolean;
};

test("Responses release provenance is deterministic and rejects changed input", async (t) => {
  const provenance = await import(
    pathToFileURL(resolve("scripts/responses-release-provenance.mjs")).href,
  ) as ProvenanceModule;
  const project = mkdtempSync(join(tmpdir(), "parilka-release-provenance-"));
  const release = join(project, "release");
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(release, { recursive: true });
  writeFileSync(join(project, "src", "agent.ts"), "export const answer = 42;\n");
  writeFileSync(join(project, "package.json"), "{\"name\":\"fixture\"}\n");
  const files = ["package.json", "src/agent.ts"] as const;
  const first = provenance.serializeResponsesReleaseProvenance(
    provenance.createResponsesReleaseProvenance(project, files),
  );
  const second = provenance.serializeResponsesReleaseProvenance(
    provenance.createResponsesReleaseProvenance(project, [...files].reverse()),
  );
  assert.equal(first, second);
  assert.equal(first.includes(project), false);
  writeFileSync(join(release, provenance.RESPONSES_SOURCE_MANIFEST_NAME), first, { mode: 0o444 });
  provenance.verifyResponsesReleaseProvenance(project, release, files);

  writeFileSync(join(project, "src", "agent.ts"), "export const answer = 43;\n");
  assert.throws(
    () => provenance.verifyResponsesReleaseProvenance(project, release, files),
    /does not match current source\/config\/package inputs/u,
  );
});

test("Responses release builder serializes concurrent builders, reclaims only a proven stale lock, and CAS-protects rollback", async (t) => {
  const builder = await import(
    `${pathToFileURL(resolve("scripts/build-responses-release.mjs")).href}?release-lock-test=${Date.now()}`,
  ) as ReleaseBuilderModule;
  const project = mkdtempSync(join(tmpdir(), "parilka-release-lock-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const deploy = join(project, ".deploy");
  const releases = join(deploy, "responses-releases");
  const pointer = join(deploy, "responses-current");
  mkdirSync(releases, { recursive: true });
  const oldRelease = join(releases, "20260827000000000-1-aaaaaaaaaaaa");
  const releaseA = join(releases, "20260827000000000-2-bbbbbbbbbbbb");
  const releaseB = join(releases, "20260827000000000-3-cccccccccccc");
  mkdirSync(oldRelease);
  mkdirSync(releaseA);
  mkdirSync(releaseB);
  symlinkSync(join("responses-releases", "20260827000000000-1-aaaaaaaaaaaa"), pointer);

  const lockPath = join(deploy, ".responses-release-build.lock");
  const first = builder.acquireResponsesReleaseBuildLock(lockPath);
  assert.throws(
    () => builder.acquireResponsesReleaseBuildLock(lockPath),
    /already holds the build lock/u,
  );
  builder.releaseResponsesReleaseBuildLock(first);

  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
    pid: 2_147_483_647,
    ...(process.getuid?.() === undefined ? {} : { uid: process.getuid() }),
    hostname: hostname(),
    nonce: "0".repeat(32),
  })}\n`, { mode: 0o600 });
  const reclaimedStale = builder.acquireResponsesReleaseBuildLock(lockPath);
  builder.releaseResponsesReleaseBuildLock(reclaimedStale);
  // A newly activated B supersedes A before A discovers its post-activation
  // failure. A's identity-CAS rollback must leave B current.
  const activationA = builder.switchCurrentPointer(releaseA, {
    pointer, pointerDirectory: deploy, temporaryName: ".pointer-a",
  });
  builder.switchCurrentPointer(releaseB, {
    pointer, pointerDirectory: deploy, temporaryName: ".pointer-b",
  });
  assert.equal(builder.restoreCurrentPointerIfOwned(oldRelease, activationA, {
    pointer, pointerDirectory: deploy, temporaryName: ".rollback-a",
  }), false);
  assert.equal(realpathSync(pointer), releaseB);
});
