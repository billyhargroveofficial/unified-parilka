# Migration and rollback: direct Codex subscription Responses bot runtime

## Status

The direct TypeScript Codex subscription Responses runtime was deployed on
2026-08-27 after explicit authority, isolated preflight, single-owner cutover
and one marked Telegram E2E. The live bot has no Hermes, Codex CLI,
app-server, Platform API key or model subprocess in its execution path.

The marked turn reached durable `sent` with one rich reply and exercised
trusted image input, forced hosted web search, an official OpenAI citation,
immediate transient progress and terminal cleanup. The active release passed
its immutable provenance check; `parilka-sync`, local BGE-M3 and the restored
maintenance timer remain healthy. The requirements below remain the canonical
procedure for later releases or rollback.

`loop-develop/history/006-native-codex-cutover/` preserves the completed
2026-08-27 Codex-era cutover evidence. It is immutable historical evidence and
did not prove the later direct Responses subscription/tool/UI path. It must not be
rewritten to make this migration look deployed.

## Target state

- direct Codex subscription Responses request in the TypeScript server process;
- hard pin `gpt-5.6-luna` with Fast wire `service_tier: "priority"`;
- hosted web search/open/find supplied in every bot request;
- trusted Telegram image input sent directly to Responses;
- exactly five host read-only history/cache tools;
- causal local BGE-M3 RAG, bounded local fallback and strict trigger cutoff;
- immediate typing, safe transient tool progress and native rich final reply;
- one writable owner-only Codex OAuth state shared by bot and digest, never
  from a checked-in environment file.

## Pre-cutover evidence required

1. Review the final diff and run type, architecture, shell, systemd, build and
   focused/full test gates. `git diff --check` must be clean.
2. Make an approved SQLite backup using the backup API/CLI. Restore it to a
   temporary location; record `PRAGMA quick_check`, schema version, relevant
   counts/ranges or content hashes, then perform a second idempotent open.
3. Seed the owner-owned writable subscription state from `~/.codex/auth.json`
   at `~/.telegram-parilka-mcp/codex-subscription/auth.json` with file mode
   `0600`, then install the two separate `0600` service env slices. Do not
   print, symlink or commit either OAuth state.
4. Stage separate Responses env slices and run `parilka-bot-preflight.service`
   while the previous poller still owns the token. It must prove direct
   Luna/Fast (`priority` wire tier) Responses admission with hosted web declared
   but `tool_choice=none`,
   without opening SQLite or polling/sending Telegram.
5. Keep the live old `parilka-bot.service` unit untouched while the separate
   preflight unit runs. Snapshot its unit/state and private-slice metadata;
   retain the prior owner/profile needed for rollback. Quiesce maintenance only
   immediately before the later unit replacement.

## Cutover boundary

With explicit deployment authority, follow [RESPONSES.md](RESPONSES.md). The
current old owner is also named `parilka-bot.service`, so do not replace or
daemon-reload that unit while it is active. First use only the separate
preflight unit; then stop/confirm exit and release of the old owner lock,
replace the bot/maintenance units, reload systemd and start the replacement.
Do not touch `parilka-sync`, the shared Telegram MCP, shared Codex remote
control or unrelated profiles. The lingering Hermes `Conflicts=` guard must
remain during the transition even though Hermes is not part of the target
runtime.

Evidence after start must show exactly one owner, a successful direct Responses
preflight, schema health and one separately authorised unique marker correlated
to a terminal `sent` turn. A `lost_ack`, model error, typing event or progress
bubble is not sufficient E2E evidence.

## Rollback

Stop `parilka-bot` and confirm that its PID/lock owner has exited before
restoring a reviewed prior **Parilka-only** owner. Preserve database/journal
correlation first. Do not overlap pollers, do not delete the lock file as a
recovery action, and do not blindly replay `sending`/`lost_ack`. Restore the
maintenance timer only to its pre-cutover state after the owner decision.
