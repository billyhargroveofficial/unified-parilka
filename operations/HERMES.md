# Hermes profile «Парилка228»

Profile assets live in `integrations/hermes/parilka-profile/`. They serve one
Telegram group (`-1003179772905`) through the `parilka-chat` trusted plugin
and loopback MCP at `127.0.0.1:8766/mcp`.

## Runtime contract

- Main chat model: `openai-codex/gpt-5.6-luna`, `reasoning_effort: max`,
  `service_tier: fast`; its configured context window is 272,000 tokens.
- Search is Hermes `web/codex-native` using Luna. Public-page extraction is
  `web/lightpanda-local`; no SearXNG, Firecrawl, API key or model-router sits
  in this path.
- Telegram does not stream answer tokens. Tool progress is accumulated and
  then cleaned up after delivery of the final answer.
- The plugin appends one compact footer:
  `<bare-model> 🧠 · <used>/<max> · <N> tool calls · <elapsed>`.
  `used` is the latest `prompt_tokens`; it does not add cache or output
  tokens. Native `display.runtime_footer` is explicitly disabled to prevent
  a duplicate footer.
- The Telegram surface is limited to `parilka_chat`, memory, skills, web,
  vision, session search and TTS. `file`, `terminal`, `code_execution`,
  `project`, `computer_use`, raw MCP tools and delegation are not exposed.

`vision_analyze` is available only when the active authenticated Codex
capability exposes it. The plugin limits analysis to six images per full
Telegram turn; input attachments and later tool calls share that budget.

## Bootstrap and installation

```bash
hermes profile install integrations/hermes/parilka-profile --name parilka -y
hermes -p parilka auth add openai-codex
hermes -p parilka gateway install --no-start-now
hermes -p parilka doctor
```

Copy the checked-in `.env.template` to the installed profile only when the
operator needs to change its non-secret local settings. OAuth is held by
Hermes credentials, not in `.env` or Git. `PARILKA_TELEGRAM_CHAT_ID` is a
mandatory fail-closed guard; memory/skill writes also require an explicitly
allowlisted sender in `PARILKA_BOT_MEMORY_WRITE_SENDER_IDS`.

## Trusted plugin boundary

The model sees five clean cache-read tools: `rag_bm25_search`,
`keyword_search`, `read_chat_slice`, `day_digest` and `thread_context`.
The plugin injects the current message id server-side and dispatches only to
the prefixed loopback MCP names. `chat` and `source_message_id` are absent
from model schemas; any forged or extra argument is rejected before dispatch.

Memory and skill mutation is gated by the captured Parilka Telegram session.
Projection-managed memory and skills (`[parilka:managed:*]`,
`parilka-managed`, `parilka-lessons`, `parilka-skill-*`) are never editable by
the model. Plugin hooks fail closed outside the configured group/profile.

## Verification

```bash
# Offline: no network, providers, secrets or ~/.hermes mutation.
npm run test:hermes

# TypeScript checks for the returned TypeScript loop.
npm run check
```

`test:hermes` includes the real Hermes toolset assembly smoke test. It proves
that no local file, terminal or code tools leak into the Telegram model
surface.
