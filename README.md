# Parilka

Parilka — единый TypeScript-проект для Telegram-бота, синхронизации истории
через MTProto и локального MCP-сервера. Проект рассчитан на один хост и один
versioned SQLite store (текущая схема исходников — v19).

Текущая топология:

```text
Bot API ──► parilka-bot ───────────────┐
                                       ├──► SQLite WAL v19 ◄── maintain + digests
MTProto ──► parilka-sync ──────────────┘
                 │
                 └── HTTP 127.0.0.1:8766/mcp
                              ▲
MCP client ──stdio──► thin proxy
```

- `parilka-sync` — единственный штатный владелец MTProto-клиента и mtcute auth
  storage. Он синхронизирует corpus и обслуживает session-scoped Streamable
  HTTP MCP только на loopback.
- `telegram-parilka-mcp` — по умолчанию тонкий stdio-proxy к `parilka-sync`; он
  не открывает Telegram session и SQLite.
- `parilka-bot` — durable Bot API poller. Update, сообщение и turn reservation
  записываются до сдвига polling offset; turns используют leases, stored draft,
  terminal `lost_ack` после неоднозначного dispatch и bounded retries до
  `dead_letter`.
- `parilka-maintain` — проверка `quick_check`, ограниченный retention
  history/bot/terminal send-outbox, `PRAGMA optimize` и passive WAL
  checkpoint.
- `parilka-digests` — отдельный последовательный job для daily и ISO-weekly
  сводок через роль `summary`; dry-run по умолчанию. Timer запускает его после
  успешного maintenance. Встроенного backup по-прежнему нет.

Production cutover на этом хосте завершён 2026-07-30: `parilka-sync`,
`parilka-bot` и `parilka-maintain.timer` enabled/active, legacy Parilka units
disabled/inactive, а отдельный общий Telegram MCP продолжает работать на
`127.0.0.1:8765`. Новый Parilka owner слушает только
`127.0.0.1:8766`; MCP writes остаются выключены и в hard dry-run. Проверяемые
детали deployment/E2E и rollback находятся в
[архиве goal 001](loop-develop/history/001-unified-parilka/001-todo.md) и
[migration runbook](operations/MIGRATION.md).

## Требования и сборка

- Node.js `>=22.5`;
- npm;
- Linux user services через systemd — только для поставляемых unit-файлов.

```bash
npm ci
cp .env.example .env
cp config/model-router.example.json config/model-router.json

# Полный completion gate для изменения
npm run verify
```

Production-обёртки bot/sync/MCP и maintenance/import/digest CLI запускают
только собранный `dist/`; перед установкой или обновлением units обязателен
`npm run build`. TypeScript-адаптеры в `scripts/` используются только тестами
и разработкой и отдельно проверяются `npm run check`/`check:shell`.

## Конфигурация

MTProto/MCP-конфиг загружается в таком порядке:

1. переменные окружения процесса;
2. shared dotenv, по умолчанию `~/.config/telegram-mcp/.env`;
3. local dotenv, по умолчанию `.env` в рабочем каталоге.

Пути можно переопределить переменными процесса `TELEGRAM_SHARED_ENV_PATH` и
`TELEGRAM_ENV_PATH`. Уже заданная переменная процесса имеет высший приоритет.
Полный безопасный шаблон находится в [.env.example](.env.example).

Минимально нужно заполнить:

- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` и Telegram session;
- `TELEGRAM_DEFAULT_CHAT_ID` и `TELEGRAM_ALLOWED_CHAT_IDS`;
- для bot runtime — `PARILKA_BOT_TOKEN`, `PARILKA_BOT_CHAT_ID`,
  `PARILKA_BOT_ID`, `PARILKA_BOT_USERNAME` и абсолютный
  `PARILKA_BOT_MODEL_CONFIG_PATH`; подтверждение
  `PARILKA_BOT_EXCLUSIVE_POLLER` задаётся позднее, после проверки
  эксклюзивности token;
- переменные с ключами провайдеров, на которые ссылается model-router JSON.

Поставляемые `parilka-bot` и `parilka-digests` wrappers также принимают
`PARILKA_BOT_TOKEN_FILE` и `PARILKA_DEEPSEEK_API_KEY_FILE`. Штатный
production router ссылается только на `PARILKA_DEEPSEEK_API_KEY`, поэтому
ему достаточно одного `PARILKA_DEEPSEEK_API_KEY_FILE`;
`PARILKA_QWEN_API_KEY_FILE` нужен лишь для кастомного non-production router
с Qwen-провайдером (поддержка Qwen в wrappers сохранена). Они читают только
принадлежащий текущему пользователю однострочный regular file с mode
`0400`/`0600`, экспортируют значение лишь в дочерний Node process и никогда
не печатают credential/path. Это позволяет переиспользовать существующий
private state без копирования секретов в новый dotenv.

Digest job по умолчанию переиспользует bot chat, общий DB и
`PARILKA_BOT_MODEL_CONFIG_PATH`. Dedicated значения можно выбрать через
`PARILKA_DIGEST_CHAT_ID`, `PARILKA_DIGEST_DB_PATH` и
`PARILKA_DIGEST_MODEL_CONFIG_PATH`, но это не отдельный state: chat обязан
совпадать с единственным `TELEGRAM_ALLOWED_CHAT_IDS`, а DB — указывать на тот
же canonical pathname, что `PARILKA_BOT_DB_PATH`/`TELEGRAM_DB_PATH`, если они
заданы. Symlink разрешён после `realpath`; другой hardlink к тому же inode
запрещён, потому что отдельные имена WAL/SHM небезопасны для SQLite.

`PARILKA_BOT_DB_PATH`, если задан, обязан указывать на тот же файл, что и
`TELEGRAM_DB_PATH`. `PARILKA_BOT_CHAT_ID` обязан входить в
`TELEGRAM_ALLOWED_CHAT_IDS`.

Булевы значения Telegram-конфига строгие: `1,true,yes,on` или
`0,false,no,off`. Пустое булево значение не означает default.

Расширять MTProto/MCP-конфиг нужно через модули `src/config/`: правило и
границы env — в `env-rules.ts`, разбор — в `env-parsers.ts`, публичный тип — в
`types.ts`, сборка — в `load.ts`, cross-field/URL/chat-проверки — в
`validation.ts`, безопасный вывод — в `redaction.ts`. Новый ключ также
добавляется в `.env.example` и покрывается тестом. Остальной код импортирует
только публичный фасад `src/config.ts`: это сохраняет единый порядок загрузки
env и не даёт разным entrypoint расходиться в defaults или валидации.

`PARILKA_BOT_EXCLUSIVE_POLLER` — отдельное fail-closed подтверждение оператора,
а не обычный boolean. Bot стартует только при значении ровно `true` в нижнем
регистре, включая shadow mode. Выставляйте его лишь после остановки всех других
`getUpdates` poller для этого token; отсутствие, пустое значение и `TRUE`
отклоняются. Это подтверждение не является распределённой блокировкой.

`PARILKA_MTPROTO_EXCLUSIVE_OWNER` действует так же для sync daemon/once:
значение должно быть ровно `true` и задаётся только после остановки прежнего
`telegram-parilka-sync` и любого другого owner той же MTProto session.
Отсутствующее или иное значение останавливает startup.

Проверить MTProto/MCP-часть без вывода секретов:

```bash
npm run validate-config
npm run print-config
```

Bot runtime и model-router также fail closed при запуске, но отдельной команды
для их полной валидации без старта poller сейчас нет.

### Telegram session и transport

Transport по умолчанию — `mtcute`. Для первичной авторизации можно сгенерировать
GramJS StringSession:

```bash
npm run generate-session
```

Сохраните результат как секрет `TELEGRAM_SESSION`. При первом mtcute startup он
импортируется в отдельный `TELEGRAM_MTCUTE_AUTH_DB_PATH`; уже авторизованный
mtcute store не перезаписывается. Application DB и auth DB должны быть разными
файлами.

`TELEGRAM_TRANSPORT=gramjs` оставлен только как rollback transport. Это не
штатный режим новой установки.

### Model router

Router поддерживает три adapters (`openai` Chat Completions, `anthropic` и
официальный `deepseek`) и две обязательные роли (`turn`, `summary`). Кандидаты
задаются в порядке fallback как `provider:model`; ключи и custom headers
берутся только из названных переменных окружения.

Пример из [config/model-router.example.json](config/model-router.example.json):

```json
{
  "allowInsecureLocal": false,
  "providers": [
    {
      "id": "openai_primary",
      "protocol": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "PARILKA_OPENAI_API_KEY"
    },
    {
      "id": "anthropic_fallback",
      "protocol": "anthropic",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKeyEnv": "PARILKA_ANTHROPIC_API_KEY"
    }
  ],
  "roles": {
    "turn": [
      "openai_primary:your-openai-model-id",
      "anthropic_fallback:your-anthropic-model-id"
    ],
    "summary": [
      "anthropic_fallback:your-anthropic-model-id",
      "openai_primary:your-openai-model-id"
    ]
  }
}
```

Все объявленные providers должны иметь непустой `apiKeyEnv`, даже если стоят
последними в fallback. HTTP разрешён только для loopback endpoint при
`allowInsecureLocal=true`; остальные endpoints должны использовать HTTPS.
Provider POST не следует HTTP redirects, а тело ответа ограничено 16 MiB,
чтобы prompt/credentials не ушли на другой origin и ошибочный endpoint не
выдавил процесс из памяти.

DeepSeek adapter принимает `thinkingMode=enabled|disabled`; default —
`disabled`. Поставляемый
[production router](config/model-router.production.json) использует
официальный DeepSeek endpoint `https://api.deepseek.com` с
`thinkingMode=enabled` и единственным candidate `deepseek-v4-flash`
(DeepSeek V4 Flash 0731, text-only, окно 1M токенов) для обеих ролей: без
Qwen и без fallback-провайдера.

