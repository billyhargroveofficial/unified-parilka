import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const maintainSource = readFileSync(
  resolve("systemd/parilka-maintain.service"),
  "utf8",
);
const projectSource = readFileSync(
  resolve("systemd/parilka-hermes-project.service"),
  "utf8",
);

test("maintain unit no longer wants the Hermes projection oneshot", () => {
  assert.doesNotMatch(
    maintainSource,
    /^Wants=parilka-hermes-project\.service$/mu,
  );
  for (const strong of ["Requires=", "BindsTo=", "PartOf="]) {
    assert.doesNotMatch(
      maintainSource,
      new RegExp(`^${strong}parilka-hermes-project`, "mu"),
      `maintain must not ${strong.trim()} the Hermes projection unit`,
    );
  }
});

test("maintain unit no longer runs the projection ExecStart", () => {
  assert.doesNotMatch(
    maintainSource,
    /^ExecStart=.*parilka-hermes-project/mu,
  );
  assert.doesNotMatch(maintainSource, /hermes\/profiles/u);
});

test("projection unit runs after maintenance", () => {
  assert.match(
    projectSource,
    /^After=parilka-maintain\.service$/mu,
  );
});

test("projection unit has exactly one ExecStart with --apply", () => {
  const execStarts = projectSource.match(/^ExecStart=.*$/gmu);
  assert.ok(execStarts);
  assert.equal(execStarts.length, 1);
  assert.match(
    execStarts[0]!,
    /bin\/parilka-hermes-project --apply$/u,
  );
});

test("projection unit keeps the DB lock path and the optional profile writable", () => {
  assert.match(
    projectSource,
    /^ReadWritePaths=%h\/\.telegram-parilka-mcp -%h\/\.hermes\/profiles\/parilka$/mu,
  );
  assert.match(projectSource, /^ProtectHome=read-only$/mu);
});
