# ADR 0002: native Telegram Rich Messages for final replies

- Status: accepted
- Date: 2026-07-31
- Responses migration addendum: 2026-08-27

## Decision

The final response is delivered through the native Bot API rich-message path
using model Markdown. The direct Responses loop owns generation only; rich
publication, draft persistence, reply threading and delivery semantics remain
in the TypeScript Telegram host.

```text
Responses final Markdown + safe citation footer
  -> save durable canonical plain draft
  -> sending fence
  -> sendRichMessage(markdown)
  -> one parser-only pre-ACK fallback to split sendMessage(plain text)
  -> record canonical own send -> sent
```

The bot does not locally implement a general Markdown/GFM renderer. Telegram
interprets rich Markdown. A plain fallback is allowed once only for a clear
pre-ACK parser rejection or when rich size constraints require it; it splits
canonical plain text to Bot API limits.

## Responses presentation boundary

Hosted web citations are converted to a small deduplicated clickable footer.
The final answer never includes raw hosted tool events, reasoning or function
output. During generation, immediate `typing` and one transient progress
message accumulate one compact English row per tool call with a bounded
allowlisted value such as a web query, URL host/path, local query, date/range
or message id. Redundant argument-key prefixes are omitted. That
message is deleted before the final rich reply and excluded from corpus/digest
input.

Direct Responses does not alter `lost_ack`: timeout, malformed success,
partial delivery or post-ACK database failure are delivery ambiguity, never a
resend instruction. Historical Rich Message E2E evidence and the prior Codex
cutover do not prove the new direct-Responses deployment.

## Alternatives

- Local parser-to-block mapping: rejected; it recreates a fragile Markdown
  implementation.
- Classic entities as primary: rejected; it cannot express the desired native
  rich structures reliably.
- Streaming drafts, model-controlled uploads and generic media tools: outside
  this decision.
