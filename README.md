# Parilka

Parilka is a single TypeScript runtime for one Telegram group. SQLite is the
durable correctness boundary for history, Bot API updates/turns, cache reads,
digests and Dream state. The chat model is a direct server-side Codex
subscription Responses loop: no Hermes gateway, no model child process and no
dependency on this machine's shared `codex-remote-control.service`.

```text
Telegram Bot API -> parilka-bot -> SQLite WAL v24 <- parilka-sync (MTProto)
                         |                 |
                         v                 +-> 127.0.0.1:8766/mcp
          Codex subscription Responses: gpt-5.6-luna / Fast (priority wire)
             | hosted web_search + six local read tools
             + direct trusted Telegram image input

parilka-maintain + parilka-digests -> SQLite + direct Responses maintenance loop
```

- `parilka-sync` owns the MTProto session, history sync and loopback MCP.
- `parilka-bot` is the only Bot API poller. It durably ingests updates before
  ACK, leases a turn, publishes once, and never lets model state replace its
  delivery state machine.
- `parilka-maintain` runs bounded SQLite maintenance; `parilka-digests`
  produces day/week summaries and nightly Dream work. Maintenance has no Bot
  token: after a successful Dream commit it can only durably queue one public
  digest for the Bot owner to deliver.
- The shared `telegram-mcp.service` on `127.0.0.1:8765` is a separate machine
  service and is out of scope.

## Model and tool contract

The bot hard-pins `gpt-5.6-luna` with Fast policy (`service_tier: "priority"`
on the wire) and `reasoning.effort: "xhigh"`; none of these is an environment selector. Each chat
Responses request includes the
hosted `web_search` tool. Search, fetch and find-in-page actions happen in the
same server-side request. One temporary Telegram message accumulates compact
English rows for the observed tool actions. Hosted rows carry an explicit
`×N`: it counts both multiple provider items of the same action and the
provider's native `action.queries` batch inside one `web_search_call`. Only the
bounded value (query, URL host/path or find pattern) is shown, with no redundant
argument-key prefix;
URL credentials/query/hash, arbitrary arguments and tool output remain hidden.
Citations in the final response are converted to a compact clickable footer;
if a subscription synthesis leg omits annotations, validated HTTPS sources from
its completed web evidence are used as the fallback, and opaque internal citation
placeholders are removed from visible text.
An explicit `deep dive`/`deep research`/`дип-дайв`/`глубокий ресерч` request
enters a bounded host-controlled research loop: early drafts are retained only
inside the same stateless turn, hosted web is required again toward a target of
four successful unique web actions (at most four required legs). As soon as four
streamed actions complete, the host cancels further native web work and gives
their provider output to one direct, tool-free Luna/xhigh synthesis leg; only that
final answer is published. Once three strict completed evidence actions exist, a
fourth action gets a 20-second grace period: if it stalls, fails or only repeats
existing evidence, the host runs the same tool-free synthesis with an explicit
uncertainty instruction. Fewer than three completed evidence actions cannot be
published, and a hard model timeout is terminal instead of replaying progress.
Generic requests for detail remain single-pass.
The live subscription stream exposes each action early enough for that cutoff;
a terminal-only adapter can only account for extra actions already completed
before the provider exposes any action boundary.

The model can receive a validated Telegram image directly as `input_image`
(high detail). It has no shell, terminal, filesystem, Telegram write or delete
tool. The only local functions are read-only and exactly six:

- `rag_bm25_search`
- `keyword_search`
- `read_chat_slice`
- `day_digest`
- `thread_context`
- `load_chat_skill` — loads one exact same-chat skill chosen by its name

The pre-turn causal RAG packet is local: recent/reply context plus bounded
hybrid BGE-M3 retrieval on loopback (`127.0.0.1:8767` by default), optional
local rerank, indexed skill names/descriptions and temporal digests. A full
skill is loaded only through `load_chat_skill`, for the exact same chat and
strictly before the trigger. All history reads enforce `message_id < trigger`,
so a future message cannot leak into a turn. Retrieval degradation falls back
to bounded local context; it does not invent external search.

After a turn is leased the bot sends Telegram `typing` immediately and keeps a
heartbeat. Thinking, hosted web, image processing and the six valid local
tools update one transient progress message. Successful completion transitions
are folded into the next tool-start snapshot, repeated continuation-thinking is
suppressed, and the per-turn snapshot count is hard-bounded so presentation can
never consume Telegram's allowance needed by the final reply. The bubble is
deleted before the final rich message and never becomes chat corpus/digest input.

