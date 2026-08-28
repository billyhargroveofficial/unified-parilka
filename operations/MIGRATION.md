# Migration и rollback runbook

Статус: snapshot/import rehearsal и controlled live cutover пройдены
2026-07-30. Новые bot/sync/timer units работают, legacy Parilka units
disabled/inactive, отдельный общий Telegram MCP на `127.0.0.1:8765` не
изменён. Один маркированный Telegram E2E подтверждён. Фактический post-live
rollback не выполнялся; сохранённый rollback bundle и точное evidence
зафиксированы в
[deployment record](../loop-develop/history/001-unified-parilka/001-evidence/deployment-2026-07-30.md).

## Текущее production disposition

Ниже — состояние после rollout 2026-08-07. Production DB мигрирована с v21
на v22 с audit-таблицей `bot_chat_dream_audits`. Новая migration или deploy
этим runbook не авторизуются и требуют отдельного operator decision.
В v19 удалён retired `bot_callback_intents`: это isolated state бывших inline
кнопок, не часть истории сообщений, памяти или outbox.

- canonical state:
  `/home/billy/.telegram-parilka-mcp/messages-v13.sqlite`, schema v22,
  mode `0600`;
- auth state:
  `/home/billy/.telegram-parilka-mcp/mtcute-auth.sqlite`, mode `0600`;
- active owners: `parilka-sync.service`, `parilka-bot.service`;
- scheduled job: `parilka-maintain.timer`;
- Parilka MCP: stdio proxy к `http://127.0.0.1:8766/mcp`;
- общий машинный `telegram-mcp.service`: отдельный owner на
  `http://127.0.0.1:8765/mcp`;
- MCP send policy: `TELEGRAM_SEND_ENABLED=false`,
  `TELEGRAM_DRY_RUN_DEFAULT=true`.

Имя canonical файла осталось историческим; additive v16 migration с
chat-scoped fast/long memory и skills применена на startup 2026-07-31.

### Rollout v22 и DeepSeek — 2026-08-07

- bot и sync были graceful-stopped; активных `bot_turns` не было;
- private backup до миграции:
  `/home/billy/.local/state/parilka-backups/2026-08-07-v21-pre-v22/messages-v13.sqlite`
  (`0700` directory, `0600` file, v21, `quick_check=ok`, 237757 messages,
  SHA-256 `68113d52a5a92b036f4474750411d26a7e3ada8cd18032821ffb9005a587d7e9`);
  отдельный restore из backup также дал v21, `quick_check=ok`, 237757
  messages, 8 Dream days, 12 fast notes, 9 lessons и 1 skill;
- rehearsal и production migration дали v21 → v22, `quick_check=ok`,
  237757 → 237757 messages, 8 → 8 Dream days и одинаковый SHA-256 полного
  data-only dump до/после (`095f010f86da3a205095f46982726d912bb23d32b1c145b589c39bba16efe0bb`);
- второй writable open и read-only open v22 прошли; новая audit-таблица
  стартовала с нулём строк и заполняется только будущими completed Dream days;
- 12 fast notes, уже перенесённых в semantic memory, удалены; revision semantic
  memory стала 12 при прежнем watermark 243445. Устаревший lesson про Qwen
  заменён правилом брать identity из текущего runtime;
- production `turn` и `summary` используют единственный candidate
  `deepseek:deepseek-v4-flash` (DeepSeek V4 Flash 0731), без Qwen/fallback;
- штатные `parilka-sync.service` и `parilka-bot.service` стартовали с
  build preflight, `NRestarts=0`; временных systemd overrides нет.

### MCP cache-only read tools — 2026-08-07

- MCP surface расширен с 13 до 18 инструментов: пять cache-only bot-read
  инструментов (`rag_bm25_search`, `keyword_search`, `read_chat_slice`,
  `day_digest`, `thread_context`) добавлены в фиксированный registry.
  Они используют `TELEGRAM_DEFAULT_CHAT_ID`, не принимают model-controlled
  `chat`, требуют обязательный служебный `source_message_id` и никогда не
  вызывают Telegram.
