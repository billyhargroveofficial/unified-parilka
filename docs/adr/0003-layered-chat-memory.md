# ADR 0003: layered per-chat memory with explicit writes

- Статус решения: принято
- Дата решения: 2026-07-31

## Контекст

Периодическая Dream-консолидация уже поддерживает один компактный
`bot_chat_memory` блок на чат. Она полезна для долгого фона, но не даёт трёх
отдельных вещей: короткой явно сохранённой договорённости, точного
«проблема → решение → когда применять» и полного playbook, который не надо
всегда держать в prompt. Автоматически превращать каждую переписку или ответ
модели в долговременное правило нельзя: данные чата и результаты инструментов
недоверенны и могут содержать ошибку, prompt injection или секрет.

## Решение

Память остаётся строго chat-scoped и имеет четыре независимых слоя:

1. `bot_chat_memory` — существующий автоматический Dream-блок с watermark;
   он ограничен общим prompt budget и fail-closed при неудачной
   консолидации.
2. `bot_chat_fast_memory` — не больше 12 коротких заметок. Они eagerly
   попадают в следующий prompt и обновляются по нормализованному title.
3. `bot_chat_lessons` — не больше 64 устойчивых уроков с отдельными полями
   problem, solution и when-to-apply. Последние записи образуют компактный
   index; детали выдаёт bounded `search_long_memory`.
4. `bot_chat_skills` — не больше 32 playbook. Prompt получает только
   компактный index, а полный текст ровно одного навыка выдаёт
   `load_chat_skill`.

Все поля ограничены по размеру, ключи нормализуются, вероятные credentials
отклоняются, а запись хранит ID trigger-сообщения. Upsert и capacity pruning
выполняются под существующим `BEGIN IMMEDIATE` transaction kernel. Содержимое
каждого слоя маркируется в prompt как недоверенные данные и никогда не меняет
инструкции модели.

Модель получает memory reads на обычном ходу. Write tools
(`remember_fast`, `remember_lesson`, `save_chat_skill`) появляются только
когда **адресное trigger-сообщение** прямо просит запомнить, сохранить или
обновить память/урок/навык и его numeric Telegram sender есть в закрытом
operator-configured allowlist из private env. Этот список не раскрывается
модели; gate проверяется до выдачи tool и при его исполнении. Folds, результаты
поиска, ранее сохранённая память и загруженный skill этот gate поднять не могут.
Успешный tool call обязан подтвердить сохранённое правило в финальном ответе.

## Реализация Dream-консолидации

Dream работает как offline pass внутри `parilka-digests`. Review-модель
получает строго пять review tools и пишет fast/lessons/skills только в
изолированный in-memory day stage, не в SQLite. Успешный полный день атомарно
commitит staged knowledge + semantic memory + dream-day row одной короткой
транзакцией; любой failure дня отбрасывает stage целиком, поэтому persisted
knowledge, memory и watermark не меняются. Live-правило «write tools только по
адресному запросу авторизованного участника» относится к обычному ходу бота и
не применяется к offline Dream-review: у Dream собственный детерминированный
вход (bot-reply interactions дня) и собственный fail-closed commit.

- Планировщик при первом виде чата создаёт ровно 7 `pending` календарных дней
  (`today-7 .. yesterday`) в Moscow time zone; старый semantic watermark не
  приводит к перепланированию всей истории. Повторные запуски идут oldest-first,
  включают `pending/failed/running` и добавляют пропущенные даты до вчерашнего.
- Один run последовательно обрабатывает все запланированные дни; при ошибке
  любого дня остановка происходит до первого failed, уже завершённые ранние дни
  сохраняются. Пустой день завершается без model call.
- Селектор не использует календарную эвристику `day±N`. Candidate bot-ответы
  ищутся только SQL-диапазоном по собственной `date` целевого Moscow day. Для
  каждого candidate проверяется, что непосредственное предыдущее live сообщение
  не является продолжением interaction другого дня (тот же bot sender и тот же
  `reply_to_message_id`). Trigger загружается exact by id и валидируется: live,
  same chat, sender определён и не равен bot sender. Удалённый, отсутствующий
  или собственный trigger делают interaction `incomplete`.
- Контекст окна строится строго по global live row order: 8 предыдущих live
  строк перед trigger, сам trigger, все live cached сообщения от trigger через
  последний consecutive bot chunk с тем же trigger, и 30 следующих live строк
  после последнего chunk. SQL использует `ORDER BY message_id DESC/ASC LIMIT`,
  без full-chat scan и без календарной отсечки; окно может пересекать сколько
  угодно календарных границ.
- Перекрывающиеся окна merge/dedupe по global order; сохраняются все
  `triggerMessageIds` и `answerMessageIds`/markers. Interaction day определяется
  date первого bot chunk.
- Projection — deterministic NDJSON по полям sender/date/text/replyTo/authorRole/
  isOwnTurn + все trigger/answer markers. Hash SHA-256 всего projection
  используется как `sourceHash` дня. Batching разбивает только по целым merged
  windows; окно никогда не режется. Поле `batched` (не `truncated`) отражает
  разбиение дня; `interactionCount` хранит фактическое число interactions до
  overlap merge.
- Review toolset строго из пяти инструментов: `review_search_long_memory`,
  `review_load_chat_skill`, `review_remember_fast`, `review_remember_lesson`,
  `review_save_chat_skill`. `review_search_long_memory` включает не только
  fast/lessons/skills, но и переданный текущий/staged `bot_chat_memory`.
- Semantic memory заменяется, а не дополняется: review получает текущий/staged
  memory и maxMemoryChars, prompt требует final — весь новый пересобранный блок
  без комментариев/заголовков, не длиннее maxMemoryChars. Для нескольких batches
  первый получает persisted memory, каждый следующий — staged final предыдущего.
  Если final превышает лимит, запускается tool-free shortening с bounded retries
  внутри каждого router candidate и повторной валидацией stop/nonempty/bound на
  каждой попытке; string truncation model output запрещён. Успешное сохранение
  staged full block и watermark
  применяется только после успеха всех batches дня; при failure persisted
  memory/watermark не меняются. Retry идемпотентен через существующие title/name
  upserts. `attempts` не сбрасываются, `completedAt`/`error` корректно
  очищаются/ставятся. Bot turns остаются assistant/own и не являются
  independent evidence.

## Следствия

- Бот может воспроизводимо использовать найденное решение в будущих ходах,
  не перегружая каждый prompt всеми деталями.
- Нет global/cross-chat memory, фонового self-modifying агента, отдельной
  vector/queue службы или автоматического извлечения «уроков» из model output.
- Любой участник чата по-прежнему может пользоваться bounded memory reads и
  получать ответы; право на явную durable запись отделено от права читать.
- Dream остаётся отдельной офлайн-консолидацией: operator allowlist не меняет
  её расписание, входные данные или watermark.
- Удаление или массовая правка memory остаются явной операторской процедурой;
  обычный model loop не получает такого права.
- Schema migration additive: новые таблицы и индексы создаются на writable
  open и проходят обычный SQLite schema validation.

## Альтернативы

- Один бесконечно растущий Dream prompt — отклонён: нет разделения hot facts,
  решений и playbook, а контекст не bounded по полезности.
- Автоматическая запись по любому решённому вопросу — отклонена: неверный
  вывод и injection получили бы durable effect.
- Глобальная shared memory или embeddings-first retrieval — отклонены: для
  одного чата нет доказанной failure mode, а chat boundary и простой
  deterministic upsert важнее.