Bot turn использует роль `turn`; `parilka-digests` использует роль `summary`.
В production обе роли содержат ровно один DeepSeek candidate
`deepseek:deepseek-v4-flash`: это покрывает ответы агента, day/ISO-weekly
summaries и dream-консолидацию памяти. Month rows можно
импортировать и хранить через низкоуровневый store, но текущий bot read tool
их не читает и автоматически не генерирует.

Bot turn не имеет общего deadline и фиксированного лимита model/tool ходов.
`PARILKA_BOT_MODEL_STEP_TIMEOUT_MS` ограничивает только один provider step
(default 180000); каждый tool, локальная транскрипция и Telegram publication
сохраняют собственные timeout/cancellation и bounded payload-контракты.

### Опциональный web search

Web search выбирается через `PARILKA_BOT_WEB_SEARCH_PROVIDER` (`auto` по
умолчанию) и имеет два опциональных бэкенда:

- **HTTP adapter** — provider-neutral boundary. При заданном
  `PARILKA_BOT_WEB_SEARCH_ENDPOINT` бот делает:

  ```text
  POST {"query":"..."}
  → {"text":"...", "sources":[{"url":"https://...", "title":"..."}]}
  ```

  Bearer token можно сослать через
  `PARILKA_BOT_WEB_SEARCH_BEARER_TOKEN_ENV`. Endpoint должен быть HTTPS либо
  loopback HTTP, без credentials/query/fragment.

- **Vertex adapter** — bot-owned native Gemini grounding
  (`PARILKA_BOT_WEB_SEARCH_PROVIDER=vertex`). Gemini здесь только поисковый
  прокси: один `generateContent` с `googleSearch`, видимый ответ возвращается
  как есть, grounding chunks становятся источниками. Авторизация — Application
  Default Credentials через `gcloud auth application-default print-access-token`
  (часовой user-token, кэшируется), как у эмбеддингов; API-ключа нет. Модель,
  проект, регион и путь к `gcloud` настраиваются через `PARILKA_VERTEX_*` /
  `PARILKA_GCLOUD_PATH`.

