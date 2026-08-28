# MCP tools

`src/tools.ts` is the compatibility import. `facade.ts` owns the
`TelegramTools` lifecycle and an explicit runtime context; `registry.ts`
dispatches the fixed 18-tool surface without a generic plugin framework.

- `definitions.ts`: public names, descriptions, and JSON Schemas (18 tools).
- `sync-health-handlers.ts`: config, status, chat resolution, and manual sync.
- `read-handlers.ts`: cache reads, search, embeddings, and thread context.
- `send-handlers.ts`: preview, reply preflight, dry-run, and live send flow.
- `send-approval.ts`: short-lived one-shot payload capabilities and hashes.
- `cache-metadata.ts`: health and cache-completeness response metadata.
- `response.ts`: MCP JSON envelope, error flag, and cancellation guard.

Five cache-only bot-read tools (`rag_bm25_search`, `keyword_search`,
`read_chat_slice`, `day_digest`, `thread_context`) are wired through
`BotReadTools` + `CanonicalBotReadCache` on top of `MessageStore` and
`VectorRag`. They use the configured `TELEGRAM_DEFAULT_CHAT_ID`, require
`source_message_id` as an exclusive causal upper bound, and never call
Telegram. The optional `PARILKA_BOT_ID` env var (exposed as
`botSenderId` in `AppConfig`) marks the bot's own messages with
`authorRole=assistant` / `isOwnTurn=true`.

Trust boundary: the raw MCP `source_message_id` is a service field meant
only for a trusted bridge, never for the model. The future Hermes
model-facing plugin hides the argument and substitutes its own
`HERMES_SESSION_MESSAGE_ID`. Do not derive the bound by clamping to
`MAX(message_id)` in a lively chat — the newest row may be newer than the
trigger, which would leak the trigger and later messages.

Error envelope exception: boundary failures (missing/invalid
`source_message_id`, invalid tool arguments) keep MCP `isError` like every
other tool. Typed operational BotRead failures (`cache_error`,
`provider_unavailable`, `provider_error`, `timeout`, `aborted`, `unsafe_url`)
deliberately stay a normal MCP response carrying the `{ok:false, tool,
error:{code…}, evidence:[]}` envelope (see `jsonCacheReadResult` in
`response.ts`), so Hermes can act on the structured code instead of an opaque
protocol error.

Every handler receives the MCP request `AbortSignal`. Network-backed chat
resolution, reply preflight, and send admission check it before and after
Telegram calls; the send queue checks again immediately before the mutating
transport call. An already-started Telegram request cannot be retroactively
cancelled, so its result remains the authoritative delivery outcome.

To add or change a tool, update both the definition and the explicit registry
branch, then test the public `TelegramTools.callTool` boundary. Keep
live-write policy in the send domain and storage durability in
`SendThrottler`/`MessageStore`.
