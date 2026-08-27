# Storage layout

`MessageStore` is the stable flat API used by bot, sync, MCP, maintenance and
tests. One `StoreCore` owns one SQLite connection and the transaction kernel;
domain method modules are prototype contributors, not independent repositories.

## Invariants

- `core.ts` alone opens/closes SQLite and implements retry plus
  `BEGIN IMMEDIATE`/commit/rollback.
- Bind values pass `toSqlValues`; transport input is normalized/bounded before
  it reaches SQL.
- Public orchestration may start a transaction; `*Locked` helpers never start
  nested transactions.
- Schema evolution belongs only in `schema/` and requires a migration
  rehearsal plus idempotent second open.
- Embedding chunks are committed only after source re-read in the same write
  transaction; local BGE-M3 output does not bypass source checks.
- Bot turns persist a final draft before the sending fence. A later pre-send
  retry may use that draft; `sending` ambiguity becomes terminal `lost_ack`.

Current schema may retain historical Codex-session objects for migration
compatibility, but the direct Responses runtime does not read, create or depend
on Codex thread bindings. Do not introduce a model session as a replacement for
durable turn state.

## Module map

- `core.ts`, `schema/`: connection, permissions and versioned migrations.
- `messages.ts`, `transcript.ts`: normalized chat corpus and causal reads.
- `bot-updates.ts`, `bot-turns.ts`: durable Bot API inbox, leases, draft and
  publication states.
- `chat-knowledge.ts`, `dream-days.ts`, `dream-commit.ts`, `dream-audit.ts`:
  chat memory and offline consolidation.
- `digests.ts`, `embeddings.ts`: cached summaries and retrieval coverage.
- `send-outbox.ts`, `sync-ops.ts`, `status.ts`: delivery, sync and health.

Add behavior to the narrowest domain module, expose it through the relevant
public API and test at `MessageStore` boundary. Keep SQL/mapping close to its
owner and preserve transaction ownership.
