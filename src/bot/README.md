# Bot module shape

The public entry points remain thin compatibility files:

- `runtime.ts` — durable Bot API ingestion, polling, worker admission, lifecycle,
  and grammY adapters.
- `read-tools.ts` — nine bounded evidence/read tools, including a native
  public-page fetcher and an optional Unix-socket client for the private HH
  research gateway. The client holds only a runtime socket path and accepts a
  strict anonymized disclosure envelope; it never knows a research root,
  manifest, database, credential or raw record. `keyword_search` and
  `read_chat_slice` are purpose-built cache-only tools: they never call a
  vector/embedding provider or Telegram, always exclude soft-deleted rows,
  and clamp their authoritative upper bound to the application-owned
  `sourceMessageId - 1` from the per-call options, never to a model-provided
  id. The same application-owned bound protects the other three chat-local
  reads: `rag_bm25_search` applies an exclusive `beforeId = sourceMessageId`
  to every retrieval channel (BM25, dense, learned sparse), `thread_context`
  never fetches rows at or above the trigger (a future center simply reports
  `centerFound: false`), and `day_digest` drops any day digest whose source
  ends at or above the trigger; under a weekly-preferring read it keeps the
  weekly rollups provably below the bound plus the safe day digests outside
  those proven weeks, so days of unsafe or still-partial weeks never
  disappear. The slice freezes that upper bound inside a
  versioned, strictly validated keyset cursor, so continuations stay stable
  against newer inserts. Projections remain bounded: ordinary tools keep the
  ~4 000-char cap, `keyword_search` uses a moderate 20 000-char cap, and
  `read_chat_slice` a 192 000-char cap for pages of at most 300 messages,
  with continuations following `coverage.nextCursor` while `hasMore` is
  true; metadata reports truncation and omission honestly.
- `worker.ts` — one durable turn from claim through the send fence.
- `grammy-publisher.ts` — the narrow Bot API port and publisher: primary native
  `sendRichMessage({ markdown, skip_entity_detection: true })`; classic
  `sendMessage` only for whole-message plain publications and the single
  parser-related 400 fallback before ACK. Timeout/network/malformed ACK/
  partial/post-ACK failures never resend.
- `ai-agent.ts` — the bounded, non-streaming model/tool loop. A complete turn
  has no whole-turn deadline and no fixed model/tool-step count ceiling. Each
  provider step and tool call remains individually timed and abortable, while
  provider payloads, tool projections and model context stay bounded.
  Research requests still require a minimum of four real
  evidence calls and allow up to two bounded continuation rounds if the model
  tries to finalise too early. The prompt separates external
  evidence (`web_search`/`static_page_fetch`/`paper_search`) from facts in this chat
  (`rag_bm25_search`/digest/thread) and never treats chat search as an automatic
  supplement to an external lookup. `research_lookup` is private evidence and
  the sole tool-specific data-disclosure boundary: its model-facing description
  forbids personal extraction, and the executor rejects such queries before the
  Unix socket; results are always paraphrased and generalized, never quoted or
  used to identify a person. Previous reasoning parts are compacted before the
  next model step; when the estimated context reaches roughly 600k tokens, the
  selected Qwen candidate summarizes old messages through the same provider,
  retaining recent tool results and a head/tail bounded source. The estimate
  uses a conservative serialized-character heuristic because the runtime has
  no provider tokenizer. A roughly 900k-token context guard can switch to a
  tool-free final pass. A provider `length` finish gets
  one additional tool-free finalization attempt before the turn is failed, and
  the default Qwen turn output budget is 16,384 tokens.
- `media-tools.ts` — the narrow per-turn Telegram media boundary. It may read
  only an addressed photo/audio attachment or its one direct reply; Telegram
  `file_id`, download path and authenticated URL never enter a model prompt,
  progress message, durable answer or log. A Vision-capable selected candidate
  receives an in-memory image part; a text-only fallback receives no bytes and
  is told that it cannot see the image. An explicit `расшифруй` command runs
  Flov locally and publishes the full transcript as chunked plain text without
  sending speech text to an LLM. Broader audio questions expose the bounded
  local `audio_transcribe` tool, whose model projection is deliberately short.
- `memory-tools.ts` — chat-scoped fast notes, durable lessons and progressive
  skill loading. Read tools are always bounded; write tools exist only when
  the addressed trigger both explicitly asks to remember/update something and
  comes from an operator-authorized numeric Telegram account. The private
  `PARILKA_BOT_MEMORY_WRITE_SENDER_IDS` allowlist is never exposed to the
  model; writes remain source-attributed to that trigger.
