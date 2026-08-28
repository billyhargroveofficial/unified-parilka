# ADR 0001: объединённый Parilka на TypeScript

- Статус решения: принято
- Состояние реализации: deployed live; Telegram E2E подтверждён
- Дата решения: 2026-07-30

## Контекст

Исторически Bot API bot и Telegram MCP были отдельными проектами с разными
runtime, state и failure modes. Это создавало несколько владельцев Telegram
session, недолговечную обработку bot turns, несогласованные corpus/digest
источники и append-only process logs.

Цель решения — один TypeScript codebase и один versioned application SQLite,
но не один общий процесс.

## Решение

```text
Bot API ──► parilka-bot ───────────────┐
                                       ├──► SQLite WAL v13 ◄── maintain + digests
MTProto ──► parilka-sync ──────────────┘
                 │
                 └── session-scoped loopback MCP
                              ▲
                     thin stdio proxy
```

Штатная установка состоит из двух долгоживущих systemd user services и
maintenance oneshot/timer:

1. `parilka-sync` — единственный владелец MTProto client/session, history sync,
   MCP registry и live MCP send scheduler.
2. `parilka-bot` — Bot API long poller, durable update/turn state machine,
   bounded read-only agent loop и Telegram publisher.
3. `parilka-maintain.service` + `.timer` — сначала `quick_check`, bounded
   history/bot/terminal-outbox retention, `PRAGMA optimize` и passive WAL
   checkpoint, затем
   provider-routed day/ISO-weekly digest generation.

Bot не вызывает свой MCP по HTTP. Он использует отдельную узкую библиотечную
поверхность из четырёх read-only tools поверх того же store.

## MTProto и MCP ownership

Основной transport — `mtcute`. Он использует отдельный private SQLite auth
storage, bounded connect/request retry и ограничение flood wait. GramJS
StringSession может быть импортирована через `@mtcute/convert`; заполненный
mtcute auth store не перезаписывается. Application DB и auth DB не могут быть
одним файлом.

`TELEGRAM_TRANSPORT=gramjs` сохранён как rollback transport, а не как default.

`parilka-sync` поднимает session-scoped Streamable HTTP endpoint поколения
MCP 2025-03-26 только по
адресу `http://127.0.0.1:8766/mcp` (порт может быть локально переопределён).
В используемом v1 transport session нужна не для auth: MCP
`notifications/cancelled` приходит отдельным HTTP POST и только общий protocol
transport может прервать `AbortController` исходного tool call. Request signal
проходит через stdio proxy, tool registry и сериализованный history sync; он
объединяется с daemon shutdown signal.
Отменённый queued writer не запускается, active cancellation прерывает
history request/iterator/pacing/reconciliation. После Telegram send fence
request signal намеренно не управляет dispatch из-за неоднозначности доставки.

Host и Origin ограничены loopback allowlist, GET не обслуживается. `DELETE`
закрывает session; штатный proxy вызывает его при graceful shutdown. Owner
держит не более 32 sessions, а idle session после аварийного исчезновения
клиента удаляется через 30 минут; живой proxy обновляет её десятиминутным ping.
Ошибка ping закрывает stale proxy с ненулевым exit code, после чего harness
создаёт новую session. Поэтому in-memory registry ограничен, долгоживущий idle
stdio client не теряет session, а restart owner не оставляет вечный zombie
proxy.

Реализация остаётся на MCP SDK v1 и рассматривается как legacy-compatible
transport. Спецификация MCP 2026-07-28 убрала protocol sessions и отдельный
HTTP `notifications/cancelled`: каждый request имеет собственный POST/SSE, а
его закрытие является cancellation. Поэтому полная совместимость с этой
ревизией до отдельной миграции на SDK v2 не заявляется. На дату решения v2
выпущен только 2026-07-28, а официальный SDK обещает fixes/security updates
ветке v1 как минимум шесть месяцев. Изолированный loopback boundary позволяет
выполнить эту миграцию отдельно, не смешивая две разные cancellation-модели с
первым data/runtime cutover.

