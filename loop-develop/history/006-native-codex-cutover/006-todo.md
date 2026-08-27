# Goal 006: Codex headless вместо Hermes для Parilka

## Goal

Полностью заменить Hermes в production-пути Parilka на изолированный нативный
Codex headless runtime, вернуть собственный durable Bot API owner, сохранить
cache/MCP/SQLite контракты и подтвердить рабочий deploy живым E2E.

## Permissions

- Пользователь явно разрешил реализацию и production deploy этой миграции.
- Разрешение относится к Parilka profile/gateway и repo-owned Hermes
  интеграции; общие Hermes profiles `default`, `mother`, `wife` и Dashboard не
  входят в scope, потому что у них есть отдельные пользователи.
- Commit, push, rollback и произвольные live Telegram sends не разрешены.
  Разрешён только минимальный маркированный E2E через штатный trigger после
  безопасного cutover.
- Секреты нельзя читать в вывод, логировать или добавлять в Git.

## Source Research Summary

- Decision question: как заменить Hermes без потери Bot API ownership,
  durability и causal tool boundary.
- Локальное evidence: `HEAD=ea20d75` уже содержит Hermes cutover; dirty tree
  удаляет старый `parilka-bot`, но SQLite v22 всё ещё хранит `bot_updates` и
  `bot_turns`. Локальный Codex доступен как `codex-cli 0.150.0`.
