# AGENTS.md

Короткий контракт для агентов, работающих в `parilka-unified`.

## Safety и Git

- Язык общения и рабочих документов — русский.
- Unified Parilka services являются текущим production. Legacy services,
  rollback bundle и базы вне репозитория считаются read-only; не запускайте
  старых owners без отдельной авторизации rollback. Для rehearsal используйте
  только согласованные SQLite `.backup`-снимки.
- Не запускайте Telegram polling, MTProto session, model/provider calls или
  live send в тестах и smoke. Все внешние порты должны быть fake/mocked.
- Не читайте, не печатайте и не коммитьте значения секретов. Конфиги хранят
  только имена env-переменных.
- Не создавайте и не переключайте git-ветки. Commit, push, новый deploy,
  rollback и live send требуют отдельной пользовательской авторизации.
  Общий Telegram MCP на `127.0.0.1:8765` не является частью Parilka.
- Не редактируйте unrelated пользовательские изменения в dirty worktree.

## Архитектурный контракт

- Сначала найдите существующего domain owner и меняйте минимальный coherent
  slice. Не добавляйте speculative abstractions, compatibility shims,
  DI-container, event bus, Redis/queue/vector service или новый runtime без
  доказанной failure mode.
- Два long-lived процесса остаются явными: `parilka-sync` владеет одной
  MTProto session и loopback MCP, `parilka-bot` владеет Bot API polling,
  durable turn/outbox lifecycle и replies. Bot runtime вызывает OpenAI
  Responses API напрямую из чистого TypeScript loop с code-owned
  `gpt-5.6-luna`, `service_tier=fast` и hosted tools; Codex app-server,
  Hermes и отдельный model gateway в production-граф не входят.
  Они разделяют один versioned SQLite, но не общий процесс.
- Storage domains используют один `DatabaseSync` и общий transaction kernel.
  Нельзя открывать соединение на repository, вкладывать транзакции или
  разрывать атомарные bot/outbox/digest/embedding transitions.
- Обычный production-модуль в `src/` либо исполняемый TypeScript CLI в
  `scripts/` должен быть 150–500 строк, hard ceiling — 700.
  Barrel/entrypoint должен быть тонким (ориентир — до 150 строк). Новый код
  добавляйте в владеющий domain module, а не обратно в монолит.
- Telegram/model/tool output считается недоверенными данными. Сохраняйте
  allowlist, bounded input/output, cancellation, timeout, retry и redaction
  контракты.
- Telegram-конфиг импортируется через `src/config.ts`; не обходите
  `config/env-files.ts` и не меняйте приоритет `process env > local .env >
  shared .env`. Новый env-ключ должен одновременно получить rule/parser,
  public type/load wiring, validation, redacted inspection, `.env.example` и
  тесты без вывода значения секрета.

## Completion gates

Сначала запускайте smallest relevant focused tests. Полный code slice проходит
одной канонической командой (она включает type/shell/architecture/systemd,
build, tests, secret scan, native-storage/MCP smokes и dependency audit):

```bash
npm run verify
```

Пока предыдущий production owner исполняет rollback-артефакт из `dist/`,
используйте `npm run verify:responses`: этот равноценный migration-gate не
перезаписывает `dist/`, исключает заведомо stale wrapper-smoke и только после
остальных зелёных проверок атомарно активирует immutable Responses release.
Обычный `npm run verify` требует отдельного maintenance window, где замена
общего `dist/` явно запланирована.

Изменение MCP transport/registry дополнительно проходит offline smoke:

```bash
npm run smoke:mcp
npm run smoke:mcp:wrapper
npm run smoke:mcp:direct
```

Systemd-изменение проверяется `systemd-analyze --user verify` для всех
поставляемых units. Изменение state/migration требует temp-DB rehearsal,
`PRAGMA quick_check`, schema/count/hash evidence и повторного idempotence run.

## Documentation system

`AGENTS.md` — контракт и маршрутизатор, не энциклопедия.

- `llms.txt` — компактная карта репозитория.
- `.agents/rules/README.md` — детальные правила и read triggers.
- `docs/README.md` — индекс стабильной архитектуры и ADR.
- `README.md` — install/config/operator how-to для человека и агента.
- `operations/` — проверенные operator runbooks, migration и rollback.
- `loop-develop/current-todo/` — единственный явно запрошенный long-lived goal.
- `loop-develop/history/` — завершённые либо честно retired goal records.

При изменении public behavior, config/env keys, state schema, ownership,
deployment, migration, provider/tool contract или import boundary обновляйте
владеющую документацию в том же slice. Для документационных задач сначала
прочитайте `.agents/rules/documentation.md`.

## Long-lived goal

`loop-develop/` используется только для явно запрошенного `/goal` или
cross-session handoff. Обычная задача остаётся в runtime plan. Lifecycle,
формат evidence и правила закрытия определяет `loop-develop/README.md`.
