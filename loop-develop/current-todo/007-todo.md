# Goal 007: чистый TypeScript Responses loop для Parilka

## Goal

Вернуть production-чат Parilka с private Codex app-server на прямой чистый
TypeScript loop поверх OpenAI Responses API, закрепить единственный runtime
`gpt-5.6-luna` с `service_tier=fast`, встроить causal hybrid RAG и передавать
hosted OpenAI tools непосредственно в server-side request. Сохранить durable
Telegram owner, быстрый typing/tool-progress, Rich Messages и подтвердить
миграцию полным deploy и живым E2E, включая web search и входящее изображение.

## Permissions

- Пользователь явно разрешил реализацию, продолжение goal и production deploy
  этой миграции Parilka.
- Разрешение включает repo-owned bot/maintenance runtime, systemd/config/docs,
  безопасную миграцию state и минимальные маркированные Telegram E2E после
  готового exclusive cutover.
- Commit, push и удаление rollback/state backups не разрешены и не выполняются.
- Текущий работающий Codex runtime сохраняется до зелёных тестов, отдельного
  Responses API credential и готового rollback; секреты нельзя печатать,
  логировать или добавлять в Git.

## Source Research Summary

- Git anchor: `a61d187` — последний полный TypeScript agent loop до Hermes.
  Он используется только как behavioral source: старые ModelRouter,
  SearXNG/Firecrawl и AI SDK не возвращаются.
- Текущая dirty реализация уже содержит сильный durable Bot API poller,
  outbox/retry fences, split HTTP lanes, typing, one-bubble tool progress,
  Rich Messages и causal cache tools. Эти слои остаются; заменяется agent/model
  boundary и Codex-specific maintenance adapters.
- Official OpenAI model docs подтверждают, что `gpt-5.6-luna` поддерживает
  Responses, streaming, image input, function calling и hosted web search.
  Fast mode задаётся непосредственно как `service_tier: "fast"`.
- Hosted web search должен находиться в каждом Responses request как
  `{type:"web_search"}`. Его stream actions `search`, `open_page` и
  `find_in_page` дают честный Telegram progress; `url_citation` annotations
  преобразуются host-renderer'ом в кликабельные безопасные ссылки.
- Для Telegram image не нужен искусственный tool round-trip: bounded bytes
  скачиваются через Bot API action lane и передаются в тот же request как
  `input_image` data URL. Host показывает безопасный progress
  `просмотр изображения`; file id, token URL и path модели/логам не выдаются.
- Новый RAG — host-side causal context packet: reply + bounded recent context
  всегда, hybrid BM25/BGE-M3 sparse+dense/RRF/rerank только при history intent,
  causal digest только при temporal intent; пять read-only function tools
  остаются для углубления. Везде cutoff строго `< trigger message id`.
- Для public Responses API отдельного project API key на машине пока нет.
  Codex OAuth из `~/.codex/auth.json` не переиспользуется. Код и offline tests
  делаются заранее; live cutover ждёт owner-only credential через systemd
  `LoadCredential`.

## Product Shape

```text
Telegram Bot API -> durable TS worker -> causal RAG/context builder
                                           |
                                           v
                            OpenAI Responses API (server request)
                              model: gpt-5.6-luna, tier: fast
                              hosted: web_search
                              input: text + optional input_image
                              local: five causal read functions
                                           |
                      streamed progress + cited rich final response
                                           |
                                durable Telegram outbox
```

Каждый Telegram turn начинается с локально собранного causal context packet.
Custom-function continuations относятся только к этому turn; долговременная
chat continuity остаётся в SQLite/RAG, а не в бесконечной provider chain.
Developer instructions и tool policy передаются заново в каждый continuation.

## Implementation Checklist

1. [x] Зафиксировать Git archaeology и контракт прямого Responses loop без
   восстановления Hermes, ModelRouter, SearXNG или Firecrawl.
2. [x] Добавить официальный OpenAI SDK и прямой streaming transport с hard-pinned
   Luna/fast, abort/timeout, bounded custom-tool loop и typed failure mapping.
3. [x] Подключить hosted `web_search` в каждый server request, отобразить hosted
   lifecycle в Telegram progress и безопасно отрендерить web citations.
4. [x] Реализовать новый causal RAG packet с bounded recent/reply context,
   deterministic intent routing, hybrid retrieval, digest routing, timeout и
   graceful BM25/recent-only degradation; сохранить ровно пять local tools.
5. [x] Вернуть bounded Telegram image ingestion: trigger/one-hop reply, getFile,
   redirect-free download, size/MIME/decoder validation, in-memory data URL и
   прямой `input_image` в Responses request.
6. [x] Заменить Codex agent composition/config/preflight на Responses agent,
   сохранив durable poller, split HTTP pools, typing, progress и Rich Messages.
7. [x] Перевести digest/Dream maintenance на общий Luna/fast Responses transport;
   удалить production coupling к Codex app-server, оставив rollback material.
8. [x] Добавить systemd `LoadCredential`, owner-only key reader, examples/docs/ADR
   и fail-closed preflight без утечки credential.
9. [x] Пройти focused offline fake-stream tests, temp-DB/rollback rehearsal,
   безопасный `npm run verify:responses`, secret scan и normal-host service
   checks без перезаписи rollback `dist/` работающего owner.