- `telegram-publication.ts` — narrow transport contract for the final text.
  Before mode selection it runs one deterministic Markdown table-block
  normalizer: valid GFM tables with at most 4 columns stay byte-identical,
  wider valid tables become labeled record lists, and invalid table-like
  blocks (orphan separator rows, ragged column counts, malformed separators)
  become mobile-friendly lists without raw pipes: short rows stay compact
  bullets, wider rows become multiline ordinal record blocks; fenced code,
  blockquotes, prose and inline code stay untouched. The normalized text is
  the visible content of both rich and plain publications, and the
  32,768-byte Rich Message limit applies to it. Normal model replies use
  native `sendRichMessage`; local audio and replies beyond that limit use
  lossless classic plain-message chunks. No other content policy is applied.
- `telemetry.ts` — per-turn usage accumulation and footer rendering. The
  published footer reports the current context occupancy — the last completed
  step's provider-reported input tokens over the successful final candidate's
  declared `contextWindowTokens` (never cumulative input/output, never output
  tokens), e.g. `qwen3.8-max 🧠 · 15.2k/1.0m · 2 tool calls · 1м 3с`; missing
  values render `?`, and the million suffix is a lowercase `m`.
- `typing.ts` — best-effort typing heartbeat.
- `tool-progress.ts` — persisted single-message model/tool timeline: safe
  `thinking` status markers (never reasoning text) and an allowlisted
  tool-request/selector preview capped at three lines.
- `runtime-config.ts` — fail-closed bot environment configuration.
- `turn-coordinator.ts` — isolated overlapping-turn state and fold contracts.
- `../bot-daemon.ts` — process composition and lifecycle entry point.
- `prompt.ts` injects bounded, untrusted per-chat Dream memory, fast notes,
  lesson/skill indexes and the memory-write gate on every provider attempt.

Their implementation is split by ownership:

- `runtime/`: shared contracts and validation helpers, update processor,
  long-poller, worker pump, API lifecycle, and grammY adapters.
- `read-tools/`: model-facing contracts and schemas, calendar conversion,
  bounded per-tool payload projection, cache executors (hybrid search,
  lexical find, transcript slice, thread, digests), web/paper/research
  executors, DNS-pinned public-page fetch, owner-only Unix-socket
  research-gateway client and abortable timeouts.
- `../../dream/`: offline memory consolidation triggered by the digest timer.
- `worker/`: turn contracts, validated worker settings, context/replay/fold
  preparation, lease heartbeat, durable dispatch, and orchestration.
- `turn-coordinator/`: public state contracts, admission/routing state,
  bounded folding, and option validation.
- `agent/`: untrusted chat-context serialization, carried tool evidence,
  metadata-only tool lifecycle observer, and abort/per-operation timeout helpers.
- `media/`: strict Bot API media-reference parsing (including the one embedded
  direct reply delivered in privacy mode), bounded redirect-free download,
  ffmpeg conversion through a bounded private seekable temporary input (removed
  before return) with an in-memory normalized output, and a single-flight
  loopback-only Flov client.
  The worker rehydrates the exact durable Bot API update before a media turn,
  so the generic MTProto sync representation cannot erase its current file
  reference.
- `telegram-publication.ts`: the transport contract described above. Telegram
  renders the rich payload natively; the only local rewrites are the
  deterministic table-block normalizer applied before mode selection and the
  lossless 4096 UTF-16-unit plain splitter fallback.
- `runtime-config/`: public contracts, environment rules, cross-field
  validation, optional web-search loading, and redacted inspection.
- `web-tools/`: bounded loopback JSON transport, SearXNG client, Firecrawl v2
  client with fail-closed target pre-resolution, poll/cancel and ~48k
  projection, and a DNS-pinned image downloader with magic-byte validation
  and per-turn cumulative reservation. Model-facing tool definitions for
  `searxng_search`, `firecrawl_crawl`, and `inspect_web_images` (vision-only).
  All three tools emit `ReadToolEvidence` (`source: "web"`) and carried
  bounded text results. The bot pre-resolves and fail-closes Firecrawl targets
  (public HTTPS only), but the local crawler resolves independently — this
  adapter does not pin the crawler's own connections.
- `agent/web-images.ts`: per-turn image tracker with atomic count and byte
  reservation contracts (in-flight + committed ≤ 6; consumed + reserved
  ≤ 40 MiB) and prepareStep injection of fresh in-memory image file parts
  for the current vision candidate only.
- `agent/web-tools-prompt.ts`: prompt sections owned by the web tools slice
  (tool list, selection workflow, external-source and research names).
- `read-tools/public-address.ts`: the single shared public-address policy
  (private/special DNS answers fail closed) and the DNS-pinned HTTPS transport
  reused by `static_page_fetch` and `inspect_web_images` only. Firecrawl targets are
  pre-resolved and fail-closed by the bot, but the local crawler resolves
  independently — the Firecrawl adapter never uses the pinned transport.
