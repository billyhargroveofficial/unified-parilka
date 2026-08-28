# Unified Parilka runbook

## Production topology

The checkout on this host is:

```bash
cd /home/billy/repos/parilka-unified
```

There are two long-lived user services and one timer:

- `parilka-sync.service`: sole MTProto/auth owner, history sync, and loopback
  MCP on `127.0.0.1:8766`;
- `parilka-bot.service`: sole Bot API poller and durable turn workers;
- `parilka-maintain.timer`: bounded maintenance followed by digest work.

The shared user service `telegram-mcp.service` on `127.0.0.1:8765` is
independent.
Never stop, replace, or reconfigure it as part of Parilka work.

Legacy `telegram-parilka-sync.service`, `parlang-bot.service`,
`parlang-watchdog.service`, and `parlang-maintain.timer` are rollback-only and
must remain disabled while unified services own production state.

## Read-only health checks

```bash
cd /home/billy/repos/parilka-unified
./bin/telegram-parilka-mcp --status

systemctl --user show \
  parilka-sync.service parilka-bot.service telegram-mcp.service \
  --property=Id,ActiveState,SubState,UnitFileState,MainPID,Result
systemctl --user list-timers parilka-maintain.timer
ss -ltnp '( sport = :8765 or sport = :8766 )'

journalctl --user -u parilka-sync.service -n 100 --no-pager
journalctl --user -u parilka-bot.service -n 100 --no-pager
```

Healthy production has exactly one Parilka listener on loopback `:8766`, the
independent general Telegram MCP on loopback `:8765`, both new services
active, and all four legacy Parilka units inactive. Structured logs must not
contain message bodies, model output, credentials, or raw provider payloads.

## Build and offline verification

Run before installing or restarting code:

```bash
cd /home/billy/repos/parilka-unified
npm ci
npm run check
npm run check:architecture
npm run check:shell
npm run check:systemd
npm run build
npm test
npm run test:coverage
npm run secret-scan
npm run audit
npm run smoke:mcp
npm run smoke:mcp:wrapper
npm run smoke:mcp:direct
npm run smoke:mtcute-storage
git diff --check
```

The MCP smokes use isolated/offline composition and must not send to Telegram.
Production wrappers reject missing or stale `dist` output. Documentation-only
changes do not make the build stale.

For a quick 13-tool JSON-RPC smoke against the normal loopback proxy:

```bash
npm run smoke:mcp:wrapper
```

Do not use `--direct`, `npm run sync-once`, session generation, or a raw
sync daemon against production while `parilka-sync.service` is active. Direct
mode is recovery-only and also requires the exact exclusive-owner guard.

## Controlled restart

A restart is allowed only when the task authorizes deployment and read-only
checks prove there is no second Bot API poller or MTProto owner. Build and
verify first, restart one owner at a time, then inspect state and journal:

```bash
cd /home/billy/repos/parilka-unified
npm run build
npm run check:systemd
npm run smoke:mcp:wrapper

systemctl --user restart parilka-sync.service
systemctl --user is-active parilka-sync.service
./bin/telegram-parilka-mcp --status

systemctl --user restart parilka-bot.service
systemctl --user is-active parilka-bot.service
```

For sync shutdown, require `sync.shutdown_completed`, an inactive old PID,
then a successful new tick. For bot shutdown, require the poll offset
confirmation and no active worker left behind. Do not infer success only from
`systemctl --user restart` exit status.

Unit installation, initial migration, production mode changes, rollback, and
post-live delivery reconciliation are deliberately not duplicated here. Use
the canonical [migration and rollback runbook](../../../operations/MIGRATION.md).

## Configuration and secrets

Production runtime reads private env files owned by the current user:

- `~/.config/telegram-mcp/.env` for shared MTProto settings;
- `~/.config/parilka/parilka.env` for bot/router/runtime settings.

Keep their mode `0600`. Do not print, commit, paste, or copy token, API hash,
session, or provider-key values. The model router stores env variable names,
not credentials.

Normal production invariants:

- `PARILKA_MTPROTO_EXCLUSIVE_OWNER=true` only while unified sync is the sole
  owner;
- `PARILKA_BOT_EXCLUSIVE_POLLER=true` only while unified bot is the sole
  poller;
- operator MCP `TELEGRAM_SEND_ENABLED=false`;
- operator MCP `TELEGRAM_DRY_RUN_DEFAULT=true`;
- allowlist enforcement remains enabled.

For first-time session generation or transport recovery, follow the
repository [README](../../../README.md) only inside an authorized maintenance
window with the production owner stopped. Never overwrite the existing mtcute
auth DB merely to test a session.

## Harness MCP configuration

The normal target is a credentialless stdio proxy:

```toml
[mcp_servers.telegram-parilka]
command = "/home/billy/repos/parilka-unified/bin/telegram-parilka-mcp"
startup_timeout_sec = 30.0
tool_timeout_sec = 600.0
```

On this machine, do not edit generated Codex/Claude/Kimi/OpenCode/Pi/Qwen
configs directly. The canonical target lives under
`~/.config/agents/.rulesync/`; changes use:

```bash
mcp-sync --dry-run
mcp-sync
mcp-sync --check
```

The general `telegram` target and `telegram-mcp.service` on `:8765` remain
unchanged.

## Embeddings

Embeddings are opt-in and disabled in current production. Enabling them adds a
provider privacy/cost surface and requires explicit configuration and a
reviewed estimate:

```bash
npm run embed-once -- --limit-chunks 1000 --estimate-only
npm run embed-once -- --limit-chunks 1000 --confirm-estimate
```

Do not run the confirmed command without authorization. Keyword/history tools
remain available when embeddings are disabled.