Dream's internal review reads/writes are not rendered as fake live tool calls:
they are staged and may be rolled back. Once a nightly Dream day commits, it
atomically queues at most one permanent `Dream digest` for the chat. The Bot
owner sends it later; it contains only bounded changed skill names, lesson/note
titles and counts, never skill instructions, memory text, review prompts or
tool payloads.

Every final rich reply ends with one host-rendered italic status line: pinned
Luna/Fast/xhigh effort, the completed leg's actual input-token count against Luna's 272k
context window, hosted-web plus local tool-call count, whole-run duration and
the subscription's weekly allowance when available. The
quota reader uses the same OAuth identity against the Codex usage endpoint in
parallel with the turn; it serves a short TTL/stale cache and never delays,
changes, or enters a model request. When that optional endpoint is unavailable,
the footer explicitly shows an unknown value rather than estimating one.

There is intentionally no provider session compaction in the chat path. Each
turn is `store: false`, has no `previous_response_id`, and rebuilds a bounded
causal RAG packet from SQLite. Same-turn function continuations replay their
bounded transcript. Adding a hidden mutable provider session would both bypass
the causal boundary and make cross-turn prompt-cache behavior less predictable.

## Build

- Node.js `>=22.5`
- npm and `flock` from util-linux
- a local loopback BGE-M3 service only if vector RAG is enabled

```bash
npm ci
npm run check
npm run check:architecture
npm run check:shell
npm run check:systemd
npm run build
npm test
git diff --check
```

For a side-by-side direct Responses deployment rehearsal, use
`npm run build:responses-release`. It builds an immutable ignored version under
`.deploy/responses-releases/` and atomically switches the
`.deploy/responses-current` pointer only after compilation, syntax checks and
a deterministic SHA-256 manifest confirms the release matches the reviewed
runtime source/config/package inputs. The launcher rechecks that manifest
before executing an active Responses release.
It leaves `dist/` and the previously active Responses release intact for the
active owner or rollback. The staged preflight unit runs the current release
without taking the Bot API lock; see [operations/RESPONSES.md](operations/RESPONSES.md).
When an existing owner still runs `dist/`, use `npm run verify:responses` for
the aggregate gate so verification cannot replace its rollback artifact.

Tests use fake Bot API and fake Codex subscription transports; the verification gate does
not send Telegram messages or make model calls.

## Configuration and secrets

[.env.example](.env.example) is only the shared sync/MCP template. Bot and
maintenance have separate owner-only `0600` slices:

- [config/parilka-bot.env.example](config/parilka-bot.env.example) →
  `~/.config/parilka/parilka-bot-codex.env`
- [config/parilka-maintain.env.example](config/parilka-maintain.env.example) →
  `~/.config/parilka/parilka-maintain-codex.env`

Do not put OAuth material in either environment file. Seed the one writable
owner-only shared state at
`~/.telegram-parilka-mcp/codex-subscription/auth.json` from `~/.codex/auth.json`
with mode `0600`; it must be a copy, not a symlink. The final exec seams pass
that exact path as `PARILKA_BOT_CODEX_AUTH_FILE` and
`PARILKA_DIGEST_CODEX_AUTH_FILE`. Bot/maintenance do not load the shared
MTProto dotenv, and maintenance never receives the Bot token.

Before a first cutover keep `PARILKA_BOT_MODE=shadow` and an empty
`PARILKA_BOT_EXCLUSIVE_POLLER`. Even shadow consumes `getUpdates`; do not run
it beside another poller. Set `live` and `true` together only after the old
Parilka-only owner has stopped.

## Deployment and rollback

The direct subscription Responses runtime is live on mujik since 2026-08-27.
Its production acceptance used a standalone Luna/Fast preflight, exactly one
Bot API owner and one authorised marked E2E that exercised image input,
hosted web, an official citation, transient progress cleanup and one rich final
reply. Follow [operations/RESPONSES.md](operations/RESPONSES.md) with explicit
deploy authority for every later replacement; a new worktree or preflight does
not supersede the currently accepted release. Historical Codex cutover material
under `loop-develop/history/006-native-codex-cutover/` remains evidence only for
the retired app-server runtime.

Rollback stops and confirms exit of `parilka-bot` before restoring a reviewed
Parilka-only prior owner. Never overlap pollers and never automatically replay
`sending` or `lost_ack` turns. Hermes guards remain in supplied systemd units
only to prevent an accidental overlapping legacy gateway during controlled
cutover; they do not start or configure Hermes.

## Documents

- [Architecture](docs/architecture.md)
- [ADR index](docs/adr/README.md)
- [Responses operator runbook](operations/RESPONSES.md)
- [Migration and rollback status](operations/MIGRATION.md)
- [Historical Codex cutover](loop-develop/history/006-native-codex-cutover/)
