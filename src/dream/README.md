# Dream offline memory consolidation

`src/dream/` — offline pass, который запускается внутри `parilka-digests` и
обновляет семантический слой `bot_chat_memory` (и при необходимости
fast/lessons/skills) на основе реальных bot-reply interactions.

## Public facade

- `DreamConsolidator` (`consolidator.ts`) — единственная точка входа для одного
  чата. Принимает `DigestModelRouter`, `botSenderId` и bounded опции; метод
  `run(chatId)` последовательно обрабатывает запланированные дни oldest-first.
- `planDreamDayJobs` / `seedDreamDaysIfEmpty` (`planner.ts`) — idempotent
  планировщик. Bootstrap создаёт ровно 7 `pending` дней (`today-7 .. yesterday`
  в Moscow time zone); повторные запуски добавляют пропущенные даты и retry
  `failed`/`running`.
- `selectDreamInteractions` (`selector.ts`) — global-window selector: только
  candidate bot-ответы целевого Moscow day (граница — Moscow midnight через
  `dayStartInstant`), first-chunk проверка, exact trigger load, keyset pagination
  кандидатов без скрытого hard cap, 8 previous + все live сообщения от trigger
  через last bot chunk + 30 next live rows, consecutive chunk collection и overlap
  merge с сохранением всех trigger/answer markers.
- `projectDreamDay` (`projection.ts`) — deterministic NDJSON projection и
  hash; batching по целым merged windows (поле `batched`, не truncation);
  `interactionCount` — фактическое число interactions до merge.
- `runDreamReview` (`review.ts`) + `buildReviewToolSet` (`review-tools.ts`) —
  восемь review tools: search long memory, load skill, remember fast,
  remember lesson, save skill, delete fast, delete lesson, delete skill.
  Только Dream имеет доступ к destructive tools (delete_*); live bot tools
  ограничены create/update/search.
- `shortenDreamMemoryBlock` (`shorten-memory.ts`) — tool-free shortening
  oversized final с bounded retries внутри каждого router candidate
  (`stopWhen: () => false`, no tools, SDK `maxRetries=0`).
- `StagedKnowledgeOverlay` (`staged-knowledge.ts`) — in-memory overlay:
  knowledge tools не пишут в SQLite во время generation; reads видят
  committed + staged, staged keys shadow committed. Day stage и все forks
  (включая discarded attempts) делят один monotonic logical clock, чтобы
  capacity pruning следовал tool-call order, а не lexicographic keys.
- `commitDreamDay` (`storage/dream-commit.ts`) — одна короткая SQLite-транзакция
  после model work: fast/lessons/skills + semantic memory/watermark + completed
  dream-day row; все writes обязаны совпадать с `day.chatId`.

## Invariants

- Никаких эвристик `day±N` и никаких full-chat scans.
- SQL date-range используется только для candidate bot-сообщений; весь контекст
  читается bounded `ORDER BY message_id DESC/ASC LIMIT`.
- Trigger загружается exact by id и валидируется: live, same chat, sender
  определён и не равен bot sender.
- Consecutive bot chunks с одним reply target группируются в один answer.
- Overlap merge сохраняет все `triggerMessageIds` и `answerMessageIds`, а также
  суммирует `rawInteractionCount`.
- Batching не разрезает окно; `batched: true` означает только разбиение дня на
  несколько целых merged windows, не truncation.
