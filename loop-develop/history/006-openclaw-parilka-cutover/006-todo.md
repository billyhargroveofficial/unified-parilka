# 006 — Перевод Парилка228 с Hermes на OpenClaw

> Явно запрошенный long-lived goal. Production cutover, live Telegram E2E,
> commit и push авторизованы. Не печатать секреты.

## Goal

Парилка228 отвечает в группе `-1003179772905` через OpenClaw + Codex native
hosted web search, а не через Hermes gateway. Trusted cache-read tools,
causal `source_message_id`, mention-only wake, memory/skill write-gate и
Dream-проекция сохраняют прежний security contract. После offline gates
Hermes-poller останавливается, OpenClaw принимает Bot API token, live E2E
через Telegram MCP подтверждает ответ, тестовые сообщения удаляются.

## Source Research Summary

**Decision question:** как убрать Hermes из production-пути Парилки, не ломая
уже работающий OpenClaw (Billy + ЗюзАчка) и не теряя trusted MCP-границу,
ради которой мы чинили Hermes.

### Локальное evidence (2026-08-29)

1. Production agent Парилки — `hermes-gateway-parilka.service` (active).
   Trusted plugin `integrations/hermes/parilka-profile/plugins/parilka_chat/`
   (~1878 строк Python) прячет `chat`/`source_message_id`, инжектит trigger
   id, гейтит memory/skill writes, требует literal `@botusername`, капает
   vision до 6, пишет footer
   `<model> 🧠 · <used>/<max> · <N> tool calls · <elapsed>`.
2. `parilka-bot.service` inactive и `Conflicts=` с Hermes: это отдельная
   попытка direct Codex Responses, не цель этого goal. Не включать.
3. `openclaw-gateway.service` active (`/home/billy/openclaw`, port 18789).
   Агенты `main` и `zyuzachka`, Codex native web search уже
   `tools.web.search.openaiCodex.mode: live`. Binding-паттерн ЗюзАчки:
   отдельный workspace, telegram account, `bindings[]`.
4. `parilka-sync.service` active, loopback MCP `127.0.0.1:8766/mcp`.
   Это остаётся history/MCP owner. Сырой MCP не должен попасть в model
   surface Billy/ЗюзАчки: plugin вызывает loopback сам, без глобального
   `mcp.servers`.
5. `openclaw migrate hermes` импортирует модель/MCP/SOUL, но **не** plugins.
   На уже живом OpenClaw это ещё и затёрло бы Billy/ЗюзАчку. Отклонено.
6. OpenClaw runtime (не Codex app-server) нужен, чтобы hooks/plugin tools
   работали нативно. Текущий gateway уже пинит
   `agentRuntime.id: openclaw` на `openai/gpt-5.6-sol|luna` — это и есть
   «Codex native hosted tools» без Hermes web/codex-native костылей.

### Первичные источники

- OpenClaw agent runtimes, Telegram groups, plugin hooks/tools, Codex
  native web search: локальный checkout `/home/billy/openclaw/docs/`.
- `groupAllowFrom: ["*"]` / per-group `groupPolicy: "open"` +
  `requireMention: true` — любой участник разрешённой группы, только с
  mention.
- Tool factory получает `nativeChannelId` и `requesterSenderId`; trigger
  `messageId` приходит в `message_received` и хранится в run/session state.
- `reply_payload_sending.usageState.contextUsedTokens` — occupancy для footer,
  не агрегат по tool loop.

### Goals

1. Третий OpenClaw-агент `parilka` на существующем gateway, isolated
   workspace/account/binding. Не второй gateway-процесс.
2. Model `openai/gpt-5.6-luna`, runtime `openclaw`, `openaiCodex` live
   web search. Deny exec/file/browser/code/computer/subagents.
3. Trusted plugin `parilka-chat`: пять cache tools без `chat`/
   `source_message_id`; серверная подстановка trigger id; fail-closed вне
   группы/агента; forged extra args отвергаются.
4. Literal `@botusername` mention; reply-only не будит. Vision ≤ 6.
   Footer как у Hermes. Memory/skill writes только с allowlist sender;
   managed `[parilka:managed:*]` / `parilka-managed` неизменяемы моделью.
5. Projection Dream/fast notes/lessons/skills в OpenClaw workspace
   `MEMORY.md` + `skills/parilka-managed/`.
6. Offline tests, затем cutover: stop Hermes poller → OpenClaw владеет
   Bot API token → live E2E → удалить тестовые сообщения.
7. Hermes-код и unit остаются rollback, пока cutover не доказан.

### Non-goals

