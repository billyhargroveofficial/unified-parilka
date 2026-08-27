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
- Пользователь 2026-08-27 явно разрешил commit и push repo-owned изменений
  Goal 007. Удаление rollback/state backups по-прежнему не разрешено.
- Секреты subscription OAuth нельзя печатать, логировать или добавлять в Git;
  production использует отдельную owner-only копию auth state, а не shared
  runtime-сессию Codex CLI.

## Source Research Summary

- Git anchor: `a61d187` — последний полный TypeScript agent loop до Hermes.
  Он используется только как behavioral source: старые ModelRouter,
  SearXNG/Firecrawl и AI SDK не возвращаются.
- Текущая dirty реализация уже содержит сильный durable Bot API poller,
  outbox/retry fences, split HTTP lanes, typing, one-bubble tool progress,
  Rich Messages и causal cache tools. Эти слои остаются; заменяется agent/model
  boundary и Codex-specific maintenance adapters.
- Official OpenAI model docs подтверждают, что `gpt-5.6-luna` поддерживает
  Responses, streaming, image input, function calling, hosted web search и
  `reasoning.effort: "xhigh"`. Fast product policy у subscription backend
  передаётся как wire `service_tier: "priority"`.
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
  causal digest только при temporal intent; шесть read-only function tools
  остаются для углубления. Везде cutoff строго `< trigger message id`.
- Direct transport использует отдельную writable owner-only копию Codex
  subscription OAuth state. Hermes, Codex CLI и app-server не участвуют в
  model path; refresh/recovery остаётся внутри узкого TypeScript transport.

## Product Shape

```text
Telegram Bot API -> durable TS worker -> causal RAG/context builder
                                           |
                                           v
                     Codex subscription Responses (server request)
                              model: gpt-5.6-luna, tier: fast/priority
                              effort: xhigh
                              hosted: web_search
                              input: text + optional input_image
                              local: six causal read functions
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
   graceful BM25/recent-only degradation; сохранить ровно шесть local tools.
5. [x] Вернуть bounded Telegram image ingestion: trigger/one-hop reply, getFile,
   redirect-free download, size/MIME/decoder validation, in-memory data URL и
   прямой `input_image` в Responses request.
6. [x] Заменить Codex agent composition/config/preflight на Responses agent,
   сохранив durable poller, split HTTP pools, typing, progress и Rich Messages.
7. [x] Перевести digest/Dream maintenance на общий Luna/fast Responses transport;
   удалить production coupling к Codex app-server, оставив rollback material.
8. [x] Добавить owner-only subscription auth state, examples/docs/ADR и
   fail-closed preflight без утечки credential.
9. [x] Пройти focused offline fake-stream tests, temp-DB/rollback rehearsal,
   безопасный `npm run verify:responses`, secret scan и normal-host service
   checks без перезаписи rollback `dist/` работающего owner.
10. [x] Сделать backup, exclusive cutover и
    минимальный live E2E: обычный reply, hosted web/open, image vision, RAG,
    visible typing/progress и Rich Message final.
11. [x] Переключить interactive Luna на hard-pinned `xhigh`; отображать
    provider `action.queries[]` и параллельные hosted items как компактные
    `web_search ×N` / `web_fetch ×N` строки, сохраняя late relabel по call id.
12. [ ] Устранить подтверждённые long-tail defects: bounded Telegram progress
    I/O на terminal path, уникальный per-request correlation id и отдельный
    synthesis/no-progress watchdog для bounded research; затем повторить
    timeout/deep-research E2E.

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

- `npm run verify:responses` повторно green 2026-08-27 после xhigh/batch
  изменений: typecheck, shell/architecture/systemd, полный offline test suite,
  48/48 BGE-M3 contract tests, retrieval recall@5 `0.944` при target `0.75`,
  secret scan, mtcute/MCP smokes, `npm audit` с 0 vulnerabilities и immutable
  release build.
- Production `parilka-bot.service` исполняет release
  `20260827190248558-3286437-39e81926cd87`; preflight admitted exact
  `gpt-5.6-luna` + effective `priority`, runtime log фиксирует code-owned
  `reasoningEffort: "xhigh"`, один poller active, restart count 0.
- Live subscription shape probe вернул один `web_search_call` с четырьмя
  `action.queries`. Маркированный Telegram E2E поймал последовательные transient
  snapshots `web_search ×1` → `web_search ×4`, затем Rich final с footer
  `GPT-5.6 Luna Fast xhigh`; progress удалился штатно, все E2E trigger/final
  сообщения после проверки удалены и повторно отсутствуют в history.
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
- Normal host: `parilka-bot`, `parilka-sync` и `parilka-bge-m3` active; direct
  TypeScript Responses owner работает в live mode, legacy Hermes/Codex owner не
  участвует в production graph.

## Done Means

- Production bot и maintenance не запускают Codex app-server и не зависят от
  Hermes/SearXNG/Firecrawl/старого ModelRouter.
- Все interactive model calls hard-pinned к `gpt-5.6-luna`,
  `service_tier=fast` и `reasoning.effort=xhigh`; попытка подмены model/tier
  отклоняется config/preflight.
- Hosted web search реально передаётся в Responses request, его progress виден
  в Telegram, а подтверждённые citations кликабельны в Rich final.
- Image из trigger/reply проверяется и идёт напрямую как `input_image`; typing
  появляется сразу, progress корректно обновляется/удаляется, секретные
  Telegram identifiers не попадают в provider input или logs.
- Новый RAG causal, bounded и graceful-degrading; шесть local tools остаются
  read-only и не дают модели подделать chat/source/cutoff.
- Full verification зелёная, rollback проверен, live unit healthy и
  маркированные E2E имеют terminal `sent` без duplicate delivery.

## Copy-Ready Goal Prompt

Продолжай Goal 007 до устранения оставшихся production long-tail defects. Сначала читай
`AGENTS.md`, этот TODO, `operations/RESPONSES.md` и релевантные ADR. Не возвращай
Hermes, SearXNG, Firecrawl или старый ModelRouter. Сохраняй unrelated
dirty-worktree, single-owner и secret-isolation. Не закрывай goal до
bounded terminal progress I/O, корректного per-request correlation id,
synthesis watchdog, зелёного `npm run verify:responses` и повторного живого
deep-research E2E без зависшего progress/final tail.
