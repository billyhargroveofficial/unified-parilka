# Unified Parilka runbook

## Current target

The checkout is `/home/billy/repos/parilka-unified`. It has two repo-owned
long-lived user services:

- `parilka-sync.service`: sole MTProto/auth owner, history sync and loopback
  MCP on `127.0.0.1:8766`;
- `parilka-bot.service`: sole Bot API poller, durable turn/publisher owner and
  direct server-side OpenAI Responses caller.

`parilka-maintain.timer` runs bounded maintenance plus digest/Dream. The shared
`telegram-mcp.service` at `127.0.0.1:8765` and shared Codex remote control are
independent and must not be changed during Parilka work.

The bot is hard-pinned to `gpt-5.6-luna` with fast tier. Each bot request has
hosted web search and can use native search/open/find inside the same Responses
request. It has a trusted direct image-input route and five local read-only
history functions only: `rag_bm25_search`, `keyword_search`,
`read_chat_slice`, `day_digest`, `thread_context`. No terminal, filesystem
write/delete, Telegram write or generic host tool is available to the model.

## Ownership and presentation

The launcher takes the configured owner-only `flock` before any Bot API call;
do not delete its lock path as recovery. Bot API ACK follows durable update,
message and turn reservation. A pre-send retry can reuse a saved draft;
post-send ambiguity is `lost_ack`, never a blind resend.

Typing begins immediately after lease and remains heartbeated. Thinking,
hosted web, image validation and valid local reads share one safe transient
progress message, then it is deleted before the native rich final reply. Raw
reasoning, search query/URL and tool body are not presentation data.

## Configuration and health checks

Use distinct `0600` bot/maintenance slices from `config/`. They contain no
model selector, API key or OAuth token. Both direct TypeScript callers use the
owner-only writable ChatGPT/Codex subscription state copy at
`~/.telegram-parilka-mcp/codex-subscription/auth.json`; never print, symlink or
commit it. The bot preflight sends one minimal direct Luna/Fast subscription
response without opening SQLite or polling/sending Telegram.

```bash
cd /home/billy/repos/parilka-unified
./bin/telegram-parilka-mcp --status
systemctl --user show parilka-sync.service parilka-bot.service parilka-maintain.service telegram-mcp.service \
  --property=Id,ActiveState,SubState,UnitFileState,MainPID,Result
systemctl --user list-timers parilka-maintain.timer
journalctl --user -u parilka-sync.service -u parilka-bot.service -n 100 --no-pager
```

Run offline gates before a code handoff:

```bash
npm run check
npm run check:architecture
npm run check:shell
npm run check:systemd
npm run build
npm test
git diff --check
```

The direct runtime is live since the authorised 2026-08-27 cutover. For a new
release follow
[operations/RESPONSES.md](../../../operations/RESPONSES.md). It requires
explicit authority, restore-checked SQLite backup, successful preflight while
the old owner is still active, one-owner cutover and a separately authorised
marked E2E. The `Conflicts=hermes-gateway-parilka.service` unit guard remains
only to prevent overlap with the retired legacy gateway. Historical Codex
cutover evidence is not direct-Responses deployment evidence.