- `PARILKA_BOT_ID` теперь опционально читается в `AppConfig.telegram.botSenderId`
  (positive Telegram ID, JS safe range; empty/unset → undefined) и передаётся
  в `CanonicalBotReadCache` + `BotReadTools`. Сообщения бота маркируются
  `authorRole=assistant` / `isOwnTurn=true`.
- Trust boundary: raw MCP `source_message_id` — служебное поле только для
  trusted bridge; текущий Hermes model-facing plugin скрывает его и
  подставляет `HERMES_SESSION_MESSAGE_ID`. Кламп к `MAX(message_id)` запрещён
  (в оживлённом чате максимум может быть новее trigger). Операционные
  typed-отказы пяти cache tools возвращаются обычным MCP-ответом с
  `{ok:false, tool, error:{code…}, evidence:[]}` без `isError`; `isError`
  остаётся только для boundary-ошибок (missing/invalid `source_message_id`,
  invalid tool arguments).
- Без изменений схемы БД, миграций, systemd units или прав доступа.

> Historical note: rehearsal goal 001 выполнялся на диапазоне v10 → v13.
> Текущий поддерживаемый диапазон: v11–22 (см. src/maintenance/contracts.ts).

Исходная import rehearsal ниже по-прежнему документирует её зафиксированный
v10 → v13 baseline; актуальный поддерживаемый диапазон — v11–22.

Следующие разделы остаются канонической процедурой для новой migration или
rollback. Они не означают, что текущий production снова находится в shadow.

## Подтверждённая snapshot/import rehearsal

На согласованных SQLite `.backup`-копиях, без изменения production state,
проверен текущий importer:

- source: 2 029 `live_msg`, 266 day digests и 40 rollups;
- canonical target snapshot: 224 630 → 224 636 messages;
- первый apply: 6 inserts, 2 023 overlaps, 294 missing-text fills,
  0 conflicts; второй apply: 0 inserts/fills/conflicts и 0
  message/day/rollup writes;
- schema: v10 → v13 (historical rehearsal goal 001 baseline);
- текущий поддерживаемый migration path: v11 → v22;
- production disposition: v22 развёрнута 2026-08-07;
- после apply: `quick_check=ok`, 266 day digests и 40 rollups;
- legacy outbox report: `drafted=12`, `failed=4`, `sent=158`, `skipped=2`;
  эти rows только подсчитаны и не импортированы.

Это подтверждает snapshot/import и schema migration path. Отдельное deployment
evidence подтверждает состоявшийся live cutover; rehearsal по-прежнему не
доказывает фактический rollback после внешних Telegram sends.

## Что является source of truth

Используйте операторские переменные/пути, а не пути из чужой машины:

- `legacy_mcp_db` — snapshot прежнего Telegram MCP corpus SQLite;
- `legacy_bot_db` — snapshot Python `bot.sqlite`;
- `shadow_db` — отдельный target SQLite для проверки новой версии;
- GramJS StringSession/Bot API/provider tokens — только secret inputs вне Git;
- старые JSONL/NPY embedding artifacts — не source of truth и не импортируются.

Рекомендуемый target для сохранения полного corpus — копия прежнего MCP
SQLite. Python importer добавляет/обновляет `live_msg` и digests; отдельного
автоматического «импорта старого MCP DB» в репозитории нет.

## Инварианты безопасности

1. Пока старый writer работает, читать только согласованный SQLite snapshot,
   никогда не его live main/WAL files по отдельности.
2. До отдельного решения оператора держать
   `PARILKA_BOT_MODE=shadow`,
   `TELEGRAM_SEND_ENABLED=false` и
   `TELEGRAM_DRY_RUN_DEFAULT=true`.
