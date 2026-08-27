# Parilka direct Codex subscription Responses runtime

This is the operator runbook for the live Parilka-specific direct Responses
runtime and future releases. It does not operate shared
`codex-remote-control.service`, shared
`telegram-mcp.service` or unrelated agent profiles.
Follow it only with explicit deployment authority.

The first production cutover completed on 2026-08-27. One authorised marked
turn reached durable `sent` with image input, hosted web, official citation,
transient progress cleanup and native rich publication. The same procedure is
still mandatory for later replacements; a worktree or preflight alone never
proves a new release live.

## Runtime contract

`parilka-bot.service` is the sole Bot API poller. The TypeScript process calls
the Codex subscription Responses endpoint directly with hard-pinned
`gpt-5.6-luna`; the Fast product policy is sent as wire
`service_tier: "priority"`, and interactive turns use code-owned
`reasoning.effort: "xhigh"`. No Hermes gateway, SearXNG, Firecrawl or model
subprocess participates.

The subscription SSE currently labels some accepted `priority` completions as
raw `default`. This runbook treats the exact submitted `priority` wire value as
the Fast admission contract and normalizes that one legacy label only when the
request was explicitly `priority`; it is not independent provider billing-tier
telemetry. A response to any other requested tier is never upgraded by the
transport.

The subscription endpoint rejects Platform-only `max_output_tokens` and
`max_tool_calls` request fields. The direct transport omits both from the wire;
the TypeScript host still enforces bounded streamed output, final publication,
same-turn local function count and aggregate function-output budgets.

Every bot request contains hosted `web_search`; hosted search/open-page/
find-in-page occurs in that same server-side Responses request. An explicit
user request to check or use web/search/fetch deterministically requires only
`web_search` on the first leg; ordinary conversation leaves search available
without forcing it. A narrow explicit deep-research request instead activates
a host-controlled budget: the host suppresses an early draft, replays its
provider output plus encrypted reasoning, and requires hosted web again toward
four unique successful calls, with at most four required research legs under
the same turn timeout. Four streamed completed actions trigger an immediate
handoff to a direct tool-free Luna/xhigh synthesis leg, reserving part of the
logical timeout for a final answer instead of allowing an unnecessary fifth
web action to stall the turn. If three strict completed evidence actions are
already available, a slow, failed or redundant fourth attempt is cut off after
a bounded 20-second grace and the finalizer must expose material uncertainty; below three
completed actions the host refuses publication. Hard model/tool timeouts are
terminal and do not replay a second visible attempt.
Production subscription SSE exposes granular action items, so the host can cut
at that boundary. A terminal-only adapter can only report already-completed
extras and must keep their Telegram tool count truthful.
This bound exists in the TypeScript loop
because the provider's `max_tool_calls` field is only a ceiling and the direct
subscription transport does not send Platform-only caps. Generic detailed
questions remain single-pass.
The host accumulates safe lifecycles in one temporary Telegram progress
message and turns valid web citations into final clickable links. Hosted rows
show an explicit `×N`, summing both simultaneous items of the same action and
the native `action.queries` batch cardinality inside one provider item. If
subscription synthesis omits final annotations, completed
web evidence supplies a bounded HTTPS-only fallback footer; opaque internal
citation placeholders never reach Telegram. Search text and URL host/path may be shown value-only, without
argument-key prefixes; URL credentials/query/hash, arbitrary arguments, raw
tool output and model reasoning are never displayed.

Every leg uses `store: false`. Local-function continuations replay the bounded
same-turn input plus normalized output items and `function_call_output` items;
they never use `previous_response_id`. No provider-side response state is
carried between Telegram turns; durable chat context comes from the local
causal RAG packet instead.