- **Staging / atomic commit:**
  - Knowledge tools мутируют только in-memory day stage (и attempt fork).
  - Каждый router candidate / internal retry получает свежий attempt overlay;
    writes от timeout, invalid output или failed candidate отбрасываются.
  - Только `finishReason === "stop"` + nonempty final merge'ит attempt в day stage.
  - Любой batch/shortening failure discard'ит весь day stage; в SQLite уходит
    только `status=failed` dream-day row. Semantic memory, fast, lessons и
    skills остаются byte-for-byte как до дня.
  - Tombstone support: overlay отслеживает явно удалённые ключи.
    Upsert того же ключа отменяет tombstone (revive). mergeFrom ordering:
    child upserts → parent tombstones отменяются; child tombstones →
    parent staged записи удаляются. Discarded child tombstones не текут.
  - Успех дня: один `commitDreamDay` (без nested BEGIN, Locked helpers) —
    fast/lessons/skills + memory/watermark + explicit deletions + completed
    day + per-day exact audit snapshot. Статус кроме `"completed"` отвергается
    до любых writes. Ключи upsert и delete не должны пересекаться.
    Никогда не держим DB transaction across model call.
  - Audit: канонический детерминированный JSON до 5 MiB с полными
    before/after записями (semantic memory, fast, lessons, skills:
    created с полным after, updated с парой {before, after}, deleted/evicted
    с полным before). Без raw prompts, секретов и tool payloads.
    Idempotent retry дня возвращает существующий StoredDreamDay без мутаций;
    если audit существует без completed day — corruption diagnostic.
    Audit создаётся для каждого completed дня, включая no-op и
    zero-interaction.
- Semantic memory заменяется, а не дополняется: review получает текущий/staged
  memory, возвращает final — весь новый блок; для нескольких batches каждый
  следующий видит staged final предыдущего и staged knowledge предыдущих
  batches. Empty day не меняет semantic memory.
- `stopWhen: () => false`, natural unlimited tool loop, bounded tool-free
  shortening retries при oversized final; string truncation модели запрещён.
  Каждый re-ask сжимает исходный блок заново (feedback несёт только длину
  предыдущего oversized ответа и hard max, не текст и не цепочку прошлых
  сокращений); empty/incomplete/oversized output считается invalid model
  output, content-filter остаётся terminal. После последней невалидной
  попытки machine code сохраняется (`shortening_output_too_large`,
  `empty_shortening`, `incomplete_shortening:<reason>`).
- Dream model deadlines — внутренние настроенные deadlines, не operator
  cancellation: ровно один candidate deadline на каждую внутреннюю попытку
  (review и shortening), один общий total deadline на весь вызов (review и
  shortening). Истечение всегда оборачивается явным `ETIMEDOUT` machine code
  с исходной abort-ошибкой в `cause`, поэтому router относит его к transport
  fallback, а не к terminal abort.
- Default `maxOutputTokens` = 8192; `maxMemoryChars` default/validate = 2000.
- Diagnostics: `ModelRoutingError` →
  `routerCode:lastAttemptDecisionReason:preferredMachineCode` (например
  `candidates_exhausted:invalid_output:shortening_output_too_large` или
  `candidates_exhausted:transport:ETIMEDOUT`). Outer/first semantic string
  code wins (ETIMEDOUT over nested ABORT_ERR or numeric DOM 20). Incomplete
  review/shortening включают `finishReason`. Без provider messages и секретов.
- Observability: production `parilka-digests` main wires
  `createLogger({ service: "cli" })` into `DreamConsolidator` via DI.
  Progress events (safe metadata only): `bot.dream.day_started`,
  `batch_started` / `batch_completed` / `batch_failed`, `day_completed`.
  Machine diagnostics log as `errorCode` (not `error`, which Pino serializes).
  No SQLite progress state; no message/memory/prompt/provider text.
- Retry идемпотентен: `attempts` не сбрасываются, upserts по title/name.
- Bot turns остаются assistant/own и не являются independent evidence.

## Focused gate

```bash
npx tsx --test tests/dream.test.ts tests/dream-memory.test.ts tests/dream-staging.test.ts tests/dream-commit.test.ts tests/dream-review-isolation.test.ts tests/dream-selector.test.ts tests/dream-selector-edge.test.ts tests/dream-diagnostics.test.ts tests/dream-timeout.test.ts tests/dream-shorten.test.ts tests/digest-cli-dream.test.ts tests/dream-audit.test.ts tests/dream-audit-storage.test.ts
```