`auto` включает HTTP adapter при заданном endpoint, иначе Vertex при заданном
`PARILKA_VERTEX_PROJECT`, иначе поиск выключен. Ни один бэкенд не является
частью rulesync. Отключённый там `gemini-search` восстанавливать для Parilka не
нужно.

### Встроенный static page fetch

`static_page_fetch` не зависит от browser MCP, Chrome/Brave-профиля или
Lightpanda и не требует отдельной настройки. Он открывает ровно одну
статическую публичную HTTPS-страницу только через DNS-pinned соединение, не
передаёт cookies или логины, не исполняет JavaScript и не следует redirect
автоматически. Ответ ограничен 1 MiB входного тела и 3 000 видимыми
символами; переход по redirect модель запрашивает отдельным вызовом и тот
снова проходит проверку адреса. Для x.com/twitter.com, Instagram, TikTok и
других login-gated или JS-рендеренных страниц инструмент не предназначен:
там используется `firecrawl_crawl`, а если прямой обход не даёт контента —
`searxng_search`.

### Опциональный HH research gateway

`research_lookup` не читает файлы HH из этого репозитория и не знает их
структуру. Это клиент к owner-only Unix socket отдельного read-only сервиса,
который владеет закрытым исследовательским корпусом. При заданном
`PARILKA_BOT_RESEARCH_GATEWAY_SOCKET` в private bot env клиент передаёт только
короткий запрос и получает строго ограниченный обезличенный конверт; путь к
HH-репозиторию, manifest, БД, credential и raw record не входят в контракт.
В env указывается уже развёрнутый абсолютный путь, например
`/run/user/<UID>/hh-research-gateway/gateway.sock`; `%t` применим только внутри
systemd unit.

Это единственная tool-specific граница раскрытия данных закрытого корпуса:
шлюз делает первый технический privacy-filter, а bot дополнительно отбрасывает
опасный query до обращения к сокету, отбрасывает неожиданные идентификаторы и
обязан обобщать результат в финальном ответе. Он не предназначен для поиска
людей, конкретных резюме/профилей, вакансий или построения досье; агрегированные
вопросы о повторяющихся темах подготовки разрешены.
Оставьте переменную пустой, чтобы gateway не использовать; устанавливать или
перезапускать отдельный HH service следует только по явному operator-действию.

## Локальный запуск

До запуска выберите изолированные test bot/token и MTProto session либо
остановите прежние Bot API poller и MTProto owner. Shadow запрещает отправку,
но не устраняет конфликт `getUpdates` или конкуренцию за MTProto session.

После проверки, что прежний `telegram-parilka-sync` и все другие владельцы этой
MTProto session остановлены, запускается единственный новый owner:

```bash
PARILKA_MTPROTO_EXCLUSIVE_OWNER=true \
  ./bin/telegram-parilka-mcp-sync-daemon
```

Проверка статуса идёт через его loopback MCP:

```bash
./bin/telegram-parilka-mcp --status
```

После проверки, что других `getUpdates` poller для этого token нет, bot
стартует в shadow по умолчанию:

```bash
PARILKA_BOT_EXCLUSIVE_POLLER=true PARILKA_BOT_MODE=shadow ./bin/parilka-bot
```

Shadow сохраняет и обрабатывает updates, строит drafts, но не вызывает
Bot API `sendMessage`. При этом он всё равно является long poller: нельзя
одновременно запускать старый и новый bot с одним Bot API token. Для
параллельного shadow нужен отдельный тестовый bot/token; иначе старый poller
следует остановить на контролируемое окно.

Аналогично, новый `parilka-sync` нельзя запускать рядом со старым MTProto
owner той же session.

### MCP client

Штатная конфигурация клиента указывает на stdio-обёртку:

```toml
[mcp_servers.telegram-parilka]
command = "/absolute/path/to/parilka-unified/bin/telegram-parilka-mcp"
```

`parilka-sync` должен уже слушать `http://127.0.0.1:8766/mcp` (или одинаковый
`PARILKA_MCP_HTTP_URL` должен быть задан owner и proxy).