The final rich reply has a host-only italic status footer. It reports pinned
Luna/Fast/xhigh effort, actual final-leg input tokens against the 272k Luna context window,
hosted-web plus local tool-call count, whole-run wall-clock duration, and the
weekly subscription window only when `GET /backend-api/wham/usage`
returns it for the same OAuth account. This best-effort request starts in
parallel with preparation/inference, serves a bounded TTL/stale cache, and is
never awaited by final publication. An unavailable result renders as unknown;
it cannot delay or fail a Telegram turn and never enters model input. Do not
replace the stateless causal loop with provider session compaction: no durable
provider conversation id exists, and that would weaken causal cutoffs and make
cache behavior less deterministic. A separately authorised 2026-08-27 direct
subscription compatibility probe accepted the code-owned
`prompt_cache_key: "parilka:responses:v2"` alongside `store: false` and
`tool_choice: "none"`; the bot now sends that non-PII key on every leg. Bump
the version only when its shared instructions/tool contract changes; never
derive it from a chat, user, message, or secret. Two tiny accepted probes each
reported zero cached input tokens because their 23-token prompts were below a
meaningful cacheable prefix, so the field is a routing hint rather than a
promise of a cache hit. Do not add cache TTL fields: they remain unverified on
the subscription endpoint, which has rejected other Platform-only fields.
The optional research instruction is appended after the unchanged ordinary-chat
prefix, and its tool-free finalizer keeps the same key deliberately: the key is
a routing partition, while exact request-prefix matching prevents a divergent
tool tail from being mistaken for an ordinary-chat cache hit.

The model sees one validated Telegram `input_image` when present and exactly
six host functions: `rag_bm25_search`, `keyword_search`, `read_chat_slice`,
`day_digest`, `thread_context`, `load_chat_skill`. They are local/read-only and
receive trusted chat/trigger identity from the host. The skill loader accepts
an exact name only and returns only a same-chat skill from before the trigger.
The model has no shell, terminal,
filesystem, Telegram write/delete, generic MCP or arbitrary tool surface.

Dream remains nightly tokenless maintenance. Its staged review-tool calls do
not enter Telegram's transient progress UI. A successful Dream commit may
atomically enqueue one bounded permanent digest; the Bot owner later sends it
unthreaded. It reports only changed layer counts and bounded skill names or
lesson/note titles, never memory/instruction text, review content or raw tool
data. Lost acknowledgement is terminal and never blindly retried.

The bot starts `typing` immediately after durable lease and before upstream
HTTP, maintains a heartbeat, updates a single transient tool-progress message,
coalesces successful state transitions under a hard snapshot budget, deletes it
before native rich final publication, and preserves the normal draft/send-fence/
`lost_ack` delivery contract. This budget reserves Bot API capacity for the
actual final answer even when a provider emits a pathological progress stream.

## Credential and configuration

Create two distinct **staged Codex** slices from the repository examples under
`umask 077`, review them, then require mode `0600`:

```bash
install -d -m 0700 "$HOME/.config/parilka"
install -m 0600 config/parilka-bot.env.example "$HOME/.config/parilka/parilka-bot-codex.env"
install -m 0600 config/parilka-maintain.env.example "$HOME/.config/parilka/parilka-maintain-codex.env"
```

Populate only their documented identifiers/policy fields. Do **not** overwrite
the currently deployed `parilka-bot.env` or `parilka-maintain.env`: their old
owner can still restart until the exclusive cutover boundary. Do **not** put
OAuth material in either file. Seed one separate writable owner-only state
from the existing Codex login; copy it, never symlink it:

```bash
auth_state_dir="$HOME/.telegram-parilka-mcp/codex-subscription"
install -d -m 0700 "$auth_state_dir"
test -f "$HOME/.codex/auth.json" && test ! -L "$HOME/.codex/auth.json"
install -m 0600 "$HOME/.codex/auth.json" "$auth_state_dir/auth.json"
stat -c '%a %U %n' "$auth_state_dir" "$auth_state_dir/auth.json"
```

Never paste, echo or commit the OAuth state. The source login remains outside
the bot runtime; the copied state is the only mutable auth file used by both
services. It may be refreshed in place by the direct TypeScript transport.

The supplied units use the same final-exec state path:

```ini
PARILKA_BOT_CODEX_AUTH_FILE=%h/.telegram-parilka-mcp/codex-subscription/auth.json
PARILKA_DIGEST_CODEX_AUTH_FILE=%h/.telegram-parilka-mcp/codex-subscription/auth.json
```