Обычный `telegram-parilka-mcp` — stdio-proxy к этому endpoint и не создаёт
Telegram gateway. Флаг `--direct` создаёт gateway и store только как явный
recovery mode; его разрешено запускать лишь после остановки штатного owner.
Sync daemon/once fail closed без точного operator acknowledgement
`PARILKA_MTPROTO_EXCLUSIVE_OWNER=true`, которое выставляется после остановки
всех других owners той же session. Это подтверждение не заменяет lock.

Эта часть решения уже реализована в
[`sync-daemon.ts`](../../src/sync-daemon.ts),
[`mcp-loopback.ts`](../../src/mcp-loopback.ts) и
[`index.ts`](../../src/index.ts).

## Bot API durability

Bot вручную выполняет long polling через grammY API adapter. До возврата
`ackUpdateId` одна SQLite transaction сохраняет:

- raw update;
- нормализованное сообщение;
- idempotent turn reservation для адресованного сообщения.

Повторная доставка безопасна по `update_id`. Poison update после bounded
attempts становится `dead_letter`.

Bot turn использует состояния:

```text
queued/failed
  └── running (lease + heartbeat)
        ├── drafted ──► sending ──► sent
        ├── skipped
        ├── failed ──► bounded retry/dead_letter
        └── lost_ack (terminal after ambiguous dispatch)
```

Lease восстанавливает crash до `sending`. После перехода в `sending` timeout,
network ambiguity, partial publish или ошибка записи подтверждённой отправки не
ретраятся автоматически и завершаются `lost_ack`.

`PARILKA_BOT_MODE=shadow` строит и сохраняет draft, затем завершает turn
как `skipped` без `sendMessage`. Shadow всё равно потребляет Bot API updates,
поэтому два poller с одним token одновременно не поддерживаются.
Runtime дополнительно требует fail-closed подтверждение
`PARILKA_BOT_EXCLUSIVE_POLLER=true` ровно в нижнем регистре после остановки
всех других poller этого token; это operator acknowledgement, а не lock.

## Agent и provider routing

Model router валидирует JSON при startup и поддерживает:

- adapters `openai` Chat Completions, `anthropic` и официальный `deepseek`;
- ordered candidates в формате `provider:model`;
- обязательные роли `turn` и `summary`;
- API keys и custom headers только через ссылки на env;
- HTTPS endpoints, либо явно разрешённый loopback HTTP;
- fallback для классифицированных provider-local/transport/output ошибок.

Bot runtime вызывает роль `turn`, а отдельный `parilka-digests` job — роль
`summary`. Digest job работает последовательно, dry-run по умолчанию, хранит
source hashes и provider/model attribution, пропускает текущий Moscow day и
инвалидирует weekly rollup при изменении/ошибке required day source. Source
hash повторно проверяется после model call; prompt version является частью
инвалидации. Month digests автоматически не генерируются.

Agent loop не stream-ит сырой model output. Он даёт модели только:

- `rag_bm25_search`;
- `day_digest`;
- `thread_context`;
- `web_search`.

Общий budget — до четырёх разрешённых tool executions и forced final step.
Default total deadline — 120 секунд, model step — 60 секунд, tool — 15 секунд.
Tool data оборачивается как untrusted input; финальный текст проходит
bounded Markdown preflight до durable draft.

Опциональный web search имеет два bot-owned бэкенда: provider-neutral HTTP
JSON boundary и native Vertex Gemini grounding (`googleSearch` через gcloud
ADC, без API-ключа и без rulesync MCP). Выбор — через
`PARILKA_BOT_WEB_SEARCH_PROVIDER`. Отключённый в rulesync `gemini-search` не
является зависимостью Parilka и не должен восстанавливаться этим решением.

### Addendum 2026-07-31: turn deadline and layered memory

