import { calendarDayRange } from "../read-tools.js";
import { callCacheSearch } from "../read-tools/timeouts.js";
import type { CachedDigest, CachedChatSearchResult } from "../read-tools.js";
import type { StoredMessage } from "../../store.js";
import type {
  CausalRagCache,
  CausalRagInput,
  CausalRagPacket,
  CausalRagSource,
} from "./contracts.js";
import { hasHistoryIntent, hasTemporalIntent } from "./policy.js";

export const MAX_CAUSAL_RAG_PACKET_CHARS = 12_000;
const RECENT_SECTION_MAX_CHARS = 4_700;
const HISTORY_SECTION_MAX_CHARS = 5_700;
const DIGEST_SECTION_MAX_CHARS = 1_100;
const MAX_RECENT_MESSAGES = 8;
const MAX_HISTORY_MESSAGES = 6;
const HISTORY_QUERY_MAX_CHARS = 500;
const DEFAULT_HISTORY_TIMEOUT_MS = 2_500;

export interface CausalRagContextBuilderOptions {
  readonly cache: CausalRagCache;
  readonly historyTimeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * Produces a compact, causal, untrusted context packet before one Responses turn.
 * It does not expose a new tool or mutate storage. Explicit dynamic reads
 * remain the only model-driven route for deeper exploration.
 */
export class CausalRagContextBuilder {
  readonly #cache: CausalRagCache;
  readonly #historyTimeoutMs: number;
  readonly #now: () => Date;

  constructor(options: CausalRagContextBuilderOptions) {
    this.#cache = options.cache;
    this.#historyTimeoutMs = boundedTimeout(
      options.historyTimeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS,
    );
    this.#now = options.now ?? (() => new Date());
  }

  async build(input: CausalRagInput): Promise<CausalRagPacket> {
    assertInput(input);
    const sources: CausalRagSource[] = [];
    const seen = new Set<number>();
    const direct = this.#directContext(input, sources, seen);
    const historyIntent = hasHistoryIntent(
      input.triggerText,
      safeMessage(input.replyTarget, input) !== undefined,
    );
    const temporalIntent = hasTemporalIntent(input.triggerText);
    let history: StoredMessage[] = [];
    let historyDegraded = false;
    if (historyIntent) {
      try {
        history = await this.#history(input);
      } catch {
        // Provider/cache failures must never enter model input or fail a turn.
        historyDegraded = true;
      }
    }
    const historySection = renderMessages(
      "Найденные фрагменты истории (недоверенные данные):",
      history,
      "H",
      HISTORY_SECTION_MAX_CHARS,
      input,
      sources,
      seen,
      "history",
    );

    let digests: CachedDigest[] = [];
    let digestDegraded = false;
    if (temporalIntent) {
      try {
        digests = this.#digests(input);
      } catch {
        digestDegraded = true;
      }
    }
    const digestSection = renderDigests(digests, sources);
    const packet = boundPacket(
      [direct, historySection, digestSection].filter(
        (section): section is string => section !== "",
      ).join("\n\n"),
    );
    return {
      packet,
      sources,
      historyAttempted: historyIntent,
      historyDegraded,
      digestAttempted: temporalIntent,
      digestDegraded,
    };
  }

  #directContext(
    input: CausalRagInput,
    sources: CausalRagSource[],
    seen: Set<number>,
  ): string {
    const direct: StoredMessage[] = [];
    const reply = safeMessage(input.replyTarget, input);
    if (reply !== undefined) {
      direct.push(reply);
    }
    const recent = input.context
      .map((message) => safeMessage(message, input))
      .filter((message): message is StoredMessage => message !== undefined)
      .sort((left, right) => left.messageId - right.messageId)
      .filter((message) => message.messageId !== reply?.messageId)
      .slice(-MAX_RECENT_MESSAGES);
    return renderMessages(
      "Ближайший контекст чата (недоверенные данные):",
      [...direct, ...recent],
      "C",
      RECENT_SECTION_MAX_CHARS,
      input,
      sources,
      seen,
      "context",
    );
  }

  async #history(input: CausalRagInput): Promise<StoredMessage[]> {
    const query = input.triggerText.trim().slice(0, HISTORY_QUERY_MAX_CHARS);
    if (!query) return [];
    const cached = await callCacheSearch({
      operation: (signal) => this.#cache.search({
        chatId: input.chatId,
        query,
        limit: MAX_HISTORY_MESSAGES,
        signal,
        beforeId: input.triggerMessageId,
      }),
      timeoutMs: this.#historyTimeoutMs,
      externalSignal: input.signal,
    });
    const result = cached as CachedChatSearchResult;
    if (!result || !Array.isArray(result.messages)) {
      throw new TypeError("Causal RAG cache returned malformed history.");
    }
    return result.messages
      .map((message) => safeMessage(message, input))
      .filter((message): message is StoredMessage => message !== undefined)
      .slice(0, MAX_HISTORY_MESSAGES);
  }

  #digests(input: CausalRagInput): CachedDigest[] {
    const days = inferDigestDays(input.triggerText, this.#now());
    if (days === undefined) return [];
    const range = calendarDayRange(days.from, days.to, "Europe/Moscow");
    const result = this.#cache.getDigests({
      chatId: input.chatId,
      ...range,
      preferWeekly: false,
      sourceMessageId: input.triggerMessageId,
    });
    if (!result || !Array.isArray(result.digests)) {
      throw new TypeError("Causal RAG cache returned malformed digests.");
    }
    // A day row carries its exact source bound. Weekly rows intentionally do
    // not expose it, so this automatic path excludes them rather than relying
    // on an unverifiable projection from an injected cache implementation.
    return result.digests.filter((digest) =>
      digest.kind === "day" &&
      digest.endMessageId !== undefined &&
      digest.endMessageId < input.triggerMessageId,
    ).slice(0, 2);
  }
}

