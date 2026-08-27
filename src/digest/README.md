# Digest slice

`src/digests.ts` is the stable public barrel. The slice plans source-hashed
Moscow day/week summaries, calls the narrow direct-Responses summary port, and
commits only after source/prompt recheck.

- `source.ts`, `planner.ts`, `calendar.ts`: canonical source, invalidation and
  Moscow boundaries.
- `day-phase.ts`, `week-phase.ts`: sequential durable transitions.
- `generation-support.ts`, `summary-text-port.ts`: narrow text port; production
  implementation is direct Responses, not Codex app-server.
- `process-lock.ts`: one local apply owner.

Dry-run never calls a model or mutates state and reports the whole backlog.
Apply respects day/week limits, leaves deferred rows intact, does not generate
the current Moscow day, rechecks source hash after a call and refuses a weekly
rollup with missing/failed/stale required day. The maintenance runner is
hard-pinned to Luna/fast and has no provider fallback.
