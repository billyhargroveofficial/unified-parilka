# Architecture Map

Parilka is a small TypeScript runtime for one Telegram group. SQLite WAL,
currently schema v24, is the durable correctness boundary. Process shells only
compose independently tested domains; the model cannot own delivery state.

## Runtime topology

```text
Telegram Bot API -> parilka-bot -> SQLite WAL v24 <- parilka-sync <- MTProto
                         |                 |                    |
                         v                 |                    +-> 127.0.0.1:8766/mcp
       Codex subscription Responses (direct HTTP/SSE)
       gpt-5.6-luna / Fast (`priority` wire) +-> maintain + digests + Dream
          | hosted web_search in request
          | six read-only local functions
          + trusted Telegram input_image
```

`parilka-sync` is the single MTProto/session owner. `parilka-bot` is the
single Bot API poller, protected by a lifetime `flock`; it records the update,
normalized message and turn reservation before ACK. `parilka-maintain` and
`parilka-digests` share only SQLite/digest policy, never the Bot token. The
machine-wide `telegram-mcp.service` (`127.0.0.1:8765`) is unrelated.

## Direct Responses boundary

The production chat path is a direct TypeScript HTTP/SSE client for the Codex
subscription Responses endpoint. It reads an owner-only ChatGPT OAuth state
copy and starts neither Codex CLI/app-server nor a Platform API-key/SDK
transport. Bot code hard-pins `gpt-5.6-luna`; logical Fast is
`service_tier: "priority"` on the wire, and configuration can choose only a
reviewed timeout. Each bot turn sends hosted `web_search` directly with its
Responses request. The streamed hosted events include search, open-page and
find-in-page actions; no SearXNG, Firecrawl or Hermes is in this path.

The client executes a bounded stateless sequential function loop. Every leg
uses `store: false`; continuations replay only bounded same-turn input,
normalized response items and `function_call_output`, never a
`previous_response_id`. Cross-turn continuity is durable SQLite context, not
an unbounded hidden model session. A timeout or cancel aborts the upstream
stream. The application stores/publishes a final draft before its sending
fence; ambiguous post-send delivery is terminal `lost_ack`, never a blind
retry.

The subscription OAuth state is a separate writable owner-owned regular
non-symlink file with mode `0600`; the runtime validates its bounded ChatGPT
schema and atomically persists refresh rotation. Bot slices cannot override
the final injected path or select another model/tier.

## Tool and input boundary

The bot request always has hosted web search. The API can then use its native
search/open/find flow in the same server request. The UI maps only safe action
names and a bounded value to Telegram: query text, URL host/path or find
pattern, without an argument-key prefix. It drops URL credentials/query/hash
and never exposes arbitrary tool
arguments, raw tool output or model reasoning. Confirmed URL citations become
a deduplicated clickable final footer.

The model-facing local surface is exactly six read-only tools:

| Tool | Purpose |
| --- | --- |
| `rag_bm25_search` | hybrid local semantic/lexical chat retrieval |
| `keyword_search` | exact local words/names |
| `read_chat_slice` | bounded chronological local range |
| `day_digest` | local day/range digest |
| `thread_context` | bounded neighbourhood around a local message |
| `load_chat_skill` | full instruction for one exact indexed same-chat skill |

The model never supplies `chat_id` or `source_message_id`; the host injects
them from the durable trigger and rejects history at or after it.
`load_chat_skill` takes a name only, and the host similarly enforces the exact
same-chat skill and its pre-trigger source. No terminal,
filesystem read/write/delete, Telegram API write, arbitrary MCP, plugins or
generic host tool is exposed.

Telegram photo/image-document input is downloaded through the trusted Bot API
lane, bounded and validated by MIME/metadata/pixel limits, and supplied
in-memory as Responses `input_image` (high detail). It is not written into a
model-accessible working directory.

## Causal local RAG

Before a model call, `CausalRagContextBuilder` includes bounded trigger/reply/
recent context, then selectively performs hybrid retrieval for history intent
or temporal digest lookup. It exposes only bounded skill names/descriptions in
that packet; a full instruction needs the explicit `load_chat_skill` call.
The default provider is loopback BGE-M3, producing dense and learned sparse
representations; BM25, RRF and optional local rerank remain on the host.
Retrieval has a small timeout and degrades to recent local context, never
external network retrieval. The final packet is capped, labels provenance
internally and treats all chat text as untrusted data.

## Telegram presentation

Once a turn is leased, typing starts before upstream HTTP connection and is
heartbeated until final publication. Thinking, hosted web, image handling and
accepted local read calls share a single transient progress message. It is
rendered as accumulated compact English rows, exactly one logical row per tool
call, edited in place under a hard per-turn snapshot budget, coalesces successful
completion with the next concrete tool status, suppresses continuation-thinking
after tool execution begins, is given minimum dwell, and is deleted before final
rich publication. It is excluded from corpus/digest ingestion. Publisher
rendering normalizes Markdown/rich Bot API output and splits safely where needed.

Dream is nightly tokenless maintenance. Its eight staged-overlay review tools
are intentionally absent from the live progress bubble: a rejected day rolls
them back. The same successful SQLite transaction that commits a Dream audit
may queue one durable, permanent public digest. A Bot-owner worker later sends
it unthreaded. The digest is bounded to layer counts and changed skill names or
lesson/note titles; it never contains memory text, skill instructions, review
inputs/outputs or raw tool payloads.

## Repository lanes

| Lane | Path | Authority |
| --- | --- | --- |
| Bot | `src/bot/`, `src/bot-daemon/` | durable Bot API turn and presentation |
| Responses | `src/openai-responses/` | direct bounded SDK transport |
| Storage | `src/storage/`, `src/store.ts` | SQLite and migrations |
| Retrieval | `src/bot/causal-rag/`, `src/vector/` | causal local context/RAG |
| Sync/MCP | `src/sync/`, `src/mcp-tools/` | MTProto, history and operator proxy |
| Digests/Dream | `src/digest/`, `src/dream/`, `src/digest-cli/` | source-hashed maintenance generation |
| Operations | `operations/`, `systemd/`, `bin/` | staged deploy and rollback |

The old Hermes and Codex-app-server materials are historical/rollback context
only. The systemd `Conflicts=hermes-gateway-parilka.service` guard intentionally
remains: it prevents two pollers during a controlled migration and does not
make Hermes a dependency.
