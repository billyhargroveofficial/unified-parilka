# OpenClaw agent «Парилка228»

Parilka отвечает в группе `-1003179772905` через существующий host OpenClaw
gateway (`openclaw-gateway.service`), агент `parilka`. Trusted plugin
`integrations/openclaw/parilka-chat/` — model-facing cache tools. Loopback MCP
остаётся у `parilka-sync` на `127.0.0.1:8766/mcp`.

Hermes profile и `hermes-gateway-parilka.service` — только rollback (unit
masked, projection больше не стартует с `parilka-maintain`). `parilka-bot.service`
не включать рядом с OpenClaw: один Bot API token — один poller.

## Runtime contract

- Model: `openai/gpt-5.6-luna`, OpenClaw embedded runtime, Codex native
  hosted `web_search` (`tools.web.search.openaiCodex.mode: live`).
- Cache tools: `rag_bm25_search`, `keyword_search`, `read_chat_slice`,
  `day_digest`, `thread_context`. Plugin прячет `chat`/`source_message_id` и
  подставляет trigger id. Сырой MCP не добавлять в `mcp.servers` gateway.
- Group: literal `@botusername`. Reply без mention не будит агента.
- Deny: exec, file/write/edit/apply_patch, browser, computer, nodes/canvas/
  camera, subagents, `group:sessions`, `bundle-mcp` и чужие MCP
  (`telegram__*`, `telegram-wife__*`). Сырой MCP 8765/8768 Парилке не светить.
- Skills allowlist — только `parilka-managed` (lessons + skill ids). Bundled,
  node-hosted и workspace ЗюзАчки не входят.
- Vision: максимум 6 изображений за ход. Footer как у Hermes.
- Memory/skill writes только с `PARILKA_BOT_MEMORY_WRITE_SENDER_IDS`.
  Managed `[parilka:managed:*]` / `parilka-managed` неизменяемы моделью.

## Workspace and projection

Templates: `integrations/openclaw/parilka-agent/`.
Live workspace: `~/.openclaw/workspace-parilka`.
Не копируйте default OpenClaw `MEMORY.md`: projection пишет Hermes-compatible
`MEMORY.md` в корне workspace и `skills/parilka-managed/`.

Kill switch: `PARILKA_OPENCLAW_PROJECTION_ENABLED=true`.
Unit: `parilka-openclaw-project.service` (Wants от `parilka-maintain`).

```bash
bin/parilka-openclaw-project --apply \
  --workspace "$HOME/.openclaw/workspace-parilka"
```

Gateway process must see `PARILKA_*` in its environment. Host drop-in:

`~/.config/systemd/user/openclaw-gateway.service.d/parilka.conf`

```ini
[Service]
EnvironmentFile=-%h/.openclaw/.env
```

Tool policy is deny-only (no `tools.profile: minimal` allowlist): a positive
allowlist of plugin names does not match registered tools on this OpenClaw
build. Deny exec/file/browser/computer. Bot username: `bichiycepenstotri_bot`.
`verboseDefault: full`, `toolProgressDetail: explain`, Telegram
`streaming.mode: progress` + `toolProgress: true`. Progress draft живёт
во время хода и чистится после финала; в ответе остаётся footer
`<model> 🧠 · used/max · N tool calls · elapsed`.
Chat id с префиксом `telegram:` нормализуется. Cache tools —
`catalogMode: direct-only`.

## Cutover

1. Offline: `npm run test:openclaw && npm run check && npm run verify`.
2. `openclaw plugins install --link integrations/openclaw/parilka-chat --force`
   и enable `parilka-chat` с `hooks.allowConversationAccess: true`.
3. Additive merge `integrations/openclaw/config.fragment.json` в
   `~/.openclaw/openclaw.json`. Token только как env
   `OPENCLAW_TELEGRAM_BOT_TOKEN_PARILKA`. Не печатать значение.
4. `systemctl --user stop hermes-gateway-parilka.service`
   затем restart `openclaw-gateway.service`.
5. Live mention E2E; удалить тестовые сообщения.

Rollback: disable telegram account `parilka` / stop его polling, затем
`systemctl --user unmask hermes-gateway-parilka.service &&
systemctl --user start hermes-gateway-parilka.service`.

## Verification

```bash
npm run test:openclaw
npm run check
systemd-analyze --user verify systemd/parilka-openclaw-project.service
```
