# Digest slice

`src/digests.ts` остаётся стабильным public barrel. Реализация разделена по
фазам:

- `source.ts`, `planner.ts`, `calendar.ts` — canonical message source,
  invalidation plan и Moscow calendar boundaries;
- `day-phase.ts`, `week-phase.ts` — последовательные state transitions;
- `generation-support.ts`, `summary-port.ts` — bounded provider call и
  атрибуция результата;
- `process-lock.ts` — один локальный apply owner;
- `types.ts`, `generator.ts` — public contracts и orchestration.

Инварианты:

- dry-run не вызывает provider и не мутирует state;
- dry-run планирует весь backlog независимо от apply generation limits;
- apply последовательно выбирает newest due days/weeks и отдельно ограничивает
  их summary calls; превышение становится `deferred/run_limit`;
- deferred legacy day/week rows не удаляются и продолжают читаться, а week с
  deferred day не инвалидируется только из-за run limit;
- текущий Moscow day по умолчанию не генерируется;
- append threshold допустим только после доказательства неизменного prefix;
  edit/delete/backfill исторического prefix немедленно инвалидирует digest;
- source hash и prompt version перепроверяются после model call перед commit;
- weekly rollup не публикуется при missing/failed/stale required day;
- автоматического month generation нет.

Добавление нового периода требует отдельного planner/phase и storage contract,
а не новых веток внутри day/week orchestration.

Focused gate:

```bash
node --test --import tsx tests/digest-generation.test.ts \
  tests/digest-limits.test.ts tests/digest-store.test.ts
```