3. Один Bot API token может иметь только один long poller. Shadow mode запрещает
   публикацию, но всё равно вызывает `getUpdates`.
4. После остановки всех других poller этого token оператор должен выставить
   `PARILKA_BOT_EXCLUSIVE_POLLER=true` — ровно в нижнем регистре. Без него
   bot fail closed даже в shadow; `TRUE` не принимается. Это подтверждение,
   а не distributed lock.
5. Одна MTProto session имеет одного штатного owner. Не запускать новый
   `parilka-sync` или `--direct` рядом со старым owner той же session.
6. После остановки прежнего `telegram-parilka-sync` и всех других owners этой
   session вручную выставить `PARILKA_MTPROTO_EXCLUSIVE_OWNER=true` — ровно в
   нижнем регистре. Без guard sync daemon/once fail closed; guard не является
   distributed lock.
7. Секреты не помещать в SQLite, model-router JSON, reports, logs или commits.
8. Любой backup считается рабочим только после отдельного restore и
   `PRAGMA quick_check`.

Встроенного backup/restore в Parilka нет. Snapshot создаётся проверенным
внешним SQLite/volume инструментом оператора.

## 1. Подготовка

До любых изменений state:

```bash
npm ci
npm run check
npm run check:shell
npm run check:architecture
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

`smoke:mtcute-storage` создаёт временный mtcute SQLite, выполняет migrations и
удаляет его. Это обязательный pre-cutover ABI gate после обновления Node на
rolling-release хосте: если `better-sqlite3` был собран под старый Node ABI,
сначала переустановите dependencies (`npm ci`) либо пересоберите одобренный
native package, затем повторите smoke.

Создайте private snapshots обеих legacy DB и сохраните их неизменяемыми на всё
время rehearsal. Не копируйте только `*.sqlite` обычным file copy, если рядом
есть активный WAL; используйте SQLite backup API/CLI либо остановленный writer.

## 2. Dry-run Python state

Importer по умолчанию открывает source read-only, включает `query_only`,
выполняет `quick_check`, проверяет ожидаемые legacy columns и печатает report:

```bash
./bin/parilka-import-python-state \
  --source /path/to/legacy-bot.snapshot.sqlite \
  --target /path/to/parilka-shadow.sqlite \
  --chat-id -1000000000000
```

Dry-run:

- не создаёт и не изменяет target;
- считает `live_msg`, day/rollup/month digests, drafts, events и outbox по
  status;
- вычисляет source content hash нормализованных `live_msg`;
- валидирует digest rows;
- не доказывает равенство target: target schema/count/hash проверяются позже.

В частности, `lost_ack` в Python outbox лишь попадает в `outboxByStatus`.

## 3. Apply только в shadow target

Первый apply выполняйте только на отдельной копии:

```bash
./bin/parilka-import-python-state \
  --source /path/to/legacy-bot.snapshot.sqlite \
  --target /path/to/parilka-shadow.sqlite \
  --chat-id -1000000000000 \
  --apply