- `openclaw migrate hermes` по существующему `~/.openclaw`.
- Включать `parilka-bot.service` или менять `parilka-sync`.
- Codex app-server / ACP как runtime этого агента.
- Raw MCP tools в model surface, file/terminal/code, Lightpanda-порт.
- Удаление `integrations/hermes/` в этом goal.
- Commit/push.
- Менять Billy/ЗюзАчка кроме additive parilka entries.

### Status quo

Hermes gateway владеет Bot API token Парилки, ходит в loopback MCP через
Python plugin, web search — Hermes `web/codex-native`. OpenClaw уже умеет
то же самое без этих фиксов, но Парилки там нет.

### Минимальное изменение

Добавить isolated OpenClaw agent + native plugin + projection. Cutover —
смена poller ownership того же token. SQLite/MCP/sync не меняются.

### Реальная альтернатива

1. Dedicated OpenClaw gateway только для Парилки — лишний процесс и второй
   Codex OAuth, при том что isolation уже доказана агентом ЗюзАчки.
2. Довести inactive `parilka-bot` Codex Responses — снова свой harness и
   без native hosted tools, ради которых уходим с Hermes.

Обе отклонены.

### Recommendation / confidence

Третий агент на существующем OpenClaw + trusted TypeScript plugin +
workspace projection. Confidence высокая для isolation/tools; live
mention/reply и footer — production verification после cutover.

## Product Shape

```text
Telegram group -1003179772905
  └─ @mention → OpenClaw telegram account `parilka`
       └─ agent `parilka` (workspace-parilka, runtime openclaw)
            ├─ native: web_search (openaiCodex live), web_fetch,
            │          vision, memory read, STT/TTS
            ├─ plugin parilka-chat:
            │    5 cache tools → loopback MCP 127.0.0.1:8766
            │    inject source_message_id from inbound messageId
            │    write-gate / vision cap / footer / mention gate
            └─ projection: SQLite dream/lessons → MEMORY.md + skills

parilka-sync остаётся MTProto + MCP owner.
hermes-gateway-parilka — rollback, stopped after cutover.
parilka-bot.service не трогать.
```

## Implementation Checklist

### Milestone A — trusted plugin (offline)

1. `integrations/openclaw/parilka-chat/` — core без OpenClaw SDK:
   schemas, session guard, source-message ledger, loopback MCP client,
   dispatch, write-gate, footer, vision, mention.
2. Thin `src/index.ts` с `definePluginEntry` + hooks.
3. Model-facing schemas = BOT_READ_TOOL_DEFINITIONS минус `chat`/
   `source_message_id`; drift test.
4. Dispatch: extra/forged keys → invalid; missing trigger id → reject;
   MCP inner JSON как tool result; generic errors без raw exception.

### Milestone B — agent surface

5. Checked-in workspace templates (`SOUL.md` и границы tools).
6. Config fragment: account `parilka`, binding, one group, mention,
   `groupPolicy: open` только для этой группы, DM allowlist, tool deny
   exec/fs/ui/automation/nodes, allow plugin + web + memory + vision.
7. Не класть token в git; env ref `OPENCLAW_TELEGRAM_BOT_TOKEN_PARILKA`.

### Milestone C — projection и ops

8. `src/openclaw-projection/`: reuse snapshot/render-skills; MEMORY.md
   в корне workspace (не Hermes `memories/`).
9. `bin/parilka-openclaw-project` + systemd oneshot после maintain.
10. `operations/OPENCLAW.md`, routing в `operations/README.md`,
    `llms.txt`, architecture topology.

### Milestone D — verification и cutover

11. Focused tests plugin/projection; `npm run check` на slice; затем
    `npm run verify` перед cutover.
12. `openclaw plugins install --link` + enable; additive config;
    token только в OpenClaw env, не в логах.
13. Stop `hermes-gateway-parilka.service`; restart `openclaw-gateway`;
    один poller на token.
14. E2E через Telegram MCP: mention → ответ с footer → cache/web smoke.
    Удалить свои и bot-сообщения. Не засирать чат.
15. Final Status: production disposition, rollback
    (`start hermes-gateway-parilka` + disable parilka account).

## Target Files

Трогать:

- `loop-develop/current-todo/006-todo.md`
- `integrations/openclaw/`
- `src/openclaw-projection/`, `src/openclaw-projection-cli.ts`
- `bin/parilka-openclaw-project`, `systemd/parilka-openclaw-project.service`
- `tests/openclaw-*.test.ts`, `tsconfig.tests.json`, `package.json` scripts
- `operations/OPENCLAW.md`, `operations/README.md`, `llms.txt`,
  `docs/architecture.md`, `AGENTS.md` только если меняется topology
