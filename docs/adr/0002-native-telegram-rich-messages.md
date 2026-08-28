# ADR 0002: нативные Telegram Rich Messages для финального ответа

- Статус решения: принято
- Состояние реализации: deployed; live Telegram Desktop E2E verified
  2026-07-31
- Дата решения: 2026-07-31

## Контекст

Финальный ответ бота до goal 005 отправлялся через classic
`sendMessage(text, { entities })` с локально вычисленными
`MessageEntity`. Классические entities не выражают semantic table или
mathematical-expression entity, поэтому отклонённый goal 004 вручную
превращал Markdown-таблицы в ASCII-блоки `pre`, а LaTeX оставался сырой
строкой. Screenshot fixture подтверждал не-Rich вывод: моноширинный блок с
copy icon и литералы `$E = mc^2$`, `$$\int_a^b f(x)\,dx$$`.

Параллельно был доказан ряд регрессий hand-rolled parser:
suffix после unsafe link терялся, list items дублировались, `2 * 3 * 4`
становилось ложным italic, соседние `***...***` стилизовали промежуток,
credential URL проходил как safe, незакрытый fence считался валидным `pre`.

Bot API 10.1+ (2026-06-11) добавил Rich Messages и `sendRichMessage`:
Telegram сам рендерит headings, ordered/unordered/task lists, GFM-таблицы,
footnotes, inline `$...$`, block `$$...$$` и fenced `math`. Установленный
`grammy@1.45.1` уже предоставляет `Api.sendRichMessage` и тип
`InputRichMessage` без обновления dependency.

## Решение

Основной путь финальной доставки — нативный `sendRichMessage` с
`InputRichMessage.markdown`:

```text
model final Markdown + telemetry footer
  -> TelegramPublication (транспортный контракт без content policy):
     обычный ответ — исходный Markdown;
     local audio или >32768 UTF-8 bytes — plain publication
  -> rich:  { markdown, plainText }
       plain: { plainText }
  -> saveBotTurnDraft(plainText)
  -> существующий durable sending fence
  -> rich: Api.sendRichMessage(chatId,
       { markdown, skip_entity_detection: true },
       { reply_parameters }, signal)
       └─ только однозначный parser-related 400 до ACK (ровно один раз)
          -> splitTelegramText(plainText, 4096) -> Api.sendMessage последовательно
  -> validate ACK -> recordOwnSend(canonical plainText) -> sent
       timeout/network/malformed ACK/partial/post-ACK DB error -> lost_ack
```

### Почему markdown, а не blocks

Явные `InputRichBlock*` полностью исключают серверный Markdown parse, но
требуют локально реализовывать и сопровождать GFM+math parser-to-block
mapping. Это повторяет основную ошибку 004 (локальный «почти GFM» движок) и
отклоняется. Classic entities как primary отклонены: они принципиально не
выражают native table и formula.

### Transport boundary

Локальный код не рендерит, не разбирает и не переписывает Markdown модели.
Обычный финал передаётся Telegram нативно как есть. `skip_entity_detection:
true` остаётся параметром Rich Messages, а не локальной policy-проверкой;
текстовая публикация выбирается только для local audio и для ответа длиннее
документированного Rich Message лимита Telegram в 32768 UTF-8 bytes. Если
Rich API отклоняет payload до ACK по причине разбора, plain fallback по-прежнему
использует классический лимит 4096 UTF-16 единиц.

### Canonical plain text

Для Rich publication `plainText` совпадает с исходным финальным текстом и
питает `saveBotTurnDraft`, corpus recording и classic fallback. Durable
adapter записывает его, а не `response.text`: rich ACK несёт `rich_message`,
а не `text`.

### Failure semantics

- Однозначный parser-related Bot API 400 (`can't parse markdown|rich
  message|entities`, `invalid rich message`) **до ACK** может ровно один раз
  открыть классический plain fallback; fallback шлёт полный canonical
  plainText, lossless разбитый до 4096 UTF-16.
- Generic 400 не маскируется под parse failure.
- Timeout, `HttpError`/socket, aborted signal, malformed success, partial
  delivery и post-ACK DB failure никогда не вызывают resend и сохраняют
  существующую `lost_ack` semantics.

## Следствия

- Hand-rolled GFM lexer/render/chunk (`src/bot/rich-text/`) и content-policy
  preflight удалены: Telegram остаётся единственным Markdown renderer.
- `grammy-publisher.ts` держит узкий двухоперационный порт
  (`sendRichMessage` primary, `sendMessage` plain fallback); production
  adapter использует типизированный `Api.sendRichMessage`, без raw `fetch` и
  ручных токенов.
- Финальный Markdown не проходит локальный content filter: формат и
  допустимость конструкций интерпретирует сам Telegram Rich Messages API.
- Live Telegram Desktop E2E подтвердил нативную таблицу-сетку и
  inline/block formulas.

## Альтернативы

- `InputRichBlock*` — отклонено (локальный parser-to-block движок).
- Classic `sendMessage + MessageEntity` как primary — отклонено (нет native
  table/formula).
- Стриминг (`sendRichMessageDraft`), Rich HTML, media attachments, collage/
  slideshow, maps и model-controlled uploads — non-goals этого решения.
