# Goal 001 evidence: peer comparison unified Parilka

> **2026-08-08: Custom bot runtime superseded by Hermes cutover.**
> The custom Bot API agent runtime (`src/bot/runtime.ts`, `src/bot/worker.ts`,
> `src/bot/turn-coordinator.ts`, `src/bot/ai-agent.ts`, `src/bot-daemon.ts`)
> has been removed and replaced by Hermes (`integrations/hermes/**`).
> File references below are historical; the architectural reasoning about
> bounded loops, SQLite state machines, one-client ownership, and narrow tool
> surfaces remains valid and was carried forward into the Hermes projection.

- Срез: 2026-07-30
- Объект: рабочее дерево `codex/unified-parilka`
- Метод: сравнение исходного кода, а не README-фич. Все ссылки на GitHub
  закреплены на SHA, актуальном на дату среза; официальная документация
  используется только для протокольных контрактов.

## Короткий вывод

TypeScript для объединённой Parilka остаётся правильным выбором. У Go заметно
сильнее готовый MTProto production pattern, но у Parilka transport — лишь одна
часть системы; Bot API, MCP, схемы инструментов и LLM routing уже живут в одном
TypeScript type graph. Переписывание всего на Go сейчас добавило бы больше glue
code и границ сервисов, чем надёжности.

Полезные внешние паттерны уже совпадают с направлением Parilka: быстрый durable
ingest до подтверждения update, ограниченная concurrency, один владелец
Telegram session, bounded agent loop, узкая model-facing tool surface и
структурные логи вне application-owned append-only файлов. Не стоит копировать
универсальные Telegram MCP с 80–102 tools, generic plugin framework, pool
авторизованных Telegram sessions или распределённую очередь для одного чата.

## Сравнение кода и trade-offs