- Official OpenAI docs: [Codex App Server](https://learn.chatgpt.com/docs/app-server)
  предназначен для глубокой product integration, поддерживает JSONL stdio,
  обязательный initialize/initialized handshake, thread/turn lifecycle,
  streamed events и host callbacks; для обычных jobs/CI документация
  рекомендует SDK. Локально сгенерированный протокол pinned 0.150.0 содержит
  нужные dynamic host tools.
- Goal: private stdio app-server child, persistent per-chat Codex thread,
  trusted dynamic tools и application-owned Telegram delivery fences.
- Non-goals: общий публичный Codex daemon; выдача модели shell/filesystem;
  удаление других Hermes profiles; новая queue/vector/state платформа.
- Status quo непригоден: production poller/replies принадлежат Hermes, а
  прямой `telegram-parilka-mcp` не является Bot API gateway.
- Минимальное coherent изменение: вернуть собственный Bot API runtime и
  заменить только agent boundary на Codex, сохранив sync/store/read tools.
- Реальная альтернатива — `codex exec --json` на каждый turn. Она проще, но не
  даёт trusted dynamic tool callback и полноценный streamed lifecycle.
- Recommendation: private app-server stdio с version/protocol preflight,
  отключёнными built-in capabilities и пятью host-managed cache tools.
  Confidence: high для архитектуры и supported stdio transport; version drift
  закрывается pin/preflight, generated schema, fake protocol tests и
  fail-closed startup. Experimental WebSocket transport не используется.

## Product Shape

```text
Telegram Bot API -> parilka-bot -> SQLite bot_updates/bot_turns/outbox
                           |                   |
                           v                   v
                 private codex app-server   Telegram publisher
                           |
                    trusted dynamic tools
                           |
                 SQLite cache with cutoff < trigger

MTProto -> parilka-sync -> loopback MCP       (ownership без изменений)
```

Codex запускается с отдельным owner-only `CODEX_HOME`, пустым cwd,
`approval=never`, read-only sandbox и без shell/file/computer/delegation
capabilities. Telegram token и provider/digest secrets не наследуются child
process. Модель не получает `chat_id` и `source_message_id`; host подставляет
их из durable turn.

## Implementation Checklist

1. Вернуть storage API для существующих durable bot tables и добавить
   versioned per-chat Codex thread mapping.
2. Реализовать pinned app-server stdio client: initialize, thread start/resume,
   turn start/cancel, event collection, timeout и fail-closed requests.
3. Реализовать trusted dynamic bridge для пяти cache-only tools с causal
   cutoff и bounded envelopes.
4. Вернуть Bot API polling/ingest/worker/publisher lifecycle и подключить
   `CodexBotTurnAgent` вместо provider/Hermes model loop.
5. Добавить config/env inspection, owner-only Codex state bootstrap, wrapper и
   hardened `parilka-bot.service`.
6. Перевести digest/Dream summary path с Hermes на отдельный безопасный Codex
   adapter либо явно проверенный независимый provider path.
7. Удалить repo-owned Hermes profile/plugin/projection/patch/model-switch,
   Hermes tests/scripts/env keys и active non-historical docs/config
   references. Historical evidence и scoped cutover/rollback guard допустимы.
8. Пройти focused tests, temp-DB migration/idempotence, `npm run verify` и
   secret scan.
9. В production остановить только `hermes-gateway-parilka`, запустить ровно
   одного нового poller, проверить journal/state и один маркированный E2E.
10. Зафиксировать evidence и только после подтверждения закрыть goal.

## Evidence status (completed 2026-08-27)

- [x] Архитектурное решение и canonical docs переписаны под `parilka-sync` +
  `parilka-bot`, private pinned Codex app-server stdio, v23 thread mapping,
  trusted five-tool boundary и Parilka-only cutover/rollback.
- [x] Код, config/env и systemd slice прошли integration/security review:
  native Bot API owner, no-follow lifetime `flock` на проверенном inode,
  bounded/validated auth и model draft, revision-CAS thread binding,
  persisted draft retry, same-tick JSON-RPC context binding, fail-closed Codex
  capabilities и child-env isolation. Bot и maintain имеют отдельные minimal
  env slices, unit-owned paths/credential нельзя перекрыть `EnvironmentFile`;
  standalone + `ExecStartPre` no-model probes используют production schema.
  Digest/Dream Codex-only; repo-owned Hermes/model-router/AI SDK coupling
  удалена.
- [x] Full normal-host gates зелёные до и после live cutover. Последний
  `npm run verify` завершился exit 0: 661/661 Node tests, 48/48 Python
  service-contract tests, type/shell/architecture/systemd/build, retrieval
  recall@5 `0.944`, secret scan 577 files, mtcute/MCP smokes и audit с
  `0 vulnerabilities`. Architecture gate проверил 223 production и 115 test
  files; `git diff --check` зелёный. Real Codex 0.150 preflight прошёл exact
  wrapper → `/proc/self/fd/3` lock → auth bootstrap → strict app-server path.
- [x] Temp-copy production SQLite rehearsal: schema v22→v23, повторное открытие
  идемпотентно, `PRAGMA quick_check=ok`; counts и content hashes существующих
  tables сохранены, добавлена только `bot_codex_sessions`. Перед cutover создан
  online SQLite backup (382,496,768 bytes), restore/quick-check успешны,
  SHA-256
  `64b913ac11ddf3293006f8b556e5199f4137c784191215a9c79a2ae4289e5785`.
- [x] На normal host установлены и byte-for-byte сверены repo units для bot,
  standalone preflight, maintain/timer и sync. Два private env slice — regular
  owner files mode `0600`; bot/maintain inputs разнесены, unit-owned Codex и
  MTProto keys отсутствуют. Shared env атомарно сокращён до sync/MCP + shared
  identity keys с owner-only backup. Timer был snapshot/stopped на staging и
  восстановлен с тем же daily service target. Его первый естественный запуск
  завершился `Result=success`: integrity `ok`, warnings `[]`, 3 day + 1 week
  digest generated без failures и Dream day completed через
  `gpt-5.6-luna`/Codex app-server без fallback; timer снова
  `active/waiting/enabled` со следующим daily run.
- [x] Standalone preflight прошёл при старом owner. Первый live start обнаружил
  реальное Codex 0.150 создание `CODEX_HOME/tmp/arg0`; allowlist расширен только
  на bounded `tmp`, добавлен symlink regression test, full gate повторён.
  Повторный preflight и startup probe успешны; bot запустился в `live`, один
  worker, `gpt-5.6-luna`, effort `max`, service tier `fast`.
- [x] Controlled single-owner cutover завершён: old Parilka gateway остановлен,
  disabled и после E2E удалён с live systemd/profile paths; новый bot
  `active/running/enabled`, `NRestarts=0`. `parilka-sync` и shared
  `telegram-mcp.service` остались отдельными активными owners; default/mother/
  wife/current Dashboard не перезапускались. Мёртвый wife-only drop-in на
  отсутствующий Parilka helper архивирован, при этом wife PID/invocation не
  изменились.
- [x] Единственный разрешённый live trigger с marker
  `codex-goal-002-e2e-20260827T005335Z-2409be33` дал turn `296`, trigger
  `268028`, reply `268029`, `attempts=1`, terminal `sent`, одну durable Codex
  session и cached reply. Journal содержит `bot.codex.preflight.ok`,
  `bot.runtime.configured`, `bot.poll.started`, `bot.turn.sent`; fatal/unhandled
  событий в live invocation нет. Prefix `goal-002` — уже записанный immutable
  runtime identifier; при архивной перенумерации goal он не переименовывается.
- [x] Финальный operational health gate нашёл pre-existing cache-only MTProto
  состояние из-за revoked auth key. После owner-only backup штатный mtcute
  StringSession import восстановил auth. Оставшийся legacy cadence 5 секунд
  давал воспроизводимый цикл success → rate-limit; override возвращён к
  штатным 60 секундам с одним controlled restart и owner-only backup прежнего
  значения. Несколько последовательных ticks затем прошли чисто: health `ok`,
  issues `[]`, `consecutiveFailures=0`. Enabled local BGE-M3 также восстановлен:
  loopback `:8767`, health `ok`, contract `bge-m3-v1`; normal
  `embeddings.tick_completed` и актуальное покрытие индекса подтверждены.

## Current deployment boundary

Migration live-complete. `parilka-bot` — единственный Parilka Bot API poller;
private Codex остаётся stdio child без listener. SQLite live schema v23 и
`quick_check=ok`; sync/MCP/BGE healthy, а первый естественный maintenance
timer-run успешно завершил Codex digest/Dream и запланировал следующий.
Старый Parilka Hermes unit, profile, disabled legacy dashboard, projection и
model switch
сняты с live paths и сохранены только в owner-only cutover rollback. Другие
Hermes profiles и current Dashboard продолжают прежние invocations.

Repo остаётся dirty и uncommitted: commit/push не были разрешены и не
выполнялись. Historical docs, rollback archive и intentional
`Conflicts=/After=` single-owner guard могут упоминать Hermes, но production
agent/model/digest execution от него не зависит.

## Target Files

- Новый runtime: `src/bot-daemon/**`, `src/bot/codex/**`, минимальные
  Telegram/worker modules, `bin/parilka-bot*`, `systemd/parilka-bot*.service`.
- Storage: `src/storage/{bot-updates,bot-turns,bot-codex-sessions}.ts`, schema,
  facade/types/mappers/validation и focused tests.
- Config/docs/gates: `.env.example`, `config/parilka-*.env.example`,
  `package*.json`, `scripts/`, `README.md`,
  `AGENTS.md`, `llms.txt`, `docs/`, `operations/`, Codex skill runbook.
- Удаляемая coupling: `integrations/hermes/**`, `src/hermes-projection*`,
  Hermes bin/systemd/tests/scripts.
- Не трогать: другие user Hermes profiles/services, общий Telegram MCP `:8765`,
  `parilka-sync` MTProto ownership и unrelated dirty changes.

## Verification Commands

```bash
npm run check
npm run check:shell
npm run check:architecture
npm run check:systemd
node --test --test-concurrency=1 --import tsx tests/codex-*.test.ts tests/bot-*.test.ts
npm run build
npm run verify
```

Дополнительно: fake app-server protocol tests без provider calls; temp SQLite
v22->next migration с `PRAGMA quick_check`, second-run idempotence и
count/hash evidence; normal-host systemd/journal/preflight и controlled live
E2E после exclusive poller cutover.

## Done Means

- В Parilka agent/model/digest execution и package нет production зависимости
  от Hermes; допустимы только scoped cutover/rollback ordering references и
  historical evidence.
- `parilka-bot` самостоятельно poll-ит Bot API, durable-ingest-ит updates,
  возобновляет Codex thread и безопасно публикует reply.
- Codex видит только разрешённые host tools и не может подделать causal cutoff.
- Full gate зелёный; state migration воспроизводима и идемпотентна.
- `hermes-gateway-parilka` отсутствует на live paths, новый unit active;
  другие Hermes profiles сохранили runtime identity, а `parilka-sync` снова
  healthy и остаётся единственным MTProto owner.
- Один маркированный Telegram trigger имеет correlated terminal `sent` turn.

## Final Status

**Verified complete, production live (2026-08-27).** Все десять implementation
slices закрыты; normal-host gates, schema v23, single-owner service state,
marked Telegram E2E, естественный maintenance/Dream run и post-live
operational health подтверждены. Rollback material и pre-cutover DB/auth/env
snapshots сохранены owner-only; live Hermes
Parilka artifacts удалены. Commit/push не выполнялись по границе разрешений.

Остаточные ограничения: рабочее дерево намеренно dirty/uncommitted; rollback
является отдельным operator decision и требует сначала остановить native bot.
Дополнительных Telegram sends после единственного marked E2E не было.

## Copy-Ready Goal Prompt

Goal закрыт и не должен возобновляться как active TODO. Для будущего изменения
создать новый goal, сначала прочитать `AGENTS.md`, `operations/CODEX.md` и этот
historical record; сохранить single-owner, dirty-worktree и no-live-send
границы.
