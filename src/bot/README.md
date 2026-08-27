# Bot slice

`src/bot/` owns the durable Telegram Bot API behavior; it does not own a model
process, OAuth state value or Telegram session. The direct subscription
Responses adapter in `src/bot-daemon/responses-agent.ts` composes this slice
with the TypeScript transport.

## Turn contract

The poller records raw update, normalized trigger and idempotent turn before
ACK. A leased worker starts typing immediately, builds causal context, calls
the model once through a bounded direct Responses function loop, persists a
draft, then publishes through the sending fence. `lost_ack` is terminal
delivery ambiguity; no automatic second send is permitted.

`responses/` contains fixed Luna/Fast instructions and secure subscription-state
configuration. `responses-telegram/` maps safe Responses events and
citations to the existing transient-progress/rich-publisher ports. `media/`
downloads one trusted Telegram image input through the Bot API lane, bounds and
validates it, then returns only an in-memory `data:image/...` URL.

## Model surface

Every bot request uses direct Codex subscription Responses with `gpt-5.6-luna`,
Fast `service_tier: "priority"` on the wire, hosted `web_search`, and at most the six local
read-only functions:

- `rag_bm25_search`
- `keyword_search`
- `read_chat_slice`
- `day_digest`
- `thread_context`
- `load_chat_skill` — exact named skill for the same causal chat

The model receives no terminal, shell, arbitrary file access, deletion,
Telegram write or generic host tool. The host supplies causal chat/trigger
identity. `load_chat_skill` accepts only a name and can disclose only the
matching same-chat skill whose source precedes `message_id < trigger`.

An explicit request to check or use web/search/fetch uses an initial-leg
`allowed_tools` policy requiring only hosted `web_search`. Casual turns keep
the hosted tool available but do not pay for an unnecessary search; local
function continuations return to normal tool choice. Every leg uses
`store: false`: a continuation replays bounded same-turn input and normalized
output items together with `function_call_output`, never a
`previous_response_id`.

## Causal RAG and presentation

`causal-rag/` creates a bounded untrusted context packet from reply/recent
messages, local BGE-M3 hybrid retrieval and day digests. Timeout/degradation
means bounded recent context, not external retrieval. One temporary progress
message accumulates compact English tool rows with an allowlisted value only:
bounded query text, URL host/path, find pattern, date/range,
message id or skill name, without argument-key prefixes. URL
credentials/query/hash, arbitrary arguments, model
reasoning and tool results stay hidden. Hosted rows include `×N`, combining
parallel items of the same action and native multi-query search batches. The
message is edited and removed before the
final native rich Markdown reply; if Telegram cannot confirm deletion, its exact message id
remains a terminal durable fence and is retried at a bounded cadence without
blocking the final reply. Web citations are rendered as safe clickable links.

Focused tests live under `tests/bot-responses-*.test.ts`,
`tests/responses-telegram-*.test.ts`, `tests/bot-causal-rag-*.test.ts` and
`tests/media-telegram.test.ts`.
