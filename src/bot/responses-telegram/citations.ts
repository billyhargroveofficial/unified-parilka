/** Minimal typed shape of a Responses `url_citation` final annotation. */
export interface ResponsesUrlCitation {
  readonly type: "url_citation";
  readonly url: string;
  readonly title?: string;
}

const MAX_CITATIONS = 4;
const MAX_TITLE_CHARS = 120;
const MAX_URL_UTF16 = 4_096;
const MAX_URL_UTF8 = 4_096;
const TRACKING_QUERY_PARAMETER = /^(?:utm_.+|fbclid|gclid|yclid|mc_.+)$/iu;
const TRAILING_PROSE_PUNCTUATION = /[.,;:!'"»”’…]+$/gu;

/**
 * Renders an optional Rich Message Markdown footer. Only canonical public
 * HTTPS URLs survive; labels and destinations are escaped so citation data
 * cannot break out into arbitrary Telegram Markdown.
 */
export function renderTelegramUrlCitations(
  annotations: readonly ResponsesUrlCitation[],
  finalText = "",
): string {
  const citations = uniqueCitations(annotations, linkedCitationKeys(finalText));
  if (citations.length === 0) {
    return "";
  }
  const repeatedTitles = repeatedCitationTitles(citations);
  return `\n\nИсточники:\n${citations
    .map((citation, index) =>
      `- [${citationLabel(citation, index, repeatedTitles)}](${citation.url})`,
    )
    .join("\n")}`;
}

interface SafeCitation {
  readonly url: string;
  readonly title?: string;
}

function uniqueCitations(
  annotations: readonly ResponsesUrlCitation[],
  alreadyLinked: ReadonlySet<string>,
): SafeCitation[] {
  const seen = new Set<string>();
  const result: SafeCitation[] = [];
  for (const annotation of annotations) {
    if (annotation.type !== "url_citation" || result.length >= MAX_CITATIONS) {
      continue;
    }
    const url = safeHttpsUrl(annotation.url);
    const key = url === undefined ? undefined : citationKey(url);
    if (url === undefined || key === undefined || seen.has(key) || alreadyLinked.has(key)) {
      continue;
    }
    seen.add(key);
    const title = safeTitle(annotation.title);
    result.push({ url, ...(title === undefined ? {} : { title }) });
  }
  return result;
}

/**
 * A model can already put an attributed Markdown or bare URL in its final
 * answer. Keep the annotation for validation, but do not repeat the same
 * canonical page (including tracking-query variants) in the footer.
 */
function linkedCitationKeys(text: string): ReadonlySet<string> {
  if (typeof text !== "string" || text.length === 0) {
    return new Set();
  }
  const keys = new Set<string>();
  for (const match of text.matchAll(/\]\((https:\/\/[^\s)]+)\)/gu)) {
    rememberCitationKey(keys, match[1] ?? "");
  }
  for (const match of text.matchAll(/https:\/\/[^\s<>()[\]]+/gu)) {
    rememberCitationKey(keys, (match[0] ?? "").replace(TRAILING_PROSE_PUNCTUATION, ""));
  }
  return keys;
}

function safeHttpsUrl(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_UTF16) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      return undefined;
    }
    const normalized = url.href.replaceAll("\\", "%5C").replaceAll("(", "%28").replaceAll(")", "%29");
    return normalized.length <= MAX_URL_UTF16 && Buffer.byteLength(normalized, "utf8") <= MAX_URL_UTF8
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function rememberCitationKey(keys: Set<string>, value: string): void {
  const url = safeHttpsUrl(value);
  const key = url === undefined ? undefined : citationKey(url);
  if (key !== undefined) keys.add(key);
}

/** Known tracking variants are one citation; semantic query/fragment data survives. */
function citationKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_QUERY_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function repeatedCitationTitles(citations: readonly SafeCitation[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const citation of citations) {
    if (citation.title !== undefined) counts.set(citation.title, (counts.get(citation.title) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([title]) => title));
}

function citationLabel(citation: SafeCitation, index: number, repeatedTitles: ReadonlySet<string>): string {
  if (citation.title === undefined) return `Источник ${String(index + 1)}`;
  if (!repeatedTitles.has(citation.title)) return citation.title;
  const url = new URL(citation.url);
  const path = safeTitle(`${url.pathname}${url.search}${url.hash}`) ?? "/";
  return `${citation.title} — ${path}`;
}

function safeTitle(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return Array.from(normalized)
    .slice(0, MAX_TITLE_CHARS)
    .join("")
    .replace(/[\\\[\]\(\)]/gu, "\\$&");
}