```

Фактическое поведение:

- существующий совместимый target schema 1–13 проверяется через
  `quick_check`;
- `MessageStore` мигрирует target до текущей schema v22;
- `live_msg` проходит полный overlap preflight: Python заполняет только
  отсутствующие canonical поля; различающиеся непустые поля fail closed до
  message writes, а `rawJson`/topic/tombstone target сохраняются;
- исключение основано на provenance: `_record_own()` ставил `is_bot=1`
  локальное время уже после `sendMessage`, поэтому его непустая overlap date
  считается `local_send_observation` и не заменяет canonical MTProto date;
  отсутствующая target date заполняется, а date conflict человеческого
  сообщения по-прежнему fail closed;
- day digests и week/month rollups импортируются идемпотентно;
- прежний target digest с тем же ключом выигрывает и не перезаписывается;
- report содержит before/after и content-free inserts/overlaps/fills/conflicts
  counters.

Production wrapper запускает собранный `dist/python-import-cli.js`, поэтому
после checkout/install сначала обязателен `npm run build`. Failure report
всегда содержит `phase` (`inspect`, `validate` или `apply`) и
`targetMayBePartiallyModified`. Значение `true` возможно только после входа в
apply phase: importer идемпотентен, но message batches и digest rows не
объединены в одну глобальную транзакцию. После проверки причины безопасно
повторите тот же apply против того же target.

Не импортируются:

- Python `bot_outbox` любого status, включая `sent`, `sending` и `lost_ack`;
- Python drafts и events;
- старые JSONL/NPY vectors;
- legacy process logs.

Это намеренное fail-closed поведение: Python outbox не переносится ни в live
retry queue, ни в новый audit. Report надо сохранить для ручной сверки
ambiguous/sent rows.

## 4. Проверка target

> Конкретные версии в этом разделе описывают исторический cutover.
> Актуальный поддерживаемый диапазон: `MIN_SUPPORTED_SCHEMA_VERSION` (11) —
> `MAX_SUPPORTED_SCHEMA_VERSION` (22); см. `src/maintenance/contracts.ts`.

Maintenance dry-run поддерживает schema v11–22 и ничего не меняет без
`--apply`:

```bash
./bin/parilka-maintain --db /path/to/parilka-shadow.sqlite
```

Проверьте как минимум:

- `integrity` равно `["ok"]`;
- `candidates.terminalSendOutbox` ожидаем и не включает `queued/sending`;
- target `PRAGMA user_version` равен `22`;
- message count и диапазон ID ожидаемы;
- выборочные сообщения, edits, tombstones, reply/topic metadata;
- FTS search и cache-only MCP tool shapes;
- day/week/month digest counts и выборочные тексты;
- `bot_updates`/`bot_turns` не содержат legacy retry work;
- Python outbox counts из report сохранены для operator review;
- рост DB/WAL и latency укладываются в ожидаемые пределы.

Importer сам не вычисляет target content hash и не сравнивает выборочные
records: эта проверка остаётся обязательным внешним шагом.

## 5. Shadow и production token

Безопасная последовательность:

```text
legacy writers
  └── consistent snapshots
        └── dry-run report
              └── apply into shadow target
                    └── offline/cache comparison
                          └── controlled shadow с отдельным test token