| Область: паттерн у них | Решение у нас | Почему это практично и без оверинжиниринга |
|---|---|---|
| **Bot update и ACK.** Telegram считает update подтверждённым, когда следующий `getUpdates` вызван с большим `offset` ([Bot API](https://core.telegram.org/bots/api#getupdates)). Обычный grammY long polling ждёт handler последовательно ([исходник](https://github.com/grammyjs/grammY/blob/9f5474fc3a8aa6ee96fd2e178fd1f7e0b6617e38/src/bot.ts#L331-L347)). В Telegent handler сначала делает один-два LLM вызова, затем сохраняет память и отвечает ([исходник](https://github.com/telegent/telegent/blob/8976adba9ddec72b3c7a7b35512b4466a2b487eb/lib/Telegent.ts#L70-L145)). | `runtime.ts` вручную poll-ит Bot API и до сдвига offset атомарно записывает raw update, message и turn reservation в SQLite. `worker.ts` выполняет модель отдельно; `update_id` даёт idempotency. | Модель не держит polling loop десятки секунд, а crash не теряет уже подтверждённый turn. SQLite queue здесь решает реальную failure mode; Redis/BullMQ не дают дополнительной ценности одному локальному чату. |
| **Порядок и concurrency.** grammY runner предлагает concurrent sink, а конфликтующие updates сериализует по chat/user key через `sequentialize` ([исходник](https://github.com/grammyjs/runner/blob/fbe8cee2d41efb91c39ac104692f1ecdac4e014d/src/sequentialize.ts#L49-L89), [официальное объяснение](https://grammy.dev/plugins/runner#sequential-processing-where-necessary)). | `turn-coordinator.ts` держит независимые очереди turn, watermark и provenance `owner`/`ambient`; `runtime.ts` ограничивает workers тремя. | Для одного allowlisted group chat доменная fold-очередь точнее generic per-chat mutex. Runner стоит добавлять только при измеренном ingest backlog; сейчас ещё один scheduler затруднил бы crash reasoning. |
| **Agent/tool loop.** Telegent просит модель вернуть строку `@plugin:name action ...`, разбирает её через `split` и вызывает generic plugin ([исходник](https://github.com/telegent/telegent/blob/8976adba9ddec72b3c7a7b35512b4466a2b487eb/lib/Telegent.ts#L87-L113), [парсер/provider code](https://github.com/telegent/telegent/blob/8976adba9ddec72b3c7a7b35512b4466a2b487eb/lib/components/ai/AIHandler.ts#L79-L115)). AI SDK имеет reusable stop condition, но она считает SDK steps ([исходник](https://github.com/vercel/ai/blob/817910dfcff603c8164ecf7e85753d3e29d9a36e/packages/ai/src/generate-text/stop-condition.ts#L4-L29)). | `ai-agent.ts` использует schema-validated calls, общий лимит четырёх разрешённых executions сквозь provider fallback, затем forced final без tools. Модели видны только четыре read-only tools из [`read-tools.ts`](../../../../src/bot/read-tools.ts); есть total/step/tool deadlines. | Тонкий собственный loop нужен для fold routing, evidence и outbox semantics, которых SDK не знает. Generic plugin framework, shell и Telegram write tools модели не выдаются: меньше prompt-injection surface и меньше неявных переходов состояния. |
| **Смена LLM provider.** Telegent выбирает `claude \| deepseek`, но model IDs и DeepSeek endpoint зашиты в constructor ([исходник](https://github.com/telegent/telegent/blob/8976adba9ddec72b3c7a7b35512b4466a2b487eb/lib/components/ai/AIHandler.ts#L10-L41)). AI SDK registry нативно адресует модели как `provider:model` ([исходник](https://github.com/vercel/ai/blob/817910dfcff603c8164ecf7e85753d3e29d9a36e/packages/ai/src/registry/provider-registry.ts#L124-L168)). | На момент этой исторической проверки `model-router.ts` валидировал JSON/Zod config, брал secrets и custom headers только из env и задавал ordered candidates по ролям `turn` и `summary`. В Codex migration этот retired слой удалён; текущий production path использует только private Codex app-server. | Тогда provider или endpoint менялся конфигом и рестартом процесса. Исторический trade-off сохранён как evidence; он не описывает текущую production-архитектуру. |
| **Размер MCP tool surface.** `mcp-telegram` регистрирует 102 Telegram tools и прямо отмечает около 12 700 tokens схем в каждом agent context ([исходник/README](https://github.com/tacticlaunch/mcp-telegram/blob/f61b257a89b21a1f42a98bbefcbf7a24a83a53d8/README.md#L30-L34), [каталог](https://github.com/tacticlaunch/mcp-telegram/blob/f61b257a89b21a1f42a98bbefcbf7a24a83a53d8/src/tool-catalog.ts#L32-L113)). Его registry умеет allow/deny и отключает `regWrite` в readonly mode ([исходник](https://github.com/tacticlaunch/mcp-telegram/blob/f61b257a89b21a1f42a98bbefcbf7a24a83a53d8/src/tools/_registry.ts#L29-L120)). Chigwell аналогично удаляет всё без `readOnlyHint`, оставляя опциональный write allowlist ([исходник](https://github.com/chigwell/telegram-mcp/blob/89d6badf3263a8bd9729fd9e95fe534f656ead64/telegram_mcp/runtime.py#L151-L220)). | Human-facing [`tools.ts`](../../../../src/tools.ts) содержит 13 операций вокруг одного corpus/chat; bot получает не MCP surface, а четыре прямых library calls. MCP writes по умолчанию hard dry-run, используют allowlist, preview capability и optional durable dedupe. Отдельной human-approval policy нет. | Parilka не является Telegram admin console. Узкая поверхность дешевле по context, проще покрывается тестами и ограничивает blast radius. Разделение «13 для оператора / 4 read-only для модели» полезнее динамической загрузки сотни схем. |
| **Telegram write safety.** У обоих универсальных MCP readonly в первую очередь управляет регистрацией tools; Chigwell отдельно предупреждает, что Telegram session внутри процесса всё равно сохраняет полную власть ([исходник/README](https://github.com/chigwell/telegram-mcp/blob/89d6badf3263a8bd9729fd9e95fe534f656ead64/README.md#L116-L140)). `mcp-telegram` write handler после gate идёт непосредственно в Telegram ([исходник](https://github.com/tacticlaunch/mcp-telegram/blob/f61b257a89b21a1f42a98bbefcbf7a24a83a53d8/src/tools/messages-write.ts#L15-L48)). | MCP send использует durable dedupe outbox, а bot turn проходит `drafted → sending → sent` либо terminal `lost_ack` в [`store.ts`](../../../../src/store.ts) и `worker.ts`. Неоднозначная ошибка после dispatch не ретраится автоматически. | Это немного больше кода, чем прямой `sendMessage`, но устраняет самый дорогой локальный баг — двойную отправку после timeout/crash. Отдельный broker или distributed transaction не нужен: один SQLite state machine достаточен. |
| **MTProto client ownership.** `mcp-telegram` кэширует `TelegramClient` только внутри одного stdio процесса ([исходник](https://github.com/tacticlaunch/mcp-telegram/blob/f61b257a89b21a1f42a98bbefcbf7a24a83a53d8/src/telegram.ts#L50-L74)). Chigwell, наоборот, раздаёт конкурентным MCP процессам pool разных auth sessions под advisory locks ([исходник](https://github.com/chigwell/telegram-mcp/blob/89d6badf3263a8bd9729fd9e95fe534f656ead64/telegram_mcp/runtime.py#L331-L402)). mtcute уже содержит flood-wait middleware ([исходник](https://github.com/mtcute/mtcute/blob/42538c29887949aa5799a9a199b30df2f9d59ef0/packages/core/src/network/middlewares/flood-waiter.ts#L64-L159)) и update gap recovery ([исходник](https://github.com/mtcute/mtcute/blob/42538c29887949aa5799a9a199b30df2f9d59ef0/packages/core/src/highlevel/updates/manager.ts#L323-L363)). | [`sync-daemon.ts`](../../../../src/sync-daemon.ts) теперь является единственным штатным owner: он создаёт mtcute gateway, syncer, send scheduler и loopback MCP. [`index.ts`](../../../../src/index.ts) по умолчанию только проксирует stdio к owner и не открывает Telegram/SQLite. Daemon/once требуют точного operator acknowledgement `PARILKA_MTPROTO_EXCLUSIVE_OWNER=true`; `--direct` явно оставлен для recovery при остановленном daemon; GramJS — rollback transport. | Не нужен session pool для одного аккаунта: один долгоживущий owner уже устраняет конкурирующие auth clients, сохраняя stdio UX для harnesses. Операционный риск теперь не gap в gateway, а неверный одновременный запуск владельцев; daemon/once fail closed, а direct recovery остаётся под явным runbook-инвариантом. |
| **MCP transport.** Chigwell запускает stateless HTTP ([исходник](https://github.com/chigwell/telegram-mcp/blob/89d6badf3263a8bd9729fd9e95fe534f656ead64/telegram_mcp/runtime.py#L113-L116)); `mcp-telegram` остаётся stdio ([исходник](https://github.com/tacticlaunch/mcp-telegram/blob/f61b257a89b21a1f42a98bbefcbf7a24a83a53d8/src/index.ts#L21-L33)). Спецификация MCP 2026-07-28 требует для локального Streamable HTTP localhost binding и Origin validation, убирает protocol sessions и использует закрытие request-scoped SSE как cancellation ([официальный текст](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security--endpoint)). MCP TypeScript SDK v2 стал stable 2026-07-28, а v1 ещё получает fixes минимум шесть месяцев ([исходник](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/README.md#L4-L9)). | Parilka пока использует v1 session-scoped Streamable HTTP у sync owner на `127.0.0.1:8766/mcp` и тонкий stdio proxy. В этой версии session позволяет отдельному POST `notifications/cancelled` достичь AbortController исходного запроса; signal проходит до serialized history lane. [`mcp-loopback.ts`](../../../../src/mcp-loopback.ts) ограничивает bind, Host и Origin, максимум sessions и idle TTL; GET отключён, DELETE делает graceful cleanup. Это явно legacy-compatible transport: полная совместимость со спецификацией 2026-07-28 до отдельной v2 migration не заявляется. | HTTP здесь нужен не для «микросервисности», а чтобы несколько harnesses не создавали несколько MTProto clients. Session registry ограничен и живёт только в owner process; Redis, reverse proxy и OAuth на loopback не нужны. Переход на v2 следует делать отдельным transport slice, потому что меняется сам cancellation contract, а не только import path. |
| **Memory/RAG.** Telegent хранит сообщения в SQLite, но для similarity читает весь chat, считает cosine и сортирует в памяти ([исходник](https://github.com/telegent/telegent/blob/8976adba9ddec72b3c7a7b35512b4466a2b487eb/lib/components/memory/MemoryManager.ts#L27-L109)); его «embedding» — локальный word hash на 1536 buckets ([исходник](https://github.com/telegent/telegent/blob/8976adba9ddec72b3c7a7b35512b4466a2b487eb/lib/components/ai/AIHandler.ts#L170-L195)). | [`read-cache.ts`](../../../../src/bot/read-cache.ts) использует тот же canonical messages store, FTS candidates и bounded vector candidates с hybrid fusion. Digest и tombstone state также в versioned SQLite. | Существующий corpus уже требует этого уровня. При этом отдельный vector service и approximate index не вводятся, пока bounded exact scan проходит измерения; источник истины остаётся один. |
| **Логи и retention.** Chigwell пишет JSON errors в `mcp_errors.log` через append-only `FileHandler` без rotation в этом коде ([исходник](https://github.com/chigwell/telegram-mcp/blob/89d6badf3263a8bd9729fd9e95fe534f656ead64/telegram_mcp/runtime.py#L581-L615)). Go `gotd` example, напротив, явно задаёт file rotation ([исходник](https://github.com/gotd/td/blob/d0d567ee95e61e991eb4075eeb75b16ddc973801/examples/userbot/main.go#L86-L115)). Pino официально поддерживает JSON destination в stderr ([исходник](https://github.com/pinojs/pino/blob/d514a8a1119fd4fa1d55d80022336c1329f9b292/docs/api.md#L631-L653)), а journald ограничивает объём и retention ([официальный manpage](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)). | [`logger.ts`](../../../../src/observability/logger.ts) уже подключён к bot, sync и MCP entrypoints: redacted Pino JSON идёт только в stderr, а user units направляют его в journald. Старого gap в entrypoints больше нет. Standalone CLI и несколько fallback diagnostics могут печатать собственный JSON/короткий stderr, но append-only application log transport отсутствует. | Получаем `journalctl --user -u … -f` и bounded disk usage без собственного log shipper. OpenTelemetry/ELK и второй rotating-file transport для одного хоста пока не оправданы. |

## TypeScript против Go

| Критерий | TypeScript + mtcute/grammY/AI SDK/MCP | Go + gotd |
|---|---|---|
| MTProto | mtcute уже даёт flood wait, update recovery и structured logger bridge; поверх него у Parilka остаются собственные bounded policies. | `gotd` production-like example сразу соединяет private session, peer storage, persistent update state, rate/flood middleware и log rotation ([исходник](https://github.com/gotd/td/blob/d0d567ee95e61e991eb4075eeb75b16ddc973801/examples/userbot/main.go#L86-L173)). Здесь Go объективно сильнее. |
| Bot API и agent loop | grammY update types, AI SDK schemas/tool calls и MCP/Zod находятся в одном runtime и переиспользуют DTO без RPC boundary. | Понадобится либо писать provider/tool orchestration заново, либо оставить Node agent рядом и ввести IPC между двумя сервисами. |
| Ошибки и cancellation | `AbortSignal` проходит через model, read tools, embeddings и Telegram wrappers; typed errors остаются TypeScript unions. | `context.Context` и compile-time interfaces очень хороши, но выгода проявится только если большая часть pipeline также переедет в Go. |
| Операционный объём | Два долгоживущих user services, maintenance oneshot/timer и один SQLite; один язык/lockfile/build. | Полный rewrite создаст два миграционных риска сразу: язык и Telegram transport. Отдельный Go MTProto worker добавит ещё binary, protocol и deploy lifecycle. |
| Решение | Основной стек остаётся TypeScript. | Рассматривать только отдельный MTProto worker после измеренного доказательства: устойчивый backlog, memory/CPU regression или reconnect/update-loss, которые mtcute не исправляет. |

## Что заимствовать, а что не переносить

Два прежних архитектурных разрыва закрыты:

1. loopback MCP и thin stdio proxy уже обеспечивают одного штатного MTProto
   owner;
2. bot/sync/MCP entrypoints уже используют общий Pino logger, а user units —
   journald.

До live cutover остаются не gateway/Pino TODO, а операционные и явно
непостроенные части:

1. snapshot/import rehearsal уже пройден; пройти controlled shadow и
   post-live rollback rehearsal из
   [migration runbook](../../../../operations/MIGRATION.md);
2. не выдавать self-issued `approval_id` за human approval — отдельной policy
   реализации нет;
3. заимствовать у Chigwell маркировку Telegram/tool output как user-controlled
   content ([исходник](https://github.com/chigwell/telegram-mcp/blob/89d6badf3263a8bd9729fd9e95fe534f656ead64/telegram_mcp/runtime.py#L118-L148)),
   если MCP SDK annotations будут добавлены; bot prompt уже использует
   untrusted-data envelope;
4. оставить MCP SDK v2 migration отдельным изменением;
5. не обещать автоматические month digests/backups, atomic vector staging,
   native Vertex/Gemini или Python outbox migration — их в текущем коде нет;
   day/ISO-weekly job уже реализован.

Осознанно не переносить:

- 80–102 Telegram tools и raw MTProto escape hatch;
- generic plugins или model-visible write/filesystem/shell;
- несколько Telegram auth sessions ради конкурентных stdio процессов;
- Redis/Kafka/BullMQ, отдельный vector DB и централизованный log stack;
- переписывание всего приложения на Go без измеренного transport bottleneck.

Итоговый критерий простой: новый слой допустим, только если он закрывает
наблюдаемую failure mode. Durable SQLite state machines, one-client ownership и
bounded retries этому критерию соответствуют; перечисленная платформенная
инфраструктура — нет.
