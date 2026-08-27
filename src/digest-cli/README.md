# Digest CLI

The compiled production command is `dist/digest-cli.js`; development/tests use
the TypeScript entrypoint. It owns strict option/environment parsing, canonical
SQLite identity, a process lock, dry-run/reporting and composition of the
direct Codex subscription Responses maintenance runner.

Apply needs `PARILKA_DIGEST_CODEX_AUTH_FILE`, an absolute owner-only Codex
subscription OAuth JSON path injected by systemd. Model and logical tier are
hard-pinned to `gpt-5.6-luna` / `fast`; the shared subscription transport sends
the corresponding `priority` wire tier. Dry-run opens the database read-only
and neither reads OAuth state nor constructs a Responses client.

Day/week generation is bounded by `PARILKA_DIGEST_MAX_DAY_GENERATIONS_PER_RUN`
and `PARILKA_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN` (or their CLI overrides).
`--summary-only` emits a compact report for the timer. `--dream-only` skips
summaries; Dream apply requires `PARILKA_BOT_ID` to identify bot replies.

Model failure, invalid structured output or timeout never confirms a digest or
Dream watermark. There is no provider fallback. The lock is derived from the
canonical database identity, so manual and systemd runs cannot overlap through
path aliases.
