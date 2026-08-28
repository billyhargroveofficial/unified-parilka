import type {
  BotReadToolSuccess,
  ReadToolEvidence,
  WebSearchProvider,
} from "./contracts.js";
import {
  ReadToolExecutionError,
  success,
} from "./payload.js";
import {
  webSearchResponseSchema,
  type WebSearchArgs,
} from "./schemas.js";
import { callWebProvider } from "./timeouts.js";

export async function executeWebSearch(
  provider: WebSearchProvider | undefined,
  args: WebSearchArgs,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<BotReadToolSuccess> {
  if (!provider) {
    throw new ReadToolExecutionError(
      "provider_unavailable",
      false,
      "Web search provider is not configured.",
    );
  }
  const response = await callWebProvider({
    provider,
    query: args.query,
    timeoutMs,
    externalSignal,
  });
  const parsed = webSearchResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      "Web search provider returned an invalid response.",
    );
  }

  const sources = parsed.data.sources ?? [];
  const evidence: ReadToolEvidence[] = sources.map((source) => ({
    source: "web",
    chat: null,
    message: null,
    speaker: { id: null, name: null },
    date: source.publishedAt ?? null,
    text:
      source.snippet?.trim() ||
      source.title?.trim() ||
      source.url,
    url: source.url,
    ...(source.title === undefined
      ? {}
      : { title: source.title }),
  }));
  const status =
    parsed.data.text.length === 0 && evidence.length === 0
      ? "empty"
      : "done";
  return success(
    "web_search",
    status,
    {
      query: args.query,
      text: parsed.data.text,
      sourceCount: evidence.length,
    },
    evidence,
  );
}
