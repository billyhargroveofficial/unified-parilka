# Parilka Operations

Operator documentation находится вне архитектурного `docs/`.

## Start here

- [Migration and rollback](MIGRATION.md): consistent snapshots, shadow target,
  final target, cutover gates и rollback.
- [OpenClaw Agent](OPENCLAW.md): штатный Telegram agent Парилка228 на
  существующем OpenClaw gateway, trusted plugin, projection, cutover и rollback.
- [Hermes Agent Profile](HERMES.md): rollback-only profile. Live poller
  masked; projection с `parilka-maintain` снят.
- [../README.md](../README.md): local build, config keys, CLI и systemd install.

## Safety summary

- Unified production services сейчас active; legacy Parilka services
  disabled/inactive и остаются только rollback path.
- SQLite state копируется через backup API/CLI, а не отдельным копированием
  main/WAL файлов при живом writer.
- Bot/sync owners не стартуют без exact acknowledgements
  `PARILKA_BOT_EXCLUSIVE_POLLER=true` и
  `PARILKA_MTPROTO_EXCLUSIVE_OWNER=true`.
- Bot находится в live mode; operator MCP writes отдельно остаются выключены
  и в hard dry-run.
- Не запускайте legacy owners или direct recovery рядом с unified services;
  это требует controlled rollback и проверки offset/outbox.
- Backup считается доказанным только после restore, `PRAGMA quick_check` и
  count/range/content-hash verification.

Runbook описывает процедуру, но сам по себе не авторизует новый stop/start,
send, rollback, commit, push или deploy.

## Retrieval: local BGE-M3

Целевой retrieval backend — локальный loopback BGE-M3
(`TELEGRAM_EMBEDDINGS_BACKEND=local_bge_m3`, см. [ADR 0004](../docs/adr/0004-local-bge-m3-retrieval.md)
и [../services/bge-m3/README.md](../services/bge-m3/README.md)): один encode
выдаёт dense 1024 и learned sparse postings, опционально bounded ColBERT
rerank top-K без хранения token vectors. Внешний OpenAI-совместимый dense
provider сохранён только как backward-compatible отключённая опция.

Статус и границы:

- `systemd/parilka-bge-m3.service` поставляется **disabled**; модельные
  артефакты не vendored. Provisioning venv, download модели, backfill
  индексация, enable unit и любой restart сервисов требуют отдельного
  operator approval — этот раздел описывает процедуру, но не авторизует её.
- Migration старых внешних векторов не нужна: в production
  `message_embedding_chunks` пуст (0 строк), новый индекс строится
  backfill'ом через обычный estimate/confirmation gate
  (`npm run embed-once -- --confirm-estimate` после одобрения).
- При недоступном локальном сервисе `rag_bm25_search` честно деградирует до
  BM25 и сообщает статус каналов; `keyword_search` и `read_chat_slice`
  остаются provider-free и работают всегда.
- Schema v21 additive (`message_embedding_sparse_terms`, каскадный
  delete-триггер). Rehearsal миграции обязателен на temp-копии snapshot:
  `PRAGMA quick_check`, count/hash evidence, повторный idempotent open.
- Eval seam: `npm run benchmark:retrieval` — offline fixture-прогон четырёх
  классов запросов (точные имена/цитаты, русская морфология/сленг,
  парафразы, mixed RU/EN) без сети и без production мутаций. Реальные
  quality-цифры снимаются с approved snapshot-копии при включённом
  локальном сервисе, не на live DB.

## Bot memory and dreaming

- `bot_chat_memory` хранит один bounded Dream-блок на чат, watermark
  `last_consolidated_message_id` и `revision`. Он инжектируется в системный
  prompt как недоверенные данные (`## Постоянная память`) с индикатором
  заполнения.
- Schema v16 ввела строго chat-scoped explicit knowledge (оно сохраняется и в
  последующих schema versions):
  `bot_chat_fast_memory` (до 12 оперативных заметок, сразу в prompt),
  `bot_chat_lessons` (до 64 problem/solution/when-to-apply уроков) и
  `bot_chat_skills` (до 32 playbook). Последние два слоя дают только bounded
  index; модель загружает detail через отдельный tool по необходимости.