```

Для cache/MCP comparison сначала используйте target без Telegram writers.
Перед стартом нового `parilka-sync` остановите прежний MTProto owner либо
используйте отдельную тестовую session. После проверки эксклюзивности вручную
задайте в private shared env `PARILKA_MTPROTO_EXCLUSIVE_OWNER=true`.
Поставляемый systemd unit намеренно не выставляет это подтверждение сам.

Параллельный shadow разрешён только с отдельным test bot/token. Production
token нельзя запускать в shadow даже после остановки старого poller:
`getUpdates` потребляет live updates, а shadow turn заканчивается без отправки.
Это создаёт невосстановимый handoff gap для упоминания, пришедшего между
shadow-start и live-restart.

Для production token выполните offline composition/config tests и отдельный
`getMe`, затем после quiesce зафиксируйте persisted legacy `kv.offset`.
Перед первым unified start задайте его как `PARILKA_BOT_INITIAL_OFFSET`: новый
poller начнёт ровно с первого ещё не обработанного update, durable-ingest-ит
весь более новый pending batch и только затем подтвердит offset. Убедившись в
эксклюзивности token, вручную задайте в private bot env
`PARILKA_BOT_EXCLUSIVE_POLLER=true`. Не добавляйте это подтверждение как
безусловный `Environment=` в systemd unit.

В shadow сравниваются:

- update ingestion и trigger classification;
- durable reservations, leases и poison/dead-letter behavior;
- generated drafts и publication decisions;
- tool result schema/evidence;
- provider fallback/latency/errors;
- memory, SQLite и journal growth.

Буквальное равенство model text не требуется. Ни один shadow result не должен
отправляться в Telegram.

## 6. Controlled cutover gate

Cutover разрешён только после rehearsal и full gate.

1. Сначала обезвредить процессы, способные самостоятельно воскресить старых
   owners, затем остановить owners:

   ```bash
   systemctl --user disable --now \
     parlang-watchdog.service parlang-maintain.timer
   systemctl --user stop parlang-maintain.service
   systemctl --user disable --now \
     parlang-bot.service telegram-parilka-sync.service
   ```

   `parlang-maintain.service` должен стать inactive; все четыре legacy
   service/timer должны быть inactive и disabled, legacy PID не должны
   существовать. Общий `telegram-mcp.service` и порт `127.0.0.1:8765` не
   останавливать и не перезапускать.

2. После quiesce проверить handoff Python bot state. Cutover запрещён, если
   `bot_outbox` содержит `reserved`, `sending` или `lost_ack`, либо event audit
   показывает начатый turn без terminal event. Сохранить private audit только
   с status/trigger ID/time/sent-ID-presence, без draft/error content.
   Старые `drafted`/definitive `failed` без `sent_msg_id` получают явное
   решение `no replay`: они остаются в rollback snapshot и не превращаются в
   новые отправки вне исходного контекста.

   Проверка незавершённых legacy turns использует фактический
   `kind='turn.start'` и связывает terminal event по `turn_id`:

   ```sql
   WITH starts AS (
     SELECT turn_id
     FROM event
     WHERE kind = 'turn.start' AND turn_id IS NOT NULL
     GROUP BY turn_id
   ),
   terminals AS (
     SELECT turn_id
     FROM event
     WHERE kind IN (
       'turn.sent', 'turn.failed', 'turn.skip',
       'turn.lost_ack', 'turn.dead_letter'
     )
       AND turn_id IS NOT NULL
     GROUP BY turn_id
   )
   SELECT count(*) AS unterminated
   FROM starts
   LEFT JOIN terminals USING (turn_id)
   WHERE terminals.turn_id IS NULL;
   ```

3. SQLite backup API создаёт private snapshots прежнего MCP corpus и Python
   bot DB. Каждый snapshot отдельно проходит `PRAGMA quick_check`; записываются
   size/SHA-256/schema/count/range. Не копировать live main/WAL по отдельности.

4. Создать **новый final target как SQLite backup самого свежего snapshot
   прежнего MCP corpus**. Не продвигать rehearsal DB. Применить built Python
   importer поверх final target, повторить apply для доказательства
   идемпотентности, затем проверить v22, quick_check и count/range. Inserts,
   fills и все непустые authoritative source sender/text/reply fields должны
   совпасть точно; более полное canonical target enrichment сохраняется.
   Единственное допустимое date-различие — documented
   `local_send_observation` у overlap с `is_bot=1`: его target date должна
   остаться равной pre-import canonical MTProto date, а fatal conflicts —
   равны нулю. Для человеческих сообщений date сравнивается точно.

5. Запустить maintenance apply, затем второй dry-run с нулевыми candidates.
   Digest сначала только dry-run: он не вызывает provider и показывает весь
   backlog. Первый bounded apply выполняется отдельно либо следующим timer run.

6. После остановки всех owners прежней MTProto session выставить ровно
   `PARILKA_MTPROTO_EXCLUSIVE_OWNER=true`, установить units и запустить
   `parilka-sync`. Проверить active state, `127.0.0.1:8766`, status через
   `bin/telegram-parilka-mcp --status` и 13-tool stdio smoke. MCP writes
   остаются выключены и hard dry-run включён.

7. Повторно проверить отсутствие legacy poller и записать persisted legacy
   `kv.offset` как `PARILKA_BOT_INITIAL_OFFSET`. Выставить ровно
   `PARILKA_BOT_EXCLUSIVE_POLLER=true` и `PARILKA_BOT_MODE=live`; production
   bot запускается один раз уже live. Не запускать same-token shadow.

8. Только после active/healthy bot включить `parilka-maintain.timer`.

9. Добавить в оба канонических rulesync sources отдельный target:

   ```json
   "telegram-parilka": {
     "description": "Unified Parilka read-only stdio proxy to loopback owner",
     "type": "stdio",
     "command": "/home/billy/repos/parilka-unified/bin/telegram-parilka-mcp"
   }
   ```

   Общий `telegram` на `http://127.0.0.1:8765/mcp` остаётся без изменений.
   Применение выполняется только так:

   ```bash
   mcp-sync --dry-run
   mcp-sync
   mcp-sync --check
   ```

