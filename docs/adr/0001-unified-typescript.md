# ADR 0001: unified TypeScript runtime with direct OpenAI Responses

- Status: accepted
- Implementation status: live on mujik since 2026-08-27 after direct
  subscription preflight and one authorised marked Telegram E2E
- Original decision: 2026-07-30
- Superseding addendum: 2026-08-27

## Context

Parilka needs one canonical SQLite state with two explicit transport owners:
MTProto history/MCP and Bot API replies. Hermes and a private Codex app-server
each added a second runtime lifecycle, state boundary and tool protocol. The
chat path needs a direct TypeScript integration that keeps Telegram delivery,
causal history limits and tool authority in the host.

## Decision

```text
Telegram Bot API -> parilka-bot -> SQLite WAL v24 <- parilka-sync
                         |
                         +-> ChatGPT Codex subscription Responses, direct HTTP/SSE
                             gpt-5.6-luna + Fast (`priority` on wire)
                             hosted web_search + six local read tools
```

1. `parilka-sync` remains the sole MTProto/session and loopback-MCP owner.
2. `parilka-bot` remains the sole Bot API long-poller and durable update/turn
   state-machine owner.
3. The model boundary is a direct TypeScript HTTP/SSE Responses loop using the
   owner-only ChatGPT Codex subscription OAuth state. It starts neither Codex
   CLI nor app-server and has no Platform API-key/SDK transport. Bot code
   hard-pins `gpt-5.6-luna`; logical Fast is `service_tier: "priority"` on the
   subscription wire. No generic provider/model router exists in the chat path.
4. Every bot Responses request carries hosted `web_search`. Search/open/find
   events are streamed to the host and rendered safely in Telegram.
5. Cross-turn continuity is constructed from durable causal local context.
   Every leg uses `store: false`; function continuations replay bounded
   same-turn output items and never use `previous_response_id`. There is no
   durable Codex thread binding.
6. Day/week digests and Dream use the same direct Responses maintenance
   boundary, isolated from the Bot API token.
7. A completed nightly Dream day atomically queues at most one bounded public
   digest; only the Bot owner can send it after commit.

## Safety and delivery invariants

Before Bot API ACK, one SQLite transaction records raw update, normalized
message and idempotent turn reservation. Workers use lease/heartbeat, persist
a non-empty final draft before `sending`, and publish through a send fence.

```text
queued/failed -> running -> drafted -> sending -> sent
                    |          |          `-> lost_ack
                    |          `-> skipped
                    `-> failed -> bounded retry/dead_letter
```

After the send fence a timeout or ambiguous acknowledgement is `lost_ack`, not
an automatic resend. One token has one poller; a lifetime lock and controlled
cutover enforce this independently of model availability.

The model has hosted web capability, trusted image input and exactly six
read-only local functions: `rag_bm25_search`, `keyword_search`,
`read_chat_slice`, `day_digest`, `thread_context`, `load_chat_skill`. The host
supplies chat and causal trigger identity; model arguments cannot read at/after
the trigger. The skill loader accepts only a name and resolves an exact
same-chat skill with a source before the trigger.
There is no terminal, arbitrary filesystem, Telegram write, plugin/MCP or
generic host-tool surface.

## Consequences

- The direct loop removes app-server protocol/version and private-home
  lifecycle from production chat execution.
- One writable owner-only OAuth state copy is shared by bot and maintenance so
  refresh rotation is persisted atomically; env slices cannot choose a model,
  tier or credential value.
- Loopback BGE-M3 and SQLite stay host-side, so chat text does not need an
  external retrieval gateway.
- Dream review-tool activity is never announced as live progress because it is
  staged. A committed one-per-day digest reports only bounded changed
  names/titles/counts and is delivered later by the Bot owner.
- The old Hermes/Codex material stays historical and rollback context only.
  `Conflicts=hermes-gateway-parilka.service` remains a one-owner guard, not a
  dependency or fallback.

## Verification and rollout

Require fake Bot API/Responses tests, type/architecture/shell/systemd checks,
build, temp-DB restore rehearsal and `git diff --check`. A deployment needs
explicit authority, a standalone direct-Responses model-access preflight, an
exclusive-poller cutover and one separately authorised marked E2E.

Those conditions were fulfilled on 2026-08-27. The marked turn exercised a
Telegram image, forced hosted web search, an official OpenAI citation,
transient progress cleanup and one rich final reply. The durable terminal
state is `sent`; the active bot cgroup contains only the TypeScript lock
wrapper and daemon, with no Codex CLI/app-server/model child.