- Обычный ход может читать memory, но писать её может только адресный trigger,
  который прямо просит запомнить/сохранить/обновить заметку, урок или навык и
  отправлен numeric Telegram account из закрытого operator-configured
  `PARILKA_BOT_MEMORY_WRITE_SENDER_IDS` allowlist в private env. Не записывайте
  этот allowlist в репозиторий, prompt, логи или ответы бота. Каждая запись
  source-attributed к ID этого сообщения,
  ограничена по размеру и отвергает вероятные credentials. Данные памяти не
  являются инструкциями для модели.
- Это ограничение относится к явным model memory writes (fast notes, lessons,
  skills), но не ограничивает memory reads для остальных участников и не
  меняет автоматическую Dream-консолидацию.
- Dream-консолидация запускается существующим `parilka-digests --apply`
  (`parilka-maintain.timer`, 04:20): daily apply job всегда прогоняет Dream
  после digest-фаз. При первом запуске чата Dream bootstrap'ит ровно 7
  завершённых Moscow calendar days (заканчивая вчерашним) и обрабатывает их
  oldest-first; повторные запуски добавляют пропущенные дни до вчерашнего и
  retry'ят `failed`/`running` дни, никогда не переоткрывая историю до
  bootstrap floor.
- Вход дня — только реальные bot-reply interactions плюс соседний контекст
  (8 live сообщений до trigger, все live сообщения от trigger до последнего
  answer chunk, 30 live сообщений после); остальные сообщения дня не читаются.
  `--bot-id`/`PARILKA_BOT_ID` обязателен, когда apply + model config запускает
  Dream; dry-run digest без Dream не требует его.
- При падении модели/невалидном выводе старый блок и watermark сохраняются
  (fail-closed), а digest CLI завершается ненулевым кодом. Dream читает те же
  `PARILKA_DIGEST_MODEL_TOTAL_TIMEOUT_MS` и
  `PARILKA_DIGEST_MODEL_CANDIDATE_TIMEOUT_MS`, что и day/week summaries; без
  них Dream fallback'ит на внутренние defaults 300 s total / 60 s на candidate
  (day/week summaries: 120 s / 45 s). Default бюджета ответа модели — 8192
  output tokens (day/week budget 2048 не меняется), после timeout того же
  candidate предусмотрена одна bounded retry без второго провайдера.
  Повторный прогон без новых сообщений не пишет в `bot_chat_memory`.
- Сбросить только Dream-блок можно через SQL:
  `DELETE FROM bot_chat_memory WHERE chat_id = '<chat_id>';`. Это сбросит
  watermark и бот начнёт с пустой Dream-памяти. Сброс всех explicit layers
  требует отдельно удалить rows того же `chat_id` из
  `bot_chat_fast_memory`, `bot_chat_lessons` и `bot_chat_skills`; делайте это
  только на подтверждённом backup/maintenance workflow, не во время live
  writer.
- Параметры:
  - `PARILKA_MEMORY_MAX_CHARS` — бюджет блока (500–4000, default 2000).
  - `PARILKA_DIGEST_MODEL_TOTAL_TIMEOUT_MS` /
    `PARILKA_DIGEST_MODEL_CANDIDATE_TIMEOUT_MS` — общие model deadlines
    digest/Dream apply прогона.
  - Удалённые `PARILKA_DREAM_EVERY_N_MESSAGES` и `PARILKA_DREAM_MAX_MESSAGES`
    больше не читаются; старые значения в env файлах просто игнорируются.

## MCP trust boundary

Loopback MCP (`127.0.0.1:8766`) защищает от удалённых клиентов (DNS-rebinding
protection, Origin/Host allowlist), но не изолирует процессы того же UID.
`approval_id` для send — self-issued capability: тот же клиент вызывает
`preview_message` и получает token. На однопользовательском хосте это
осознанная граница; для multi-user — добавьте shared secret header. Кроме
trust boundary, loopback имеет defensive admission limits: до 32 sessions,
128 active HTTP requests глобально и 8 active requests на session; превышение
возвращает 503/429 и не запускает tool handler.