The process rejects a symlink, wrong owner/mode or malformed state. Model,
Fast wire tier (`priority`) and reasoning policy are code-owned; only the
reviewed turn timeout may be configured. Keep bot `PARILKA_BOT_MODE=shadow`
and an empty exclusive acknowledgement until the old poller is stopped. Shadow
still consumes `getUpdates`; it is never a parallel test mode.

## Offline verification

From the checkout:

```bash
npm ci
npm run check
npm run check:architecture
npm run check:shell
npm run check:systemd
node --test --import tsx tests/responses-*.test.ts tests/bot-responses-*.test.ts tests/bot-causal-rag-*.test.ts
npm test
# Builds a fresh immutable version and atomically moves responses-current;
# it never mutates dist/ or an already activated Responses release. Activate
# only after every preceding offline test is green.
npm run build:responses-release
git diff --check
```

While the Codex-era owner still uses `dist/`, the aggregate safe gate is
`npm run verify:responses`. It runs the full offline suite, contract tests,
retrieval evaluation, secret scan and source/direct MCP smokes first, then
activates an immutable Responses release only if those gates passed. It
replaces the destructive in-place `npm run build` and legacy `dist/` wrapper
smoke. The ordinary `npm run verify` remains
the whole-repository gate for a maintenance window in which replacing `dist/`
is explicitly intended.

Use fakes only. The successful commands above neither prove subscription access nor
perform Telegram/model activity. Rehearse database migration on an approved
temporary backup: restore it, run `PRAGMA quick_check`, record version and
counts/hashes, then open it again to prove idempotence. Do not copy a live
SQLite main/WAL pair independently.

## Stage only the preflight while the old owner is active

The existing live Codex-era owner is already named `parilka-bot.service`.
Therefore do **not** install, overwrite, daemon-reload for, enable or restart
the replacement `parilka-bot.service` while that owner is active: a crash or
restart could make systemd start the new code under the same name. Snapshot the
current unit/state and private-slice metadata without printing secrets. Before
cutover, create the isolated artifact with `npm run build:responses-release`,
then stage and run only the separate preflight unit. Each build writes a new
read-only `.deploy/responses-releases/<version>/` with a deterministic SHA-256
source provenance manifest and atomically moves the `.deploy/responses-current`
symlink only after compile, entrypoint syntax and post-build provenance checks
succeed. The launcher rechecks the manifest before it executes
`.deploy/responses-current/bot-daemon.js`; the
currently active unit continues to execute its existing `dist/bot-daemon.js`.
The preflight does not own the Bot
API lock, so it can run while the old poller holds it. The bot unit
intentionally retains `Conflicts=`/ordering for
`hermes-gateway-parilka.service`; this is a guard against two pollers, not a
Hermes dependency.

```bash
rollback_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rollback_dir="$HOME/.local/state/parilka-rollbacks/$rollback_stamp"
install -d -m 0700 "$rollback_dir/units" "$rollback_dir/env" "$rollback_dir/state"
for unit in parilka-bot.service parilka-maintain.service parilka-maintain.timer; do
  fragment_path="$(systemctl --user show "$unit" --property=FragmentPath --value)"
  test "$fragment_path" = "$HOME/.config/systemd/user/$unit"
  test -f "$fragment_path" && test ! -L "$fragment_path"
  install -m 0644 "$fragment_path" "$rollback_dir/units/$unit"
  systemctl --user show "$unit" \
    --property=Id,ActiveState,SubState,UnitFileState,MainPID,Result,FragmentPath,DropInPaths \
    > "$rollback_dir/state/$unit.before"
  systemctl --user cat "$unit" > "$rollback_dir/state/$unit.rendered"
done
install -m 0600 "$HOME/.config/parilka/parilka-bot.env" "$rollback_dir/env/parilka-bot.env"
install -m 0600 "$HOME/.config/parilka/parilka-maintain.env" "$rollback_dir/env/parilka-maintain.env"
sha256sum "$rollback_dir"/units/* "$rollback_dir"/env/* > "$rollback_dir/manifest.sha256"
stat -c '%a %U %n' "$rollback_dir" "$rollback_dir"/env/parilka-bot.env
install -d -m 0700 "$HOME/.config/systemd/user"
install -m 0644 systemd/parilka-bot-preflight.service "$HOME/.config/systemd/user/parilka-bot-preflight.service"
systemctl --user daemon-reload
systemd-analyze --user verify "$HOME/.config/systemd/user/parilka-bot-preflight.service"
systemctl --user start parilka-bot-preflight.service
systemctl --user show parilka-bot-preflight.service --property=ActiveState,SubState,Result,ExecMainStatus
```

