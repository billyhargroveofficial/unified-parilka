import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const maintainSource = readFileSync(
  resolve("systemd/parilka-maintain.service"),
  "utf8",
);
const projectSource = readFileSync(
  resolve("systemd/parilka-openclaw-project.service"),
  "utf8",
);

test("maintain unit weakly wants the OpenClaw projection oneshot", () => {
  assert.match(maintainSource, /^Wants=parilka-openclaw-project\.service$/mu);
  assert.doesNotMatch(maintainSource, /parilka-hermes-project/u);
});

test("OpenClaw config fragment denies host MCP, nodes, and extra sessions", () => {
  const fragment = JSON.parse(
    readFileSync(resolve("integrations/openclaw/config.fragment.json"), "utf8"),
  ) as {
    agents: {
      entries: {
        parilka: { tools: { deny: string[] }; skills: string[] };
      };
    };
  };
  const deny = fragment.agents.entries.parilka.tools.deny;
  for (const name of ["bundle-mcp", "group:nodes", "group:sessions", "telegram__*", "telegram-wife__*"]) {
    assert.ok(deny.includes(name), name);
  }
  assert.ok(fragment.agents.entries.parilka.skills.includes("parilka-lessons"));
});

test("OpenClaw projection unit runs after maintenance", () => {
  assert.match(projectSource, /^After=parilka-maintain\.service$/mu);
});

test("OpenClaw projection unit has exactly one ExecStart with --apply", () => {
  const execStarts = projectSource.match(/^ExecStart=.*$/gmu);
  assert.ok(execStarts);
  assert.equal(execStarts.length, 1);
  assert.match(execStarts[0]!, /bin\/parilka-openclaw-project --apply$/u);
});

test("OpenClaw projection unit keeps the DB lock path and optional workspace writable", () => {
  assert.match(
    projectSource,
    /^ReadWritePaths=%h\/\.telegram-parilka-mcp -%h\/\.openclaw\/workspace-parilka$/mu,
  );
  assert.match(projectSource, /^ProtectHome=read-only$/mu);
});