Cache-only read tools (`rag_bm25_search`, `keyword_search`,
`read_chat_slice`, `day_digest`, `thread_context`) принимают raw MCP
`source_message_id` как служебное поле исключительно от trusted bridge —
это не model-facing аргумент. OpenClaw plugin `parilka-chat` скрывает
его от модели и подставляет inbound Telegram message id. Не выводите
bound клампом к `MAX(message_id)`: в оживлённом чате максимальный id может
быть новее trigger, и такой кламп утечёт trigger и более новые сообщения.
Операционные typed-отказы этих пяти инструментов (`cache_error`,
`provider_unavailable`, `provider_error`, `timeout`, `aborted`, `unsafe_url`)
возвращаются обычным MCP-ответом с JSON-конвертом `{ok:false, tool,
error:{code…}, evidence:[]}` без protocol `isError`; `isError` остаётся
только для boundary-ошибок (missing/invalid `source_message_id`, invalid
tool arguments).

## Логи

Parilka пишет структурированный JSON в stderr; systemd направляет его в
journald. Приложение не пишет файлов логов: размер, ограничение частоты,
ротация и срок хранения целиком принадлежат journald. Этот документ не
выбирает и не устанавливает общесистемные лимиты.

```bash
# Следить за логами bot
journalctl --user -u parilka-bot.service -f -o cat

# Найти один числовой durable turnId. `-o json` оборачивает JSON приложения в MESSAGE.
turn_id=42
journalctl --user -u parilka-bot.service -o json | \
  jq --argjson turnId "$turn_id" \
    '(.MESSAGE? | fromjson?) as $event | select($event.turnId == $turnId) | $event'

# Последние ошибки (level >= 50)
journalctl --user -u parilka-bot.service -o json | \
  jq '(.MESSAGE? | fromjson?) as $event | select(($event.level // 0) >= 50) | $event'

# Подтверждение штатного завершения sync
journalctl --user -u parilka-sync.service -o json | \
  jq '(.MESSAGE? | fromjson?) as $event | select($event.event == "sync.shutdown_completed") | $event'

# Read-only объём журналов (system и user на этом host)
journalctl --disk-usage

# Только чтение: compiled defaults и effective настройки journald. Последнее
# активное (незакомментированное) значение ключа в main/drop-in файлах
# побеждает; если все значения закомментированы, действует compiled default.
systemd-analyze cat-config systemd/journald.conf | \
  rg -n '^[[:space:]]*#?[[:space:]]*(SystemMaxUse|RuntimeMaxUse|SystemKeepFree|RuntimeKeepFree|MaxRetentionSec|RateLimitIntervalSec|RateLimitBurst)='
```

`turnId` в JSON приложения — число, не строка. Для trace coordinator рядом
пишется строковый `coordinatorTurnId`; он нужен только для связи с универсальным
контрактом coordinator. Tool lifecycle (`bot.agent.tool_started` и
`bot.agent.tool`) не имеет фиксированного count ceiling и содержит только
correlation metadata, без call ID, input/output, query, model messages,
reasoning или provider payload. Каждый provider step и tool call имеет
собственный timeout; общего deadline хода нет.

## Bot диагностика без polling

Read-only SQL на snapshot (`PRAGMA query_only = ON`):

```sql
-- Последний update и распределение статусов
SELECT MAX(received_at_ms) AS last_update FROM bot_updates;
SELECT status, COUNT(*) AS n FROM bot_turns GROUP BY status;
SELECT status, COUNT(*) AS n FROM bot_updates GROUP BY status;

-- Stuck sending/lost_ack
SELECT id, chat_id, status, updated_at_ms FROM bot_turns
WHERE status IN ('sending', 'lost_ack') ORDER BY updated_at_ms;

-- Outbox backlog
SELECT status, COUNT(*) AS n FROM send_outbox GROUP BY status;
```
