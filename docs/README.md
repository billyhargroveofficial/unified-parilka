# Parilka Architecture Docs

`docs/` содержит только стабильную архитектуру, контракты и принятые решения.
Active TODO, goal prompts, audit/research evidence, rehearsal logs и operator
runbooks находятся вне `docs/`.

Перед глубокой навигацией агент может прочитать [../llms.txt](../llms.txt).

## Canon

- [Architecture map](architecture.md): runtime lanes, dependency direction,
  ownership, state и verification map.

## Decisions

- [ADR index](adr/README.md): решения 0001–0004 и dated migration addenda.

## Outside `docs/`

- [Agent rules](../.agents/rules/README.md).
- [Operations](../operations/README.md): install, config, logging, migration
  и rollback.
- [Completed goal 001](../loop-develop/history/001-unified-parilka/001-todo.md):
  unification/decomposition review и deployment evidence.
- Domain-local README рядом с production-кодом описывают узкие public facades
  и invariants без повторения всей architecture map.
