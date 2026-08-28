# Architecture Map

Parilka — небольшой agent-native TypeScript repository для одного Telegram
group chat. Application shells только компонуют independently testable
домены; SQLite остаётся единым correctness boundary.

## Runtime topology

```text
Bot API ──► parilka-bot ───────────────┐
                                       ├──► SQLite WAL v21 ◄── maintenance/digests
MTProto ──► parilka-sync ──────────────┘
                 │
                 └──► HTTP 127.0.0.1:8766/mcp
                                  ▲
MCP harness ──stdio──► thin proxy─┘
```

- `parilka-sync` — единственный штатный MTProto owner, history sync owner и
  loopback MCP owner.
- `parilka-bot` — единственный Bot API long poller для данного token; model
  work выполняется durable workers после committed ingest.
- Оба процесса используют один canonical SQLite file, но не общий process.
- Общий Telegram MCP rulesync service на `127.0.0.1:8765` — отдельная система
  машины и не является частью Parilka.

## Repository lanes

| Lane | Path | Authority |
| --- | --- | --- |
| Process shells | `src/{index,bot-daemon,sync-daemon}.ts` | startup, composition, signals и graceful shutdown |
| Bot | `src/bot/` | Bot API update ingest, turn FSM worker, bounded agent loop, evidence/search tools, chat-scoped memory reads and operator-authorized direct-gated memory writes, guarded rich/plain publication, typing/tool-progress presentation и telemetry rendering |
| Storage | `src/storage/` + `src/store.ts` barrel | один connection/transaction kernel, schema и domain repositories |
| Telegram/sync | `src/telegram/`, `src/sync/` | transport lifecycle, one-owner guard, recent/backfill reconciliation |
| MCP | `src/mcp-tools/`, `src/mcp-loopback.ts` | 13 operator tools, loopback session transport и stdio proxy |
| Digests | `src/digest/` | source planning/hash, sequential day/week generation, process lock и offline dream memory consolidation |
| Providers | `src/providers/` | validated roles/candidates, hardened HTTP, fallback classification |
| Vector | `src/vector/`, `src/embeddings.ts` | opt-in index, atomic source recheck, dense + learned sparse search/fusion, bounded ColBERT rerank; backend `external_openai` (legacy) или операторский loopback BGE-M3 (`services/bge-m3`) |
| Maintenance | `src/maintenance/`, `src/maintenance-cli.ts` | bounded retention, deferred FTS, WAL checkpoint, schema integrity; `parilka-maintain` |
| Operational CLI | `src/{python-import,digest-cli}/` | offline migration, digest and dream command implementations compiled into `dist` |
| Operations | `operations/`, `systemd/`, `bin/` | human-reviewed install, migration, retention и rollback procedures |
| Long-lived handoff | `loop-develop/` | один active goal; closed/retired evidence в history |

Production files обычно держатся в диапазоне 150–500 строк; hard ceiling CI —
700. Одиннадцать текущих модулей сознательно остаются выше мягкой границы
(реестр: `src/bot/ai-agent.ts`, `src/bot/media/flov-transcriber.ts`,
`src/bot/prompt.ts`, `src/storage/embeddings.ts`, `src/storage/bot-turns.ts`,
`src/bot/grammy-publisher.ts`, `src/bot/web-search-vertex.ts`,
`src/mcp-loopback.ts`, `src/bot/read-tools/web-fetch-executor.ts`,
`src/dream/consolidator.ts`, `src/bot/memory-tools.ts`). Они уже вынесены
из прежних монолитов, ниже hard ceiling и не дробятся только ради счётчика
строк. Точные текущие размеры намеренно не дублируются здесь: их источником
истины остаётся `npm run check:architecture`.

Cohesive test modules имеют отдельный ceiling 500, чтобы regression
fixtures не превращались в смешанные монолиты.

## Dependency direction

```text
process shells
  ├── bot ────────┐
  ├── sync/MCP ───┼──► storage core/domain repositories
  ├── digests ────┤
  └── vector ─────┘

bot agent ──► read-only bot tools ──► storage/vector/search/public-web-fetch ports
operator MCP ──► Telegram gateway + storage + serialized sync
```

- Storage не импортирует process shells, bot agent или MCP registry.
- Bot model никогда не получает operator MCP write/sync tools. Его обычный
  registry состоит из девяти evidence/search tools (`rag_bm25_search`,
  `keyword_search`, `read_chat_slice`, `day_digest`, `thread_context`,
  `web_search`, `static_page_fetch`, `paper_search`, `research_lookup`)
  и двух bounded memory reads.