10. Один маркированный live Telegram mention должен получить ответ. Сверить
    message/reply IDs, correlated journal events и terminal SQLite turn,
    не записывая message/model text или secrets в evidence.

## Maintenance после gate

Сначала сохраните dry-run maintenance report и отдельный digest plan. Digest
dry-run требует уже мигрированную schema v22, но не вызывает модель. Если shell
содержит production DB/allowlist env, снимите их для snapshot-команды:

```bash
./bin/parilka-maintain --db /path/to/final-state.sqlite
env -u TELEGRAM_DB_PATH \
  -u PARILKA_BOT_DB_PATH \
  -u TELEGRAM_ALLOWED_CHAT_IDS \
  ./bin/parilka-digests \
    --db /path/to/final-state.sqlite \
    --chat -1000000000000
```

План показывает day rows с отсутствующим/изменившимся source hash или прежней
prompt version. Точные weekly calls, зависящие от ещё не созданных day
summaries, становятся известны во время apply. После legacy import первый apply
может пересобрать старые day и weekly rows. Dry-run всегда показывает весь
backlog. Apply обрабатывает его newest-first и по умолчанию ограничен тремя day
и одной week generation; остаток отмечается `deferred/run_limit`, не удаляя
существующие legacy summaries. Оцените число calls и выполните первый прогон
вручную, а не неожиданно через timer.

Только затем разрешается ручной apply или timer:

```bash
./bin/parilka-maintain --db /path/to/final-state.sqlite --apply
./bin/parilka-digests \
  --db /path/to/final-state.sqlite \
  --chat -1000000000000 \
  --model-config /absolute/path/to/model-router.json \
  --apply
systemctl --user enable --now parilka-maintain.timer
```

Maintenance apply:

- помечает stale running history jobs как failed;
- удаляет bounded old terminal history jobs;
- удаляет old terminal bot turns/updates только для
  `sent/skipped/dead_letter`;
- удаляет `send_outbox` только для `sent/failed/expired`, если row старше
  `--send-outbox-days` и одновременно не входит в newest
  `--keep-send-outbox-rows`; defaults — 30 дней и 1 000 rows;
- выполняет `PRAGMA optimize` и passive WAL checkpoint.

`queued`/`sending` outbox rows maintenance не удаляет. Terminal outbox хранит
dedupe history: defaults гарантируют окно не короче 30 дней и сохранение как
минимум 1 000 последних terminal sends. После pruning старый `dedupe_key`
можно снова зарезервировать, поэтому увеличьте age/keep-last до максимального
реального retry window клиентов. В WAL report сверяйте normalized
`busy/log/checkpointed`, `remainingFrames` и
`approximateRemainingBytes`; ненулевой остаток сопровождается warning.

Каждый deferred job/batch имеет отдельную транзакцию. При failed unit JSON в
journald показывает `phase`, `completedPhases`,
`retentionMayBeCommitted`/`deferredMaintenanceMayBeCommitted`, но намеренно не
содержит exception message, DB path и record contents. Перед повтором
проверьте completed phases: повторный запуск resumable и идемпотентный, но
предыдущие commits не откатываются.

