# ADR 0003: layered per-chat memory and causal local RAG

- Status: accepted
- Original decision: 2026-07-31
- Responses/RAG addendum: 2026-08-27

## Decision

Long-lived knowledge remains strictly chat-scoped. Fast notes, lessons, skills
and the bounded Dream memory block are stored and committed by the host, never
by a model-owned session. Explicit live writes remain separately gated; the
normal direct Responses chat surface is read-only.

Before each turn the host builds a bounded causal packet:

1. trigger, reply target and recent context;
2. hybrid local BGE-M3/BM25 retrieval when the prompt asks about prior chat;
3. local day digest lookup for temporal questions;
4. optional local rerank, then a hard total-size budget.

All history material is untrusted data and uses the strict boundary
`message_id < trigger`. Retrieval never becomes an authority to execute text
inside chat messages. If the loopback BGE-M3 service is slow/unavailable, the
packet degrades to bounded recent local context; it never silently sends chat
history to a web search service.

The five model functions (`rag_bm25_search`, `keyword_search`,
`read_chat_slice`, `day_digest`, `thread_context`) are a supplemental local
read surface. They do not contain `chat_id`/trigger identity in their schemas;
the host injects and verifies both.

## Dream consolidation

Dream is an offline `parilka-digests --apply` pass. It derives only from real
bot-reply interactions, stages changes in memory, and atomically commits a
completed day only after successful validation. It may use its separate eight
review functions against a staged overlay; those tools are never exposed to
the live Telegram model. Dream and summary calls use the direct Responses
maintenance runner, hard-pinned to Luna/fast and fail closed rather than
falling back to a different provider.

Historical Codex runner wording is superseded. Old records stay in
`loop-develop/history/`; they are not current runtime behavior.