Default total deadline бота увеличен до 600 секунд. Отдельного искусственного
model-step deadline больше нет: AI SDK loop останавливается естественно после
финального ответа, а не по числу шагов. Whole-turn `AbortSignal` остаётся
непреодолимой границей; каждый tool call по-прежнему ограничен 15 секундами,
а tool execution budget — четырьмя для обычного и восемью для исследовательского
хода.

### Addendum 2026-08-01: research call ceiling removed

Предыдущее предложение про budget для обычного и исследовательского хода
относится к прежней реализации и заменено. Исследовательский ход больше не
имеет отдельного фиксированного числа tool-вызовов: модель может продолжать
сбор evidence до естественного финала.
Непреодолимыми границами остаются общий deadline хода (600 секунд по умолчанию),
отмена исходного запроса и timeout каждого инструмента (15 секунд по умолчанию).
Обычные и исследовательские ходы одинаково не имеют фиксированного budget по
числу вызовов; модель завершает их естественным финалом либо по этим границам.

### Addendum 2026-08-01: maximum-reasoning finalization

Production `turn` uses the Qwen profile with `reasoningEffort=max`. The turn
output budget is 16,384 tokens so a maximum-reasoning final answer is not cut
off by the former 2,048-token default. The loop removes prior hidden reasoning
parts before the next step, uses a hard safety ceiling of 120 tool executions,
and switches to a tool-free final pass when the serialized context, deadline,
or ceiling requires it. If a provider returns `finishReason=length` without
tool calls, the agent retries one tool-free final pass before surfacing a
failure.

### Addendum 2026-08-01: Qwen context compaction and tool safety ceiling

The previous unbounded-call wording is superseded by a 120-execution safety
ceiling. Before a subsequent tool-capable step, the agent estimates the
serialized context using a conservative three-characters-per-token heuristic.
At roughly 600,000 estimated tokens the selected turn candidate (the same Qwen
model/provider profile) summarizes the bounded head/tail source, while recent
tool results are retained. A roughly 900,000-token guard leaves room below the
provider's advertised million-token window for system instructions, tool
schemas, thinking and the final answer. Up to four compaction passes are
allowed per turn. If compaction fails or the deadline is close, tools are
disabled and the agent must produce a final answer rather than growing context
toward provider limits.

### Addendum 2026-08-03: official Qwen3.8-Max and unbounded turn duration

The 600-second whole-turn deadline and the 120-execution count ceiling are
removed. Bot turns may continue until the model returns a final answer; there
is no fixed model-step or tool-call count ceiling. Each provider step and tool
execution retains its own timeout and cancellation signal, and payload,
projection, context-compaction and publication bounds remain unchanged. The
production `turn` and `summary` roles now use the official `qwen3.8-max` model
instead of the retired `qwen3.8-max-preview` candidate.

### Addendum 2026-08-07: DeepSeek V4 Flash 0731 as the production model target

The Qwen addendums above describe the previous production configuration and
remain as the historical record. The production `turn` and `summary` roles
now use a single DeepSeek candidate `deepseek-v4-flash` (DeepSeek V4 Flash
0731) through the official `https://api.deepseek.com` endpoint with
`thinkingMode=enabled`. The model is text-only with a 1,000,000-token context
window; the Qwen `reasoningEffort` profiles and the Qwen fallback are gone.
Both roles contain exactly this one candidate and no Qwen reference, so
agent answers, day/ISO-weekly digests and Dream consolidation all share the
same DeepSeek profile.

Память и единственный разрешённый stateful model-tool contract определены в
[ADR 0003](0003-layered-chat-memory.md). Они не дают модели доступа к operator
MCP write/sync tools и не меняют durable send semantics.

## Storage

Один SQLite store работает в WAL и мигрируется до schema v13. Он содержит:

