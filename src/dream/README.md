# Dream offline memory consolidation

`src/dream/` is the offline part of `parilka-digests --apply`. It constructs
chat-scoped semantic memory and staged fast/lesson/skill changes solely from
real bot-reply interactions. The runtime boundary is the direct OpenAI
Responses maintenance runner, hard-pinned to `gpt-5.6-luna` / `fast`; it is not
the Bot API runtime and never receives its token.

One review or shortening call is one bounded fresh Responses turn. Review may
use exactly eight staged-overlay functions:

- `review_search_long_memory`, `review_load_chat_skill`
- `review_remember_fast`, `review_remember_lesson`, `review_save_chat_skill`
- `review_delete_fast`, `review_delete_lesson`, `review_delete_skill`

The live bot never gets these write/delete functions. Model work writes only an
in-memory overlay. A successful complete day atomically commits staged
knowledge, semantic memory/watermark, the completed day row and its exact audit;
the same transaction may enqueue one bounded permanent public Dream digest.
Maintenance remains tokenless and cannot deliver it: the Bot owner later sends
the queued item unthreaded. The digest is audit-derived and shows only changed
layer counts plus bounded skill names or lesson/note titles; it never shows
memory text, skill instructions, review prompts/results or tool payloads.
Timeout, invalid output, rejected function or failed call discards both the
stage and any would-be digest. Empty days complete without a model call. There
is no provider/model fallback.

Dream runs nightly, plans seven completed Moscow days on first encounter, then fills missing
days and retries failed/running days oldest-first. Inputs are bounded projected
windows, not full-chat scans. Logs contain safe event metadata and error codes,
never prompts, memory contents, model output, tool payloads or credentials.
