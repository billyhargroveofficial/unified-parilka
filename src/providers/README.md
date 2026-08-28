# Provider routing

`model-router.ts` is the stable public entry point. Its implementation is
separated by policy boundary under `model-router/`:

- `contracts.ts` — public role, candidate, inspection, and execution types.
- `errors.ts` — typed configuration, resolution, provider-output, and routing
  failures.
- `config.ts` — strict JSON schema, provider/model references, URL validation,
  environment indirection, and file loading.
- `hardened-fetch.ts` — redirect refusal and declared/streamed response limits.
- `fallback.ts` — the single classification policy for aborts, auth,
  validation, filtering, invalid output, HTTP status, and transport failures.
- `registry.ts` — provider SDK construction, secret/header resolution, model
  lookup, role resolution, and redacted inspection.
- `router.ts` — ordered execution and fallback orchestration.

## Extension points

Endpoints, subscriptions, headers, models, and fallback order belong in the
validated JSON configuration. A new wire protocol extends the discriminated
config/contracts in `config.ts` and `contracts.ts`, then adds its SDK
construction in `registry.ts`; it requires focused tests for secret
indirection, inspection redaction, URL policy, and error classification. Do
not add a framework merely to register another endpoint using an existing
protocol.

`modelCapabilities` is the model manifest, declared per exact
`provider:model` reference. At runtime callers receive the resolved capability
with every candidate and never manually flip Vision for a turn; an omitted or
new model is fail-closed (`vision: false`). This is intentionally not guessed
from model-name spelling and not discovered by probing a user's image. A
fallback/subagent must use its own resolved capability, so a text-only model
does not receive image bytes or attempt a nonexistent Vision tool.

The manifest also carries an optional validated `contextWindowTokens` — the
declared maximum context window of that exact model reference. Bot telemetry
renders it as the denominator of the occupancy footer and shows `?` when it is
undeclared; it is never guessed from the model name, and on fallback the
successful final candidate's declared value wins.

`protocol: "openai"` means the compatible Chat Completions wire format
(`/chat/completions`), not the OpenAI Responses API. `protocol: "deepseek"`
uses the official DeepSeek adapter and defaults `thinkingMode` to `disabled`,
which keeps bounded bot/tool turns from silently spending the output budget on
reasoning. It can be explicitly enabled in provider config. A Responses adapter
should be added as a separate protocol only when a real deployment needs it.

An OpenAI-compatible provider profile may declare a validated
`reasoningEffort` (`none` through `max`). It is forwarded as the compatible
Chat Completions `reasoning_effort` field. Profiles may share an endpoint and
credential while roles choose different latency/quality budgets; this is still
one external provider, not a fallback chain.

## Security invariants

- Configuration stores environment variable names, never literal credentials.
- Remote providers require HTTPS. Plain HTTP requires an explicit opt-in and a
  loopback hostname.
- Provider base URLs reject credentials, query strings, and fragments.
- Provider requests use `redirect: "error"` so credentials and prompts cannot
  be replayed to a redirect target.
- Both declared and streamed response bodies are bounded.
- Abort remains control flow and is never converted into provider fallback.
- Inspection reports environment references and redacted values only.

Focused verification:

```sh
node --test --import tsx tests/model-router.test.ts \
  tests/ai-agent-*.test.ts tests/digest-generation.test.ts
npm run check
npm run build
```