- `~/.openclaw/` additive agent/account/plugin (не git)

Не трогать:

- `src/bot/` durable worker, `src/sync/`, schema/migrations
- `integrations/hermes/` (rollback)
- Billy/ЗюзАчка workspace и их allowlists кроме additive parilka
- `parilka-bot.service` enablement

## Verification Commands

Focused:

```bash
node --test --import tsx tests/openclaw-*.test.ts tests/hermes-tool-schemas.test.ts
npm run check
systemd-analyze --user verify systemd/parilka-openclaw-project.service
```

Перед cutover: `npm run verify`.

Live E2E (после stop Hermes): Telegram MCP send `@bot` ping в
`-1003179772905`, дождаться ответа, проверить footer/tools, удалить
сообщения.

## Done Means

- OpenClaw агент `parilka` отвечает в группе на literal mention.
- Cache tools не показывают `source_message_id` модели и не текут новее
  trigger.
- Exec/file/browser недоступны. Codex native web search работает.
- Projection пишет managed memory/skills. Hermes poller stopped.
- E2E сообщения удалены. Rollback описан. Commit не сделан.

## Permissions

Авторизовано этим запросом: live send в Парилке для E2E и cleanup;
stop/restart `hermes-gateway-parilka` и `openclaw-gateway` на cutover;
additive OpenClaw config.

Не авторизовано: commit, push, новый git-branch, rollback Hermes после
успешного E2E без новой просьбы, любые секреты в git/логах.

## Copy-Ready Goal Prompt

```
/goal Выполни `loop-develop/current-todo/006-todo.md`.
Работай в `/home/billy/repos/parilka-unified`. Сначала AGENTS.md,
operations/HERMES.md, этот TODO.

Переведи Парилку с hermes-gateway-parilka на существующий OpenClaw
gateway третьим агентом `parilka`. Не запускай `openclaw migrate hermes`.
Не включай parilka-bot.service. Не ломай Billy/ЗюзАчку.

Сделай trusted plugin parilka-chat (TypeScript): 5 cache tools без
chat/source_message_id, inject trigger id, loopback MCP 8766, mention,
vision≤6, footer, write-gate. Projection в workspace MEMORY.md.
Offline tests, verify, cutover, E2E через Telegram MCP, удалить
тестовые сообщения. Секреты не печатать. Commit не делать.
```

---

## Final Status (2026-08-29)

**Сделано:**

1. Trusted plugin `integrations/openclaw/parilka-chat/` (TypeScript): пять
   cache tools без `chat`/`source_message_id`, inject inbound message id,
   loopback MCP, mention gate, vision cap 6, footer, write-gate.
2. Agent `parilka` на существующем `openclaw-gateway.service`: isolated
   workspace `~/.openclaw/workspace-parilka`, telegram account `parilka`,
   binding `telegram:parilka`. Billy/ЗюзАчка не сломаны.
3. Projection `src/openclaw-projection/`: Dream/fast notes/lessons/skills →
   workspace `MEMORY.md` + `skills/parilka-managed/`. Apply на live workspace
   прошёл (`memory ok`, 10 managed entries, 4 skills created, 18 lessons).
4. Offline: focused OpenClaw tests зелёные, `npm run verify` зелёный.
5. Cutover: `hermes-gateway-parilka.service` stopped+disabled.
   OpenClaw poller `@bichiycepenstotri_bot` active. `parilka-sync` active.
6. Live E2E: `@bichiycepenstotri_bot e2e-openclaw-006d` → ответ `ок`
   (msg 269913). Все 8 тестовых сообщений (269906–269913) удалены revoke.

**Host-only (не git):** `~/.openclaw/.env` keys, `openclaw.json` additive
entries, systemd drop-in
`openclaw-gateway.service.d/parilka.conf` (`EnvironmentFile=-%h/.openclaw/.env`).
Без drop-in plugin не видит `PARILKA_*` и не регистрирует tools.

**Рабочая tool policy:** deny-only. Positive allowlist `parilka-chat` /
точных имён на этом OpenClaw 2026.8.1 даёт пустой catalog
(`no registered tools matched`). Deny exec/fs/ui/automation/nodes.

**Commit/push не делались.** Hermes-код остаётся rollback:
`systemctl --user enable --now hermes-gateway-parilka.service` после disable
telegram account `parilka`.

**Остаток:** отдельный live ход с cache/web_search не гонялся после рабочего
ответа `ок`, чтобы не спамить чат. Footer occupancy на success-пути в
истории не виден (на error-пути footer был). `parilka-bot.service` не
включался.
