import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import type {
  ResponsesCitation,
  ResponsesUsage,
  ResponsesWebAction,
  ResponsesWebProgressInput,
} from "./contracts.js";

export function functionCallsFrom(items: readonly ResponseOutputItem[]): ResponseFunctionToolCall[] {
  return items.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");
}

/** Preserve normalized provider output verbatim for a stateless next leg. */
export function responseOutputInput(items: readonly ResponseOutputItem[]): readonly Record<string, unknown>[] {
  return items.map((item) => item as unknown as Record<string, unknown>);
}

export function webSearchItem(item: ResponseOutputItem): {
  callId: string;
  action?: ResponsesWebAction;
  input?: ResponsesWebProgressInput;
  batchSize?: number;
  ok: boolean;
} | undefined {
  if (item.type !== "web_search_call" || typeof item.id !== "string") return undefined;
  const action = recordAction(item.action);
  const input = webProgressInput(item.action);
  const batchSize = webActionBatchSize(item.action);
  return {
    callId: item.id,
    ...(action === undefined ? {} : { action }),
    ...(input === undefined ? {} : { input }),
    ...(batchSize === undefined ? {} : { batchSize }),
    ok: item.status === "completed",
  };
}

export function hasHostedWebSearchCall(items: readonly ResponseOutputItem[]): boolean {
  return items.some((item) => item.type === "web_search_call");
}

export function webProgressFingerprint(
  action: ResponsesWebAction,
  input: ResponsesWebProgressInput | undefined,
  batchSize?: number,
): string {
  return JSON.stringify([action, input?.query, input?.url, input?.pattern, batchSize]);
}

export function citationsFrom(response: Response): readonly ResponsesCitation[] {
  const citations: ResponsesCitation[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      for (const annotation of content.annotations) {
        if (annotation.type === "url_citation" && validCitation(annotation)) {
          citations.push({
            startIndex: annotation.start_index,
            endIndex: annotation.end_index,
            title: annotation.title,
            url: annotation.url,
          });
        }
      }
    }
  }
  return citations;
}

/** Fallback links when subscription synthesis emits no url_citation annotations. */
export function citationsFromWebEvidence(items: readonly ResponseOutputItem[]): readonly ResponsesCitation[] {
  const citations = new Map<string, ResponsesCitation>();
  for (const item of items) {
    const record = item as unknown;
    if (!isRecord(record) || record.type !== "web_search_call" || record.status !== "completed" ||
      !isRecord(record.action)) continue;
    const action = record.action;
    const urls: unknown[] = [];
    if (action.type === "search" && Array.isArray(action.sources)) {
      for (const source of action.sources) {
        if (isRecord(source)) urls.push(source.url);
      }
    } else if ((action.type === "open_page" || action.type === "find_in_page") && action.url !== undefined) {
      urls.push(action.url);
    }
    for (const value of urls) {
      const citation = evidenceCitation(value);
      if (citation !== undefined && !citations.has(citation.url) && citations.size < 12) {
        citations.set(citation.url, citation);
        if (citations.size >= 12) return [...citations.values()];
      }
    }
  }
  return [...citations.values()];
}

export function usageFrom(response: Response): ResponsesUsage | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.output_tokens_details.reasoning_tokens,
    totalTokens: usage.total_tokens,
  };
}

function recordAction(value: unknown): ResponsesWebAction | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const type = (value as { type?: unknown }).type;
  return type === "search" || type === "open_page" || type === "find_in_page" ? type : undefined;
}

function webProgressInput(value: unknown): ResponsesWebProgressInput | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const action = value as {
    type?: unknown; query?: unknown; queries?: unknown; url?: unknown; pattern?: unknown;
  };
  if (action.type === "search") {
    const queries = Array.isArray(action.queries)
      ? action.queries.filter((query): query is string => typeof query === "string" && query.trim().length > 0)
      : [];
    const legacy = typeof action.query === "string" ? [action.query] : [];
    const query = boundedProgressText((queries.length > 0 ? queries : legacy).join(" / "), 512);
    return query === undefined ? undefined : { query };
  }
  if (action.type === "open_page") {
    const url = boundedProgressText(action.url, 2_048);
    return url === undefined ? undefined : { url };
  }
  if (action.type === "find_in_page") {
    const pattern = boundedProgressText(action.pattern, 512);
    const url = boundedProgressText(action.url, 2_048);
    if (pattern === undefined && url === undefined) return undefined;
    return {
      ...(pattern === undefined ? {} : { pattern }),
      ...(url === undefined ? {} : { url }),
    };
  }
  return undefined;
}

/**
 * One hosted `search` item can contain a provider-side query batch. Preserve
 * only its bounded cardinality for the transient UI, never raw extra fields.
 */
function webActionBatchSize(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const action = value as { type?: unknown; queries?: unknown; query?: unknown };
  if (action.type !== "search") return undefined;
  const queryCount = Array.isArray(action.queries)
    ? action.queries.filter((query): query is string => typeof query === "string" && query.trim().length > 0).length
    : 0;
  if (queryCount > 0) return queryCount;
  return typeof action.query === "string" && action.query.trim().length > 0 ? 1 : undefined;
}

function boundedProgressText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  return Array.from(normalized).slice(0, maximum).join("");
}

function validCitation(value: { start_index: number; end_index: number; title: string; url: string }): boolean {
  return Number.isSafeInteger(value.start_index) && Number.isSafeInteger(value.end_index) &&
    value.start_index >= 0 && value.end_index >= value.start_index &&
    value.title.length > 0 && value.title.length <= 1_024 && /^https?:\/\//iu.test(value.url);
}

function evidenceCitation(value: unknown): ResponsesCitation | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return undefined;
    return { startIndex: 0, endIndex: 0, title: url.hostname, url: url.href };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
