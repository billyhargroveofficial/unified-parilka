# Digest CLI

The production command is compiled to `dist/digest-cli.js`.
`scripts/generate-digests.ts` is a thin development and spawn-test wrapper.

- `options.ts` owns strict CLI/env parsing, chat allowlist checks, canonical
  SQLite identity, and bounded model/input settings.
- `run.ts` owns read-only preflight, apply lock lifecycle, store/model
  composition, report output, and safe top-level errors.

The CLI loads no dotenv file. Apply requires an explicit model-router config
and provider variables in the process environment. Dry-run opens the unified
database read-only, never calls a model, and always reports the complete
backlog.

Scheduled apply defaults to three day generations and one week generation per
run. Environment owners are
`PARILKA_DIGEST_MAX_DAY_GENERATIONS_PER_RUN` and
`PARILKA_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN`; the explicit CLI overrides are
`--max-day-generations-per-run` and `--max-week-generations-per-run`.
Accepted ranges are 0–31 and 0–8. Apply processes due candidates newest-first;
deferred legacy rows remain intact for a later run. The JSON report exposes
the selected limits in `options` and per-phase `providerCalls`/`deferred`
counters.

`--summary-only` keeps the same exit status and counters but emits one compact
JSON line without the full `items` backlog. It retains bounded failed-period
codes and generated period IDs. The systemd timer uses this mode so daily
backlog does not flood journald; manual dry-run keeps the detailed report.

Dream consolidation runs as a day job inside the same apply pass. On a chat's
first encounter the planner bootstraps exactly the seven completed Moscow
calendar days ending yesterday and processes them oldest-first; later runs add
missing days up to yesterday and retry `failed`/`running` days, never
reopening history before the bootstrap floor. A day's input is only real
bot-reply interactions plus their neighboring context; empty days complete
without a model call. Knowledge and semantic-memory writes stay in an isolated
in-memory day stage during model work, and a fully successful day commits
knowledge + semantic memory + day row in one short atomic transaction. Any
day failure discards the whole stage (fail-closed): persisted knowledge,
memory block and watermark stay unchanged.

`--dream-only` skips day/week generation and runs only the Dream pass.
`--bot-id` (or `PARILKA_BOT_ID`) is required whenever apply with a model
config runs Dream, because the consolidator needs the application bot sender
id to recognize bot replies; dry-run digest does not need it. Dream shares the
`PARILKA_DIGEST_MODEL_TOTAL_TIMEOUT_MS` and
`PARILKA_DIGEST_MODEL_CANDIDATE_TIMEOUT_MS` env deadlines with day/week
summaries; when they are unset each phase falls back to its own internal
default (digest summaries 120 s total / 45 s per candidate, Dream 300 s /
60 s). The Dream review output budget is 8192 tokens while day/week summaries
hard-code 2048. A `dream.status = "failed"` makes apply exit nonzero even
when day/week phases have no failures. A candidate timeout gets one bounded
retry of that same configured candidate before the existing fail-closed
result; it does not introduce another provider.

The apply lock SQLite lives beside the canonical application DB, inside its
already private state directory. The filename derives from DB device/inode, so
manual CLI and systemd share one lock namespace regardless of
`XDG_RUNTIME_DIR`. The CLI fails closed before even a read-only preflight when
the application DB has more than one hardlink, preventing aliases in different
directories from splitting that namespace or observing a different WAL name.
