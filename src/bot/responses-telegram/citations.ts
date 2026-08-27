/** Minimal typed shape of a Responses `url_citation` final annotation. */
export interface ResponsesUrlCitation {
  readonly type: "url_citation";
  readonly url: string;
  readonly title?: string;
}

const MAX_CITATIONS = 12;
const MAX_TITLE_CHARS = 120;

/**
 * Renders an optional Rich Message Markdown footer. Only canonical public
 * HTTPS URLs survive; labels and destinations are escaped so citation data
 * cannot break out into arbitrary Telegram Markdown.
 */
export function renderTelegramUrlCitations(
  annotations: readonly ResponsesUrlCitation[],
  finalText = "",
): string {
  const citations = uniqueCitations(annotations, markdownLinkUrls(finalText));
  if (citations.length === 0) {
    return "";
  }
  return `\n\nИсточники:\n${citations
    .map((citation, index) =>
      `- [${citation.title ?? `Источник ${String(index + 1)}`}](${citation.url})`,
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
    if (url === undefined || seen.has(url) || alreadyLinked.has(url)) {
      continue;
    }
    seen.add(url);
    const title = safeTitle(annotation.title);
    result.push({ url, ...(title === undefined ? {} : { title }) });
  }
  return result;
}

/**
 * A model can already put an attributed URL in its final Markdown. Keep the
 * annotation for validation, but do not repeat that canonical link as a
 * footer entry.
 */
function markdownLinkUrls(text: string): ReadonlySet<string> {
  if (typeof text !== "string" || text.length === 0) {
    return new Set();
  }
  const urls = new Set<string>();
  for (const match of text.matchAll(/\]\((https:\/\/[^\s)]+)\)/gu)) {
    const url = safeHttpsUrl(match[1] ?? "");
    if (url !== undefined) {
      urls.add(url);
    }
  }
  return urls;
}

function safeHttpsUrl(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      return undefined;
    }
    return url.href.replaceAll("\\", "%5C").replaceAll("(", "%28").replaceAll(")", "%29");
  } catch {
    return undefined;
  }
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