Loopback transport session-scoped намеренно: MCP
`notifications/cancelled` приходит отдельным запросом и должен попасть в тот же
protocol/`AbortController`, что и исходный tool call. Stdio-proxy передаёт
`AbortSignal` owner-у, а owner — sync lane, Telegram history
fetch/iterator/pacing/reconciliation и embedding calls. Отменённая queued sync
не запускается и сразу освобождает bounded queue capacity; daemon shutdown
объединяется с request signal. Send signal после начала Telegram dispatch не
используется, чтобы cancellation не создавала ложной уверенности, что сообщение
не принято.

Owner ограничивает число loopback-сессий до 32 и удаляет неактивные сессии
через 30 минут. Штатный proxy при graceful shutdown отправляет MCP `DELETE`;
десятиминутный loopback ping сохраняет живую idle-сессию, а idle TTL освобождает
её после аварийного исчезновения клиента. Ошибка keepalive (например, после
рестарта owner) fail-fast закрывает stale stdio-proxy с ненулевым exit code,
чтобы harness создал новую session, а не держал вечный 404-клиент. Endpoint
по-прежнему принимает только loopback Host/Origin; GET отключён.

`--direct` — только аварийный recovery при полностью остановленном
`parilka-sync`:

```bash
systemctl --user stop parilka-sync.service
PARILKA_MTPROTO_EXCLUSIVE_OWNER=true \
  ./bin/telegram-parilka-mcp --direct
```

Без exact guard `PARILKA_MTPROTO_EXCLUSIVE_OWNER=true` direct mode завершится
до открытия Telegram session. Не запускайте `--direct` рядом с owner: это
создаст второго владельца MTProto session. После recovery завершите direct process до возврата
`parilka-sync.service`.

## systemd user services

Поставляемые unit-файлы ожидают checkout в `%h/repos/parilka-unified` и читают:

- `%h/.config/telegram-mcp/.env` — MTProto/shared DB;
- `%h/.config/parilka/parilka.env` — bot/router/web-search.

Если checkout находится в другом месте, сначала исправьте пути в
устанавливаемых копиях unit-файлов. Секретные env-файлы должны иметь mode
`0600`; model-router JSON содержит только ссылки на env, а не сами ключи.
Units разрешают запись только в `%h/.telegram-parilka-mcp`; иной DB path требует
осознанно изменить `ReadWritePaths` в устанавливаемой копии.

Для новой установки до первого запуска убедитесь, что в bot env явно стоит
`PARILKA_BOT_MODE=shadow`, MCP writes выключены
(`TELEGRAM_SEND_ENABLED=false`, `TELEGRAM_DRY_RUN_DEFAULT=true`), а старые
poller/MTProto owner остановлены либо новые services используют отдельные
test token/session. Только после этой проверки задайте в private bot env
`PARILKA_BOT_EXCLUSIVE_POLLER=true`. Поставляемый unit намеренно не задаёт
подтверждение через `Environment=`. Аналогично, в private shared env задайте
`PARILKA_MTPROTO_EXCLUSIVE_OWNER=true` лишь после остановки прежнего
`telegram-parilka-sync`; sync unit тоже намеренно не задаёт guard сам.

```bash
install -d -m 0700 \
  "$HOME/.config/systemd/user" \
  "$HOME/.telegram-parilka-mcp"
install -m 0644 systemd/parilka-sync.service "$HOME/.config/systemd/user/"
install -m 0644 systemd/parilka-bot.service "$HOME/.config/systemd/user/"
install -m 0644 systemd/parilka-maintain.service "$HOME/.config/systemd/user/"
install -m 0644 systemd/parilka-maintain.timer "$HOME/.config/systemd/user/"

systemctl --user daemon-reload
systemctl --user enable --now parilka-sync.service
systemctl --user enable --now parilka-bot.service
```

Сначала отдельно проверьте dry-run maintenance и digest plan; второй не
вызывает модель и требует уже мигрированную schema v19. Если в shell уже
экспортированы production DB/allowlist, снимите их для изолированного snapshot,
иначе fail-closed identity check правильно отклонит другой файл:

```bash
./bin/parilka-maintain --db /path/to/parilka-shadow.sqlite
env -u TELEGRAM_DB_PATH \
  -u PARILKA_BOT_DB_PATH \
  -u TELEGRAM_ALLOWED_CHAT_IDS \
  ./bin/parilka-digests \
    --db /path/to/parilka-shadow.sqlite \
    --chat -1000000000000
```

Dry-run описывает кандидатов относительно текущих persisted digests. Он не
может заранее вычислить weekly hash из ещё не созданного model summary, поэтому
apply после новых day rows может дополнительно вызвать weekly summary. После
проверки timer запускает maintenance, а затем digest apply:

```bash
systemctl --user enable --now parilka-maintain.timer
systemctl --user list-timers parilka-maintain.timer
```

Команды выше являются безопасным рецептом новой shadow-установки, а не
описанием текущего хоста. На текущем хосте live cutover уже подтверждён
deployment evidence; повторное переключение mode или владельцев требует
нового controlled gate из migration-документа.

### Логи

Bot, sync и MCP entrypoints пишут redacted Pino JSON в stderr; systemd
направляет stdout/stderr в journald. Application-owned append-only log-файлов
нет.

```bash
journalctl --user \
  -u parilka-sync.service \
  -u parilka-bot.service \
  -u parilka-maintain.service \
  -f -o cat
```

Уровень сервисных логов задаёт `PARILKA_LOG_LEVEL` (default `info`). Retention и
лимиты журнала настраиваются в journald, не в Parilka.

## Write safety

MCP writes по умолчанию находятся в hard dry-run:

```dotenv
TELEGRAM_SEND_ENABLED=false
TELEGRAM_DRY_RUN_DEFAULT=true
```

Для live MCP send нужны оба обратных значения, allowlist и совпадающий
одноразовый `approval_id` из `preview_message` (если не включён административный
bypass). Этот ID связывает payload, но не является human approval: один MCP
caller может сам создать и использовать его. Отдельные policy modes
`human_confirmed`/`autonomous_allowlisted` в коде не реализованы.

`dedupe_key` необязателен, но настоятельно рекомендуется для actionable live
sends. Durable outbox не повторяет неоднозначный dispatch автоматически.

`PARILKA_BOT_MODE=live` управляет Bot API публикацией независимо от MCP
write-флагов. Bot записывает draft до `sending`; transport timeout, partial send
или неизвестный ACK после dispatch завершается terminal `lost_ack` и требует
ручной сверки.

## Embeddings

Embeddings выключены по умолчанию. Включение отправляет cached chat text во
внешний OpenAI-compatible `/embeddings` endpoint:

```bash
npm run embed-once -- --limit-chunks 1000 --estimate-only
npm run embed-once -- --limit-chunks 1000 --confirm-estimate
```

Первый запуск и усечение budget требуют явного подтверждения. Search использует
FTS, bounded exact cosine scan и hybrid fusion; candidate cap задаёт
`TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT`.
Endpoint должен быть HTTPS (loopback HTTP разрешён для локального сервера),
credentials/query/fragment и redirects отклоняются. Ответ ограничен 64 MiB и
принимается только с полным набором уникальных индексов и конечными векторами
одинаковой размерности.
Внутренний `Retry-After` ограничен
`TELEGRAM_EMBEDDINGS_RETRY_MAX_MS`. Daemon запускает optional indexing
отдельно от Telegram history loop с cadence
`TELEGRAM_EMBEDDINGS_TICK_INTERVAL_MS` и жёстким budget
`TELEGRAM_EMBEDDINGS_TICK_BUDGET_MS`: сбой ухудшает health, но не управляет
core backoff и не задерживает следующий history tick.

```bash
npm run benchmark:vector -- \
  --candidates 20000 \
  --dimensions 256 \
  --target-p95-ms 250
```

Provider/model namespaces изолированы, но полноценного staging generation с
атомарной активацией пока нет. `rebuild` удаляет текущий namespace до
последовательного заполнения.

## Maintenance, digests и импорт Python state

Без `--apply` maintenance открывает DB read-only и печатает dry-run report:

```bash
./bin/parilka-maintain --db /path/to/snapshot.sqlite
./bin/parilka-maintain --db /path/to/snapshot.sqlite --apply
```

Apply помечает stale `history_jobs`, удаляет bounded terminal history/bot rows
и старые terminal `send_outbox` только в статусах
`sent/failed/expired`, исполняет отложенный FTS rebuild и bounded/resumable
membership backfill, запускает `PRAGMA optimize` и passive WAL checkpoint.
`queued`/`sending` outbox retention никогда не удаляет.

По умолчанию outbox dedupe history хранится минимум 30 дней и не меньше
последних 1 000 terminal rows. Оба ограничения действуют одновременно:
удаляется только строка старше `--send-outbox-days`, которая не входит в
`--keep-send-outbox-rows` самых новых. После удаления строки повторное
использование её старого `dedupe_key` уже не распознаётся; для более длинного
retry window увеличьте один или оба параметра.

Пока deferred job остаётся `pending`, keyword/vector search отвечает явным
degraded status вместо ложного пустого результата. Размер membership batch и
число batches за запуск регулируют `--deferred-batch-size` и
`--deferred-max-batches`. WAL report нормализует `busy`, `log`,
`checkpointed`, считает оставшиеся frames и примерный объём по `page_size`; при
ненулевом остатке выдаётся warning. Failure JSON сообщает текущую и завершённые
фазы и консервативно отмечает, могли ли retention/deferred commits уже
состояться, не печатая exception message, DB path или содержимое строк.
Backup/restore остаются внешней операторской процедурой. Детали модулей и
границ транзакций — в
[src/maintenance/README.md](src/maintenance/README.md).

Digest CLI тоже dry-run по умолчанию. Он читает только schema v19, планирует
недостающие Moscow-calendar days и ISO weeks и не вызывает модель:

```bash
./bin/parilka-digests \
  --db /path/to/parilka-shadow.sqlite \
  --chat -1000000000000

./bin/parilka-digests \
  --db /path/to/parilka-shadow.sqlite \
  --chat -1000000000000 \
  --model-config /absolute/path/to/model-router.json \
  --apply
```

Apply обрабатывает периоды последовательно и изолирует ошибку одного периода,
использует bounded input/output/deadlines, сохраняет source hash и
provider/model attribution. Один apply вызывает не больше трёх day и одной
week generation по умолчанию; самые свежие due periods идут первыми.
Пределы задаются
`PARILKA_DIGEST_MAX_DAY_GENERATIONS_PER_RUN` (0–31) и
`PARILKA_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN` (0–8), либо явными
`--max-day-generations-per-run` и `--max-week-generations-per-run`.
Dry-run эти пределы не обрезают: он планирует весь backlog без model calls.
Лишние apply-кандидаты получают `deferred/run_limit`, а существующие legacy
day/week rows остаются доступными до следующего запуска. В JSON-отчёте
фактические `providerCalls` и `deferred` находятся отдельно для days/weeks,
а выбранные пределы — в `options`.

Текущий Moscow day штатно пропускается. День
автоматически пересчитывается после 25 чисто добавленных сообщений того же
календарного дня с `message_id` выше сохранённого `end_message_id`; сообщения
следующих дней этот repair не запускают. Edit/delete исторического source
пересчитывает непустой день немедленно без append-порога. Если у сохранённого
дня больше не осталось ни одного source message, day row и зависимый week
удаляются. Принудительный пересчёт, включая текущий день, требует ручного
`--all`. Смена prompt version автоматически
инвалидирует соответствующие day/week rows. Week не публикуется, пока каждый
его день не подтверждён текущими source hash и prompt version; hash повторно
проверяется после model call перед записью. Скрытого усечения source нет:
слишком большой input явно отмечается failed. Одновременные digest apply для
одного canonical DB path/inode блокируются удерживаемой транзакцией в отдельной
private SQLite lock-БД. Это OS-backed single-owner lock: после crash владельца
ядро освобождает его без stale-file unlink/recovery race. Открывать основной
SQLite inode через разные hardlink-пути запрещено: digest CLI fail closed до
read-only preflight, если `nlink` application DB не равен одному.