Сам `parilka-maintain` не генерирует digests/embeddings и не создаёт backup.
Поставляемый oneshot после него запускает `parilka-digests --apply`: day и
ISO-weekly summaries через router role `summary`, с текущим Moscow day
пропущенным по умолчанию. Для timer должны быть доступны chat/DB/model config и
provider credentials из EnvironmentFile; standalone digest CLI `.env` не
загружает. Digest lock живёт рядом с canonical DB: ручной CLI и unit используют
один device/inode-derived namespace, а `ReadWritePaths` уже разрешает запись в
private state directory. Timer добавляет `--summary-only`, чтобы journald
получал bounded summary вместо полного backlog. Каждый timer run читает
`PARILKA_DIGEST_MAX_DAY_GENERATIONS_PER_RUN` и
`PARILKA_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN` из тех же EnvironmentFile
(defaults 3/1, верхние границы 31/8), поэтому большой legacy backlog
разбирается несколькими oneshot-запусками. Проверяйте `options`,
`providerCalls` и `deferred` в journald JSON. Candidate timeout не должен
превышать total model timeout. Ошибка
digest оставляет уже выполненный retention, но помечает unit failed. Month
generation и backup в service не реализованы. Unit разрешает запись только в
`%h/.telegram-parilka-mcp`; для другого final path требуется изменить
`ReadWritePaths` в установленной копии.

## Rollback

1. `disable --now` для нового timer, bot и sync; убедиться, что maintenance и
   direct recovery process завершены.
2. После graceful stop дождаться `sync.shutdown_completed`, затем проверить
   inactive state и `MainPID=0`; сам по себе `TimeoutStopSec` не доказывает,
   что SQLite owner завершён. Только после этого сохранить private v22
   snapshot и journald interval.
   Проверить **все** `bot_turns`/`bot_updates` statuses:
   `queued`, `running`, `drafted`, `sending`, `sent`, `lost_ack`, `failed`,
   `skipped`, `dead_letter`. Telegram offset уже мог быть подтверждён новой
   версией, поэтому ни один незавершённый turn нельзя ожидать повторно от
   legacy poller. Для каждого non-terminal/ambiguous row требуется явная
   disposition; автоматического replay нет.
3. Если новая версия успела работать в live, сверить `sent`, `sending` и
   `lost_ack` с Telegram до любого повторного действия. SQLite restore не
   отменяет внешнюю отправку.
4. Удалить только отдельную canonical `telegram-parilka` rulesync entry из
   обоих source files и выполнить `mcp-sync --dry-run`, `mcp-sync`,
   `mcp-sync --check`. Общий `telegram`/`:8765` не менять и service не
   перезапускать.
5. Очистить оба operator acknowledgement в env новых services: после возврата
   legacy owner `PARILKA_BOT_EXCLUSIVE_POLLER=true` и
   `PARILKA_MTPROTO_EXCLUSIVE_OWNER=true` больше не соответствуют реальности.
6. Вернуть legacy services в порядке MTProto sync → bot → watchdog → timer:

   ```bash
   systemctl --user enable --now telegram-parilka-sync.service
   systemctl --user enable --now parlang-bot.service
   systemctl --user enable --now parlang-watchdog.service
   systemctl --user enable --now parlang-maintain.timer
   ```

   Старые DB/session paths не заменять: они сохранены и не мутировались новым
   runtime. Не делать обратный автоматический импорт новых turns/outbox в
   legacy retry queue.
7. Проверить ровно одного Bot API poller, одного владельца Parilka MTProto
   session, active `telegram-mcp.service` и правильные порты.

Rollback DB нельзя считать чисто обратимой после live sends: Telegram — внешняя
система, и SQLite restore не отменяет уже доставленные сообщения.

## Нереализованные части migration

- Python outbox/draft/event live migration;
- автоматическая reconciliation Python `lost_ack`;
- импорт старых vector artifacts;
- atomic vector staging/activation;
- параллельный shadow на том же Bot API token или MTProto session;
- автоматический replay незавершённых turns между реализациями.