- `keyword_search` и `read_chat_slice` — cache-only слой поверх
  deterministic lexical FTS и live-only transcript API: они не вызывают
  vector/embedding provider и Telegram. Оба автоматически ограничиваются
  application-owned `sourceMessageId - 1` текущего turn и не полагаются на
  model-provided trigger ID. `read_chat_slice` замораживает authoritative
  upper message id в версионированном keyset cursor, поэтому срез устойчив к
  новым вставкам. Projection остаётся bounded: обычные read tools сохраняют
  короткий cap ~4 000 chars, `keyword_search` — умеренный 20 000,
  `read_chat_slice` — увеличенный 192 000, чтобы ~800 коротких сообщений
  доходили одним вызовом; metadata честно сообщает truncation/omission.
  В operator MCP эти инструменты не добавляются.
  Три memory-write tool появляются только для адресного trigger с прямой
  просьбой сохранить/обновить память от numeric Telegram account из закрытого
  operator-configured env allowlist. Allowlist не попадает в model context;
  это не даёт доступ к MCP writes.
- MCP stdio proxy не владеет Telegram credentials, SQLite или session.
- Providers не владеют state и получают secrets только через env references.

## Correctness boundaries

- Один `DatabaseSync`, WAL и `synchronous=FULL`.
- `BEGIN IMMEDIATE` остаётся вокруг bot ingest/reservation, turn+parent update
  transitions, send reserve+throttle, digest source recheck+commit, message
  edit/delete+embedding dirty mark и schema migration.
- Telegram delivery после dispatch fence считается неоднозначной:
  автоматический retry запрещён, состояние становится `lost_ack`/unknown
  delivery.
- Embedding result коммитится только после atomic повторной проверки exact
  source IDs и canonical rendered text. Для локального BGE-M3 dense vector и
  learned sparse postings одного чанка пишутся одной транзакцией; postings
  принадлежат parent chunk namespace и каскадно удаляются вместе с ним.
- Fast notes, durable lessons и skills строго chat-scoped, bounded и
  source-attributed; их upsert/pruning выполняется в том же SQLite transaction
  kernel. Их содержимое всегда остаётся недоверенными данными для модели.
- Digest append threshold применяется только к доказанному pure append;
  edit/delete исторического prefix инвалидирует cache немедленно.

## Security and observability

- Chat allowlist, exact exclusive-owner acknowledgements и disabled live send
  — fail-closed defaults.
- Network endpoints валидируются; credentials, redirects и oversized bodies
  не проходят provider boundary.
- `static_page_fetch` не использует Chrome/CDP/MCP или браузерный профиль:
  только public HTTPS, DNS pinning до соединения, без cookies, JavaScript и
  автоматических redirect; ответ ограничен 1 MiB и 3 000 видимыми символами.
- Model/tool/Telegram content недоверенно; logs не содержат message bodies,
  secrets или raw provider payloads.
- Pino пишет structured JSON в stderr, systemd направляет его в journald.
  Application append-only log files не создаются.

## Verification map

Канонический routing находится в [../AGENTS.md](../AGENTS.md). Полный
completion gate:

```bash
npm run verify
```

Transport, systemd и migration slices добавляют свои offline smoke,
`systemd-analyze verify` и temp-DB rehearsal; production state этим не
мутируется. Architecture gate применяет production ceiling к `src/` и
production CLI в `scripts/`, отдельный test ceiling — к `tests/`, чтобы
эксплуатационные команды и regression suites не становились скрытыми
монолитами. Он сканирует Markdown только в canonical roots: root-файлах,
`.agents/rules/`, `codex-skill/`, `docs/`, `loop-develop/`, `operations/` и
`src/`; scratch вне этих roots не становится частью CI-контракта. Реестр thin
barrels обязателен: отсутствующий declared barrel — ошибка, а retired
`output-guards.ts` в нём не числится. Gate также требует, чтобы `CLAUDE.md`
был symbolic link с точной целью `AGENTS.md`, сохраняя последний единственным
каноническим instruction contract. Для `src/storage/**` он разбирает только
relative static imports/re-exports и запрещает documented edges к bot/
bot-daemon, MCP registry/tools/proxy и process-shell entrypoints; cycles и
общую platform policy этот gate не выводит.

## Radar

- **Native Telegram Rich Messages** (`sendRichMessage`) — принятый primary
  path для финального ответа бота: Telegram сам рендерит headings, списки,
  GFM-таблицы и LaTeX (`$...$`, `$$...$$`, fenced `math`). Локально остаётся
  только canonical plain projection и classic plain fallback. Bot API ACK
  records that projection
  before MTProto reconciliation; an mtcute rich-message placeholder cannot
  subsequently overwrite it with empty `text`. Решение и safety/durability
  rationale:
  [ADR 0002](adr/0002-native-telegram-rich-messages.md).