`parilka-maintain.service` выполняет built `parilka-maintain --apply` с
указанными выше retention defaults, затем
`parilka-digests --apply`; поэтому для timer должен быть доступен role
`summary` и provider credentials. Digest CLI сам `.env` не загружает: прямому
apply нужны экспортированные provider variables, а systemd получает их из
`EnvironmentFile`. SQLite process-lock живёт рядом с canonical DB в private
state directory и выводится из её device/inode: systemd и ручной CLI всегда
делят один lock namespace независимо от `XDG_RUNTIME_DIR`. Timer использует
`--summary-only`, поэтому пишет один bounded JSON summary с failure codes
вместо тысяч backlog item lines; ручной dry-run остаётся подробным. Первый
apply после legacy import может пересобрать day rows с прежней prompt version
и зависимые weekly rows; dry-run показывает весь backlog, а scheduled oneshot
постепенно разбирает его newest-first в пределах указанных выше лимитов.
Оцените provider cost по dry-run и выполните первый apply вручную до включения
timer.
`PARILKA_DIGEST_MODEL_CANDIDATE_TIMEOUT_MS` не может превышать
`PARILKA_DIGEST_MODEL_TOTAL_TIMEOUT_MS`. Backup/restore ни один job не создаёт.

Python state importer также dry-run по умолчанию:

```bash
./bin/parilka-import-python-state \
  --source /path/to/legacy-bot.snapshot.sqlite \
  --target /path/to/parilka-shadow.sqlite \
  --chat-id -1000000000000

./bin/parilka-import-python-state \
  --source /path/to/legacy-bot.snapshot.sqlite \
  --target /path/to/parilka-shadow.sqlite \
  --chat-id -1000000000000 \
  --apply
```

Он идемпотентно импортирует `live_msg` и day/week/month digests. На overlap
Python заполняет только отсутствующие canonical message fields; различающиеся
непустые поля fail closed до message writes, а report показывает только
счётчики fill/conflict без содержимого. Legacy drafts, events и **все** Python
outbox rows, включая `lost_ack`, только подсчитываются в отчёте и не попадают
в live retry queue.

Operational bin (`parilka-import-python-state`, `parilka-maintain` и
`parilka-digests`) исполняют только собранные `dist/*-cli.js` и fail closed,
если build отсутствует или старее source/config. После изменения исходников
выполните `npm run build`. TypeScript-файлы в `scripts/` — только thin
development/test wrappers.

## Проверки

Локальный release gate включает CI и дополнительные coverage/diff проверки:

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

Smokes используют временный DB и fake Telegram gateway; live sends и внешние
embedding/model вызовы не выполняются.

## Известные ограничения

- live cutover и Telegram E2E пройдены; rollback bundle проверен, но
  фактический post-live rollback не выполнялся;
- нет встроенного backup/restore, автоматических month digests и атомарного
  vector staging/activation;
- edit/delete исторического дня пересчитывается сразу; порог в 25 сообщений
  применяется только к append-only дополнению после сохранённого конца дня;
- web search — generic HTTP JSON adapter или bot-owned native Vertex Gemini
  grounding через gcloud ADC; оба опциональны и вне rulesync; `static_page_fetch` —
  отдельный встроенный публичный HTTPS-fetcher без browser state;
- отдельной human-approval policy нет; MCP `approval_id` — self-issued
  payload capability;
- Python outbox/drafts/events не мигрируют в новый live state;
- HTTP MCP намеренно доступен только на `127.0.0.1`, без OAuth и remote bind;
- MCP transport остаётся legacy-compatible реализацией на SDK v1; полная
  совместимость со спецификацией MCP 2026-07-28 не заявляется;
- GramJS сохранён как rollback, а не равноправный основной transport.

## Документы

- [Архитектурный канон](docs/README.md)
- [ADR: unified TypeScript](docs/adr/0001-unified-typescript.md)
- [Migration и rollback](operations/MIGRATION.md)
- [Завершённый goal 001 и evidence](loop-develop/history/001-unified-parilka/001-todo.md)