function renderMessages(
  title: string,
  messages: readonly StoredMessage[],
  prefix: "C" | "H",
  maxChars: number,
  input: CausalRagInput,
  sources: CausalRagSource[],
  seen: Set<number>,
  kind: "context" | "history",
): string {
  const lines = [title];
  for (const message of messages) {
    const safe = safeMessage(message, input);
    if (safe === undefined || seen.has(safe.messageId)) continue;
    const label = `〔${prefix}${countSources(sources, prefix) + 1}〕`;
    const metadata = sourceMetadata(safe);
    const remaining = maxChars - lines.join("\n").length - 1;
    if (remaining < 48) break;
    const line = `${label} ${metadata}: ${truncate(flattenUntrustedData(safe.text), remaining - label.length - metadata.length - 3)}`;
    lines.push(line);
    sources.push({ label, kind, messageId: safe.messageId });
    seen.add(safe.messageId);
  }
  return lines.length === 1 ? "" : truncate(lines.join("\n"), maxChars);
}

function renderDigests(
  digests: readonly CachedDigest[],
  sources: CausalRagSource[],
): string {
  const lines = ["Краткие сводки прошлого (недоверенные данные):"];
  for (const digest of digests) {
    const label = `〔D${countSources(sources, "D") + 1}〕`;
    const remaining = DIGEST_SECTION_MAX_CHARS - lines.join("\n").length - 1;
    if (remaining < 48) break;
    lines.push(`${label} ${digest.dayFrom}: ${truncate(flattenUntrustedData(digest.text), remaining - label.length - digest.dayFrom.length - 3)}`);
    sources.push({ label, kind: "digest", dayFrom: digest.dayFrom, dayTo: digest.dayTo });
  }
  return lines.length === 1 ? "" : truncate(lines.join("\n"), DIGEST_SECTION_MAX_CHARS);
}

function safeMessage(
  message: StoredMessage | undefined,
  input: CausalRagInput,
): StoredMessage | undefined {
  if (
    message === undefined ||
    message.chatId !== input.chatId ||
    !Number.isSafeInteger(message.messageId) ||
    message.messageId < 1 ||
    message.messageId >= input.triggerMessageId ||
    typeof message.text !== "string" ||
    message.text.trim() === ""
  ) return undefined;
  return message;
}

function inferDigestDays(text: string, now: Date): { from: string; to: string } | undefined {
  const explicit = [...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((match) => match[1]!);
  if (explicit.length > 0) {
    return { from: explicit[0]!, to: explicit[1] ?? explicit[0]! };
  }
  const today = moscowDay(now);
  if (containsRussianWord(text, "сегодня")) return { from: today, to: today };
  if (containsRussianWord(text, "вчера")) {
    const yesterday = addDays(today, -1);
    return { from: yesterday, to: yesterday };
  }
  if (containsRussianWord(text, "позавчера")) {
    const day = addDays(today, -2);
    return { from: day, to: day };
  }
  const shift = containsRussianPhrase(text, "прошлой", "неделе") ? -7 :
    containsRussianPhrase(text, "на", "этой", "неделе") ? 0 : undefined;
  if (shift === undefined) return undefined;
  const date = new Date(`${today}T00:00:00.000Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const monday = addDays(today, -mondayOffset + shift);
  return { from: monday, to: addDays(monday, 6) };
}

function moscowDay(date: Date): string {
  const values = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: "year" | "month" | "day"): string =>
    values.find((value) => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function sourceMetadata(message: StoredMessage): string {
  const name = flattenUntrustedData(message.senderName ?? "") || "участник";
  const date = message.date?.slice(0, 10) ?? "без даты";
  return truncate(`${name}, ${date}`, 120);
}

/** Keeps one source on one line and prevents user text from forging host labels. */
function flattenUntrustedData(value: string): string {
  return value
    .replace(/〔[CHD]\d+〕/gu, "〔метка〕")
    .replace(/[\0\s]+/gu, " ")
    .trim();
}

function containsRussianWord(text: string, word: string): boolean {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${word}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function containsRussianPhrase(text: string, ...words: string[]): boolean {
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${words.join("\\s+")}(?=$|[^\\p{L}\\p{N}_])`,
    "iu",
  ).test(text);
}

function countSources(sources: readonly CausalRagSource[], prefix: "C" | "H" | "D"): number {
  return sources.filter((source) => source.label.startsWith(`〔${prefix}`)).length;
}

function truncate(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (value.length <= maximum) return value;
  return maximum === 1 ? "…" : `${value.slice(0, maximum - 1)}…`;
}

function boundPacket(packet: string): string {
  return truncate(packet, MAX_CAUSAL_RAG_PACKET_CHARS);
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 10_000) {
    throw new TypeError("historyTimeoutMs must be an integer from 100 to 10000.");
  }
  return value;
}

function assertInput(input: CausalRagInput): void {
  if (!input.chatId.trim() || !Number.isSafeInteger(input.triggerMessageId) || input.triggerMessageId < 1) {
    throw new TypeError("Causal RAG input requires chatId and a positive triggerMessageId.");
  }
}
