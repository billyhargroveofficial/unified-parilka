# ADR 0004: local BGE-M3 как целевой retrieval backend

- Статус решения: принято
- Дата решения: 2026-08-06

## Addendum 2026-08-27: production deployment

Оператор отдельно одобрил и включил поставляемый
`parilka-bge-m3.service`; он live на loopback `127.0.0.1:8767`, health
`ok`, contract `bge-m3-v1`, а штатный sync подтвердил completed embedding
batches. Утверждения ниже про disabled unit и пустой индекс фиксируют
pre-deployment snapshot исходного решения, а не current runtime. BGE остаётся
optional dependency без жёсткого systemd `Requires=`: при его недоступности
retrieval видимо деградирует до BM25.

## Контекст

Исторический retrieval использовал внешний OpenAI-совместимый dense
provider: индексация и каждый query отправляли кэшированный текст чата во
внешний API, а лексический канал ограничивался FTS5 BM25 без стемминга и
морфологии. Для русского Telegram-корпуса это даёт провалы на словоформах,
сленге и парафразах, сохраняет внешнюю зависимость на query-пути и не даёт
learned sparse/late-interaction каналов. Обсуждались варианты BGE-M3
(dense + sparse + ColBERT) и SPLADE-v3.

Проверено по первичным источникам: BGE-M3 распространяется под MIT,
поддерживает 100+ языков, до 8192 токенов и выдаёт dense (1024), обученные
sparse-веса и multi-vector/ColBERT одним проходом; официальная комбинация
`w0*dense + w1*sparse + w2*colbert`. SPLADE-v3 имеет лицензию
CC-BY-NC-SA-4.0 (non-commercial) и обучен только на английском MS MARCO,
поэтому для русского production-корпуса отклонён.

## Решение

Целевой production backend — локальный open-source BGE-M3
(`TELEGRAM_EMBEDDINGS_BACKEND=local_bge_m3`):

1. Операторский loopback-сервис `services/bge-m3` (Python, официальный
   FlagEmbedding, фиксированная модель `BAAI/bge-m3`) предоставляет bounded
   эндпоинты `/health`, `/encode` (dense + sparse одним проходом) и
   `/rerank` (только scores/order, без векторов). ML-импорт ленивый;
   wire-контракт тестируется без torch. Сервис не управляется репо как
   runtime-зависимость: unit shipped disabled, модельные артефакты не
   vendored, cutover требует отдельного одобрения.
2. Один encode-проход на батч: indexer получает dense и sparse вместе,
   каденция не делает второй model call. Коммит атомарный:
   `commitEmbeddingChunksIfCurrent` пишет dense-строку parent-чанка и
   postings `message_embedding_sparse_terms(chunk_id, token_id, weight)`
   только после source re-render/hash check в одной `BEGIN IMMEDIATE`
   транзакции. Postings принадлежат parent namespace/model; delete-триггер
   каскадирует их, dirty/stale chunks исключены из sparse-поиска.
3. `rag_bm25_search` объединяет три независимых канала — BM25, BGE dense,
   BGE learned sparse — детерминированным N-канальным RRF; payload несёт
   явный статус каналов. При недоступности локального сервиса поиск честно
   деградирует до BM25; `keyword_search` и `read_chat_slice` остаются
   provider-free и работают всегда.
4. ColBERT не хранится на корпус: допускается только bounded on-demand
   rerank top-K (≤ 32 кандидата, только query + тексты, детерминированный
   reorder). Timeout/malformed/unavailable сохраняет first-stage порядок и
   помечает rerank деградированным.
5. Внешний OpenAI-совместимый provider сохраняется как backward-compatible
   отключённая опция (`external_openai`), не как активная зависимость:
   без API key и с выключенным по умолчанию статусом.
6. Namespace включает backend, модель, размерность, нормализацию и sparse
   contract version; несовместимые индексы не смешиваются. Migration
   старых внешних векторов не требуется: в production
   `message_embedding_chunks` пуст (0 строк при ~234k сообщений), новый
   индекс строится backfill'ом с обычным estimate/confirmation gate.

## Следствия

- Текст чата не покидает машину при индексации и поиске; внешний API ключ
  для retrieval не нужен.
- Schema v21 additive: новая `WITHOUT ROWID` postings-таблица и индекс;
  существующие dense-таблицы и FTS не меняются.
- Появляется операторский Python-процесс вне двух long-lived Node owners;
  он не является частью репо-runtime и деградирует retrieval до BM25 при
  недоступности.
- Query-путь одного канала не имеет права ронять весь поиск: каждый канал
  деградирует независимо и видимо для модели.
- Model-facing tool names не раздуваются: `rag_bm25_search`,
  `keyword_search`, `read_chat_slice` сохранены.

## Альтернативы

- SPLADE-v3 как sparse-канал — отклонён: non-commercial лицензия и
  English-only обучение несовместимы с русским production-корпусом.
- Полная замена dense на BGE-M3 с немедленным хранением ColBERT на весь
  корпус — отклонена: multi-vector хранение на десятки GB и MaxSim по всей
  базе несоразмерны корпусу; rerank top-K закрывает ту же потребность.
- In-process ONNX-инференс в Node-процессах — отклонён на этой фазе:
  удвоение VRAM-владения между sync и bot owners и тяжёлый native dep без
  доказанной необходимости; операторский сервис повторяет уже принятый
  паттерн loopback-зависимостей (research gateway, STT).
