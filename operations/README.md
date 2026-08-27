# Parilka Operations

Runbooks are separate from architecture. They describe a staged procedure; they
do not authorize service changes, Telegram sends, rollback, commit, push or
deployment by themselves.

## Start here

- [Direct Responses runtime and cutover](RESPONSES.md): credential, preflight,
  staged install, single-owner cutover and rollback.
- [Migration status](MIGRATION.md): what is historical evidence and what still
  needs to be proven for the direct-Responses runtime.
- [Repository overview](../README.md): local build and ownership map.

## Safety summary

- `parilka-sync.service` owns MTProto/MCP; `parilka-bot.service` owns one Bot
  API token/poller; `parilka-maintain.timer` launches bounded maintenance.
  Shared `telegram-mcp.service` is outside this scope.
- The bot is a direct TypeScript Codex-subscription Responses client
  hard-pinned to `gpt-5.6-luna`; Fast is `priority` on the wire and interactive
  reasoning effort is `max`. It uses hosted web in every chat request and six
  local read-only functions. The preflight makes one bounded direct Responses
  admission request with hosted web declared and `tool_choice=none`: no SQLite
  or Telegram polling/send occurs.
- Bot and maintenance load separate `0600` environment slices. They share one
  separate writable owner-only `0600` ChatGPT OAuth state copy whose path is
  fixed by their units, never an env value inside either slice. The bot never
  bootstraps shared MTProto dotenv.
- `Conflicts=hermes-gateway-parilka.service` and ordering in the bot unit are
  retained as migration guards. They prevent overlap; no procedure starts or
  configures Hermes.
- Back up SQLite with the backup API/CLI, restore it and run `quick_check` plus
  count/range/hash evidence. Never copy a live main/WAL pair independently.
- `lost_ack` is a delivery ambiguity for inspection, not a replay queue.

## Logs and inspection

Parilka writes redacted JSON to stderr/journald. Do not copy credentials, raw
Telegram bodies, raw model/tool bodies, URLs from transient tool events or
message content into tickets. A successful offline test or model preflight is
not evidence that a production poller owns the token or that an E2E was sent.