- canonical messages, aliases, tombstones, FTS и sync cursors;
- history/daemon status;
- MCP `send_outbox` и throttle state;
- `bot_updates`, leased `bot_turns`, drafts и `lost_ack`;
- embedding chunks/namespaces;
- day/week/month digest cache.

Bot API upsert делает свежий message доступным локальному read layer до
следующего MTProto tick.

MCP send outbox имеет `queued/sending/sent/failed/expired`. `dedupe_key`
необязателен, но позволяет вернуть прежний успешный result и блокирует
повторный dispatch того же payload. Неоднозначный отказ после начала отправки
записывается как unknown delivery и не возвращается в очередь.
Maintenance никогда не удаляет `queued/sending`; terminal rows удаляются
только после age cutoff и вне keep-last. Это одновременно задаёт явное окно
durable deduplication, после которого старый key снова может быть принят.

Python importer переносит `live_msg` и L1/L2 digest data идемпотентно. Legacy
drafts, events и все Python outbox rows, включая `lost_ack`, только считаются в
report и не импортируются в live retry state.

FTS является частью canonical store. Embeddings явно opt-in и используют
OpenAI-compatible endpoint с first-run estimate/confirmation. Provider/model
namespaces изолируют несовместимые vectors, но текущий `rebuild` не является
атомарной staging generation: namespace сначала удаляется, затем заполняется
порциями.

## Write safety

MCP live write по умолчанию заблокирован сочетанием
`TELEGRAM_SEND_ENABLED=false` и `TELEGRAM_DRY_RUN_DEFAULT=true`. Для включённого
live send нужны allowlist и одноразовый payload-bound `approval_id` из preview,
если административный bypass не включён.

`approval_id` не является human approval: тот же MCP caller может его создать
и употребить. Отдельных policy modes `human_confirmed` и
`autonomous_allowlisted` в текущем коде нет.

Bot publication управляется независимо через `PARILKA_BOT_MODE=shadow|live`.

## Observability

Bot, sync и MCP entrypoints используют redacted Pino JSON в stderr. User units
направляют stdout/stderr в journald; tail и retention принадлежат systemd, а
application-owned append-only log-файлы не создаются.

Основные service events включают service/pid/timestamp и доменные поля
turn/update/provider/tool/duration. Prompts, raw tool args, message text,
sessions, tokens и API keys не должны попадать в logs; redaction выполняется
общим observability layer.

Некоторые standalone CLI/fallback diagnostics всё ещё печатают собственный JSON
или короткий stderr, но старого разрыва «MCP/sync entrypoints не используют
общий logger» больше нет.

## Почему TypeScript

Go и `gotd` предлагают сильный MTProto production pattern, но transport — лишь
часть системы. Bot API types, MCP/Zod schemas, AI SDK tool calls, provider
routing и общий store уже находятся в одном TypeScript type graph. Полный
rewrite добавил бы IPC и второй deploy lifecycle без измеренного bottleneck.

Отдельный Go MTProto worker остаётся допустимым будущим вариантом только после
измеренного доказательства: устойчивого backlog, reconnect/update-loss либо
CPU/RSS regression, которые mtcute не устраняет.

## Явно не реализовано этим решением

- фактическое post-live rollback exercise и параллельный shadow на том же
  Bot API token/MTProto session;
- автоматическая генерация month digests и автоматический repair старых
  edit/delete до append-порога;
- встроенные SQLite backup/restore;
- atomic vector staging/activation;
- native Vertex/Gemini как answering model provider (web search через Vertex
  grounding уже реализован как bot-owned опция);
- отдельная human-approval policy;
- перенос Python outbox/drafts/events в новый live state;
- remote MCP bind, OAuth, Redis/BullMQ/Kafka или отдельный vector service.

Операционная последовательность и реальные ограничения импорта описаны в
[migration runbook](../../operations/MIGRATION.md), а состоявшийся cutover —
в [deployment evidence](../../loop-develop/history/001-unified-parilka/001-evidence/deployment-2026-07-30.md).