Require `Result=success` and `ExecMainStatus=0` while the old owner is still
active. The preflight reads the copied subscription state and sends one minimal
direct Responses request pinned to Luna/Fast (`priority` on the wire). The request declares hosted
`web_search` but uses `tool_choice=none`, so it proves hosted-tool admission
without forcing a search/open/fetch. It opens no SQLite DB and calls no
Telegram endpoint. The current `parilka-bot.service` remains untouched and
active at this point.

## Controlled cutover and E2E

Only after explicit authority and green staged evidence:

1. The owner-only rollback bundle above is mandatory and must be retained.
   Snapshot `parilka-maintain.timer`/service state, stop the timer without
   disabling it, and wait for an already-running maintenance oneshot to finish.
   This timer operation is separate from Bot API ownership.
2. Stop and disable the current old `parilka-bot.service`. Require inactive,
   no PID and a released owner lock before replacing its unit file. Do not stop
   sync/shared MCP and do not use a second same-token poller as a probe.

   ```bash
   systemctl --user stop parilka-bot.service
   systemctl --user disable parilka-bot.service
   systemctl --user show parilka-bot.service --property=ActiveState,SubState,MainPID,Result
   flock -n "$HOME/.telegram-parilka-mcp/parilka-bot.lock" -c true
   ```

3. Only now install the reviewed replacement `parilka-bot.service`,
   `parilka-maintain.service` and timer, run `systemctl --user daemon-reload`,
   verify all staged unit syntax, and enable the replacement bot. Keep the
   preflight unit already proven separately.

   ```bash
   install -m 0644 systemd/parilka-bot.service "$HOME/.config/systemd/user/parilka-bot.service"
   install -m 0644 systemd/parilka-maintain.service "$HOME/.config/systemd/user/parilka-maintain.service"
   install -m 0644 systemd/parilka-maintain.timer "$HOME/.config/systemd/user/parilka-maintain.timer"
   systemctl --user daemon-reload
   systemd-analyze --user verify "$HOME/.config/systemd/user/parilka-bot.service" "$HOME/.config/systemd/user/parilka-maintain.service" "$HOME/.config/systemd/user/parilka-maintain.timer"
   systemctl --user enable parilka-bot.service
   ```
4. Set `PARILKA_BOT_MODE=live` and
   `PARILKA_BOT_EXCLUSIVE_POLLER=true` together in the private bot slice, then
   start `parilka-bot.service`. Inspect redacted journal and owner/lock state;
   require exactly one active owner.
5. Send exactly one separately authorised unique marker through the normal Bot
   API route. Correlate trigger, turn, typing/progress cleanup, rich final
   reply/citations as applicable and terminal `sent`. Do not send a second
   message to compensate for ambiguity.
6. Record state/evidence honestly. If the timer was active/enabled before
   staging, restore only that prior state and verify its next natural run.

Do not call this deployment complete if the marker was not explicitly
authorised, the final turn is `lost_ack`, there are two owners, or a direct
Responses preflight/model call failed.

## Rollback

Stop `parilka-bot`, verify its process and lock owner exit, preserve database
and journal evidence, then restore only the owner-only bundle captured before
cutover. Never run both. Do not remove the lock path as a liveness remedy and
do not replay `sending`/`lost_ack` automatically.

For a bundle whose pre-cutover state recorded active/enabled old units, restore
the bundled `units/` and `env/` files to the exact user-unit/private-slice paths,
run `systemctl --user daemon-reload`, restore enablement from each
`state/*.before`, and only then start the prior bot owner. Require the lock to
be free immediately before that start. The bundle contains no printed secrets;
keep its directory `0700`, its env copies `0600`, and retain it until the new
runtime and marked E2E are accepted. Keep shared Codex remote control, shared
Telegram MCP and non-Parilka profiles untouched.