- `../bot-daemon/`: dependency composition, production adapters, trace wiring,
  signal lifecycle, and the executable main routine.

## Extension points

Add a model/provider through `TurnModelRouter`; add external search through
`WebSearchProvider`; the built-in `PublicWebFetchProvider` accepts only public
HTTPS pages and never shares browser state; add scientific paper search through
the built-in keyless arXiv/Europe PMC executor or a `PaperSearchProvider`; the
private `ResearchGatewayProvider` must retain the strict anonymized envelope
and never add source structure to this repository; add local history behavior
behind `BotReadToolCache`; and keep Telegram transport adaptation in
`runtime/grammy-adapters.ts` or `grammy-publisher.ts`. General model tools stay
read-only. The only stateful exception is the narrow `memory-tools.ts` contract:
it requires an authoritative direct-write gate from the private operator
authorizer allowlist, chat scope, bounded fields, source attribution and focused
tests together.

### Web tool endpoints

Configure loopback endpoints via environment variables (defaults to localhost):

- `PARILKA_BOT_SEARXNG_ENDPOINT` — credential-free HTTP origin, default
  `http://127.0.0.1:8080`.
- `PARILKA_BOT_FIRECRAWL_ENDPOINT` — credential-free HTTP origin, default
  `http://127.0.0.1:3002`.

Both are validated as loopback-only HTTP origins without path, query,
fragment, or credentials; remote, non-loopback, and credential-bearing values
are rejected fail-closed by `parseBotRuntimeConfig`. They are not secrets and
are included verbatim in redacted config inspection. Every request to these
origins uses `redirect: "error"`, a bounded body read, the caller's abort
signal plus an own timeout, and never forwards cookies or browser state.

Vision is a candidate capability, not a prompt guess: the resolved
`provider:model` manifest is fail-closed and carries `vision: false` unless
explicitly declared. The agent resolves it separately on every fallback, so a
future text-only subagent/model neither downloads image bytes nor invents a
vision tool. Do not infer capability from a model name or probe a user's image
to discover it.

Durable state transitions belong to the update processor or turn worker, not
transport adapters. Keep `turnId` and `updateId` in agent/worker log records,
and never retry a send after entering an ambiguous delivery state.

`turnId` в production-логах — числовой durable SQLite ID. Координатор хранит
универсальный строковый ID, но worker передаёт ему `String(turnId)`; его
trace-записи дополнительно несут `coordinatorTurnId` для связи с этим
внутренним контрактом. Каждый реально запущенный tool даёт ограниченную
metadata-only пару
`bot.agent.tool_started` и `bot.agent.tool`: `turnId`, `updateId`, candidate,
attempt, tool, kind и sequence. Обычное completion добавляет только duration,
ok и allowlisted status/errorCode. Rejected local audio completion может
добавить лишь coarse bounded application-owned diagnostics `flovStatus`,
`flovReason` и `flovSourceContainer`. Ни toolCallId, ни raw input/output/query,
ни transcript, model messages, provider body или reasoning в эти записи не
попадают.

## Focused tests

- Runtime/ACK/polling/pump: `tests/bot-runtime.test.ts`,
  `tests/bot-durability.test.ts`
- Read tools/cache: `tests/bot-read-tools.test.ts`,
  `tests/bot-read-cache.test.ts`
- Worker/send fence: `tests/bot-worker.test.ts`,
  `tests/grammy-publisher.test.ts`
- Publication/table transport: `tests/telegram-publication.test.ts`
- Agent/prompt: `tests/ai-agent-core.test.ts`,
  `tests/ai-agent-fallback.test.ts`, `tests/ai-agent-context.test.ts`,
  `tests/ai-agent-media.test.ts`,
  `tests/bot-prompt.test.ts`, `tests/bot-memory.test.ts`
- Media/Flov: `tests/media-telegram.test.ts`, `tests/media-tools.test.ts`,
  `tests/media-flov.test.ts`
- Memory/dream: `tests/bot-memory.test.ts`, `tests/bot-memory-tools.test.ts`,
  `tests/chat-knowledge.test.ts`, `tests/dream.test.ts`
- Process/config: `tests/bot-daemon.test.ts`, `tests/bot-runtime-config.test.ts`

Run all bot tests with:

```sh
node --test --import tsx tests/bot-*.test.ts tests/ai-agent-*.test.ts \
  tests/grammy-publisher.test.ts tests/telegram-publication.test.ts \
  tests/telegram-update.test.ts tests/turn-coordinator.test.ts
```