10. [ ] После provision отдельного API key сделать backup, exclusive cutover и
    минимальный live E2E: обычный reply, hosted web/open, image vision, RAG,
    visible typing/progress и Rich Message final.

## Target Files

- Responses runtime: новые `src/openai-responses/**`, новый bot agent adapter,
  `src/bot-daemon/{composition,contracts,production,preflight}.ts`.
- RAG: новые `src/bot/causal-rag/**`, `src/bot/read-cache.ts`, vector config
  seams и focused tests.
- Media/Telegram: `src/bot/media/**`, `src/bot/media-tools.ts`,
  `src/bot/{telegram-bot-api,telegram-http}.ts`, worker context и tests.
- Maintenance: `src/digest/**`, `src/digest-cli/**`, `src/dream/**` and tests.
- Runtime/deploy: `src/bot/runtime-config/**`, `bin/parilka-*`,
  `config/parilka-*.env.example`, `systemd/parilka-*.service`, docs/ADR/gates.
- Preserve: SQLite user data, MTProto sync/MCP ownership, BGE-M3 service,
  current Telegram durability and unrelated user-owned dirty changes.

## Verification Commands

```bash
npm run check
npm run check:shell
npm run check:architecture
npm run check:systemd
node --test --test-concurrency=1 --import tsx tests/responses-*.test.ts tests/bot-*.test.ts tests/media-*.test.ts
npm run verify:responses
git diff --check
```

Дополнительно: fake Responses streams без live provider calls; key-path and
redaction tests; temp SQLite quick-check/backup restore; normal-host
preflight/journal; после credential provision — маркированные live text,
web/open, image и causal-history E2E.

## Current Verification Status

- `npm run verify:responses` — green. Он включает typecheck, shell/Node syntax,
  architecture (240 production / 140 test files), все systemd units, 754/754
  offline TypeScript tests, 48/48 BGE-M3 contract tests, retrieval recall@5
  `0.944` при target `0.75`, secret scan 607 файлов, mtcute/source/direct MCP
  smokes, `npm audit` с 0 vulnerabilities и финальный immutable build.
- Активный staging release:
  `20260827110550156-2202867-8b54e1d22b51`; директория `0555`, entrypoints и
  `RESPONSES_SOURCE_MANIFEST.json` — `0444`. Launcher сверяет детерминированный
  SHA-256 manifest runtime source/config/package inputs перед запуском;
  `dist/` работающего старого owner не изменён.
- Read-only live-DB RAG benchmark на 23 212 BGE-M3/1024 chunks: три полных
  BM25+dense+sparse+rerank запроса за `0.696–0.908 s`, по 8 evidence. Dense и
  sparse отсекают chunk до scoring только при `end_message_id < trigger`, так
  что crossing chunk не влияет на ranking/fusion/rerank; диагностический
  coverage scan удалён из search hot path, но сохранён в status/indexing API.
- Temp SQLite backup/restore rehearsal: `quick_check=ok` до и после,
  schema v23, повторное открытие идемпотентно. Queue typing, terminal progress
  retry под непрерывным backlog, rejected Bot API progress operations,
  rich/parser fallback, hosted web terminal events и direct image input имеют
  отдельные regression tests. Каждая completed Responses leg fail-closed
  проверяет exact Luna и effective fast tier; explicit web intent требует
  фактический `web_search_call`. Causal labels заменяются только безопасной
  host-rendered attribution без Telegram IDs или локальных путей.
- Normal host: старый `parilka-bot.service` остаётся active/enabled и исполняет
  rollback Codex build; `parilka-sync`, `parilka-bge-m3` и maintenance timer
  healthy. Staged Responses env slices — regular owner-only `0600`, bot slice
  безопасно оставлен `shadow` с пустым exclusive acknowledgement.
- Live Responses preflight/cutover намеренно не начаты: отдельный
  `~/.config/parilka/openai-responses-api-key` пока отсутствует. Установленный
  `parilka-bot-preflight.service` всё ещё относится к старому Codex runtime и
  будет заменён только после credential provision.

## Done Means

- Production bot и maintenance не запускают Codex app-server и не зависят от
  Hermes/SearXNG/Firecrawl/старого ModelRouter.
- Все model calls hard-pinned к `gpt-5.6-luna` и `service_tier=fast`; попытка
  подмены model/tier отклоняется config/preflight.
- Hosted web search реально передаётся в Responses request, его progress виден
  в Telegram, а подтверждённые citations кликабельны в Rich final.
- Image из trigger/reply проверяется и идёт напрямую как `input_image`; typing
  появляется сразу, progress корректно обновляется/удаляется, секретные
  Telegram identifiers не попадают в provider input или logs.
- Новый RAG causal, bounded и graceful-degrading; пять local tools остаются
  read-only и не дают модели подделать chat/source/cutoff.
- Full verification зелёная, rollback проверен, live unit healthy и
  маркированные E2E имеют terminal `sent` без duplicate delivery.

## Copy-Ready Goal Prompt

Продолжай Goal 007 до полного рабочего production deploy. Сначала читай
`AGENTS.md`, этот TODO, `operations/RESPONSES.md` и релевантные ADR. Не возвращай
Hermes, SearXNG, Firecrawl или старый ModelRouter. Сохраняй dirty-worktree,
single-owner, secret-isolation и no-commit/no-push границы. Не закрывай goal до
зелёного `npm run verify:responses`, безопасного credential provisioning, backup,
exclusive cutover и живых text/web/image/RAG E2E.
