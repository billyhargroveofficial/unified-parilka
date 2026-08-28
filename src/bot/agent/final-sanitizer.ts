import type { ReadToolEvidence } from "../read-tools/contracts.js";

interface ReadToolFailure {
  readonly name: string;
  readonly code?: string;
}

interface SanitizeFinalTextOptions {
  readonly text: string;
  readonly toolEvidence: readonly ReadToolEvidence[];
  readonly researchMode: boolean;
  readonly readToolFailures: readonly ReadToolFailure[];
  readonly externalSourcesRequested?: boolean;
}

interface AllowedSourceCatalog {
  readonly urls: Set<string>;
  readonly titles: Set<string>;
}

const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
const RAW_URL = /\bhttps?:\/\/[^\s)\],.;!?]+/gu;
const NAME_YEAR_CITATION =
  /\p{L}[\p{L}\p{M}\-']+\s+(?:et\s+al\.|&\s*\p{L}[\p{L}\p{M}\-']+)\s+\d{4}/u;

export function sanitizeFinalText(
  options: SanitizeFinalTextOptions,
): string {
  const allowed = buildAllowedSourceCatalog(options.toolEvidence);
  const citationSanitizationEnabled =
    options.researchMode === true ||
    options.toolEvidence.some(
      (item) => item.source === "web" || item.source === "paper",
    );
  const externalSourcesRequested = options.externalSourcesRequested === true;
  const webSearchFailed = hasReadToolFailure(options.readToolFailures, [
    "web_search",
    "static_page_fetch",
    "searxng_search",
    "firecrawl_crawl",
    "inspect_web_images",
  ]);
  const paperSearchFailed = hasReadToolFailure(options.readToolFailures, [
    "paper_search",
  ]);
  const researchFailed = hasReadToolFailure(options.readToolFailures, [
    "research_lookup",
  ]);
  const lines = options.text.split("\n");
  const kept: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const hasAllowedMention = hasAllowedSourceMention(line, allowed);
    if (
      !hasAllowedMention &&
      isFabricatedSearchFailureLine(line, webSearchFailed, paperSearchFailed, researchFailed)
    ) {
      continue;
    }
    if (
      citationSanitizationEnabled &&
      !hasAllowedMention &&
      isSuspiciousCitationLine(line)
    ) {
      continue;
    }
    let sanitizedLine = line;

    if (citationSanitizationEnabled) {
      sanitizedLine = sanitizedLine.replace(
        MARKDOWN_LINK,
        (_, label: string, href: string): string => {
          const normalized = normalizeUrl(href);
          if (
            externalSourcesRequested &&
            normalized !== "" &&
            allowed.urls.has(normalized)
          ) {
            return `[${label}](${href})`;
          }
          return label === "" ? "" : label;
        },
      );

      sanitizedLine = sanitizedLine.replace(
        RAW_URL,
        (url) => {
          const normalized = normalizeUrl(url);
          return externalSourcesRequested &&
            normalized !== "" &&
            allowed.urls.has(normalized)
            ? url
            : "";
        },
      );

      if (!externalSourcesRequested && isSourceHeader(line)) {
        continue;
      }
    }

    if (sanitizedLine.length > 0 || line.trim().length === 0) {
      kept.push(sanitizedLine);
    }
  }

  const collapsed = kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  if (externalSourcesRequested) {
    const appended = appendAllowedSourcesSummary(collapsed, allowed, options.toolEvidence);
    return appended;
  }

  return collapsed;
}

function buildAllowedSourceCatalog(evidence: readonly ReadToolEvidence[]): AllowedSourceCatalog {
  const urls = new Set<string>();
  const titles = new Set<string>();
  for (const item of evidence) {
    if (item.source !== "web" && item.source !== "paper") {
      continue;
    }
    if (typeof item.url === "string") {
      const normalized = normalizeUrl(item.url);
      if (normalized !== "") {
        urls.add(normalized);
      }
    }
    if (typeof item.title === "string" && item.title.trim().length > 0) {
      titles.add(item.title.trim().toLowerCase());
    }
  }
  return { urls, titles };
}

function hasAllowedSourceMention(line: string, catalog: AllowedSourceCatalog): boolean {
  const normalizedLine = line.toLowerCase();
  if (Array.from(catalog.urls).some((url) => normalizedLine.includes(url))) {
    return true;
  }
  for (const title of catalog.titles) {
    if (title.length >= 6 && normalizedLine.includes(title.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function isSourceHeader(line: string): boolean {
  return /^(?:\s*[-•*]?\s*)?(?:источники|источник|ссылки|links?):/iu.test(
    line,
  );
}

function isFabricatedSearchFailureLine(
  line: string,
  webSearchFailed: boolean,
  paperSearchFailed: boolean,
  researchFailed: boolean,
): boolean {
  const normalized = line.toLowerCase();
  const mentionsWebSearch =
    normalized.includes("web_search") ||
    normalized.includes("web search") ||
    normalized.includes("веб-поиск") ||
    normalized.includes("веб поиск") ||
    normalized.includes("static_page_fetch") ||
    normalized.includes("searxng_search") ||
    normalized.includes("searxng") ||
    normalized.includes("firecrawl_crawl") ||
    normalized.includes("firecrawl") ||
    normalized.includes("inspect_web_images");
  const mentionsPaperSearch =
    normalized.includes("paper_search") ||
    normalized.includes("paper search") ||
    normalized.includes("paper-search") ||
    normalized.includes("поиск статей");
  const mentionsResearchLookup =
    normalized.includes("research_lookup") ||
    normalized.includes("research lookup") ||
    normalized.includes("private research") ||
    normalized.includes("research gateway");

  const mentionsFailure =
    /(?:сегодня[\s-]*)?(?<![\p{L}\p{M}\d_])л[её]г(?![\p{L}\p{M}\d_])/u.test(normalized) ||
    /слом(?:ал|ался|ана|ано|ались|ан|аны)|не\s+работа/.test(normalized) ||
    /не\s+сработ/.test(normalized) ||
    /не\s+отвеча/.test(normalized) ||
    /недоступ/.test(normalized) ||
    /не\s+доступ/.test(normalized) ||
    /не\s+паш/.test(normalized) ||
    /\bdown\b/.test(normalized) ||
    /\boffline\b/.test(normalized) ||
    /\bfailed\b/.test(normalized) ||
    /ошиб/.test(normalized) ||
    /вылет/.test(normalized) ||
    /(?<![\p{L}\p{M}\d_])пад/u.test(normalized) ||
    /не\s+подня/.test(normalized) ||
    /\btoday\b/.test(normalized);

  if (!mentionsFailure) {
    return false;
  }

  if (mentionsWebSearch) {
    return !webSearchFailed;
  }
  if (mentionsPaperSearch) {
    return !paperSearchFailed;
  }
  if (mentionsResearchLookup) {
    return !researchFailed;
  }

  // Generic mention of a failed search claim without a specific tool name is
  // considered unsafe unless at least one read tool failed.
  return !(webSearchFailed || paperSearchFailed || researchFailed);
}

function hasReadToolFailure(
  failures: readonly ReadToolFailure[],
  names: readonly string[],
): boolean {
  const set = new Set(failures.map((item) => item.name));
  return names.some((name) => set.has(name));
}

function isSuspiciousCitationLine(line: string): boolean {
  return NAME_YEAR_CITATION.test(line) || /et al\./iu.test(line);
}

function appendAllowedSourcesSummary(
  text: string,
  catalog: AllowedSourceCatalog,
  evidence: readonly ReadToolEvidence[],
): string {
  const webPaperEvidence = evidence
    .filter((item) => item.source === "web" || item.source === "paper")
    .slice(0, 4);

  if (webPaperEvidence.length === 0) {
    return text;
  }
  const sourceLines = webPaperEvidence.map((item) => {
    const title = item.title?.trim() ?? "Внешний источник";
    const url = item.url;
    if (url === undefined) {
      return `- ${title}`;
    }
    const normalized = normalizeUrl(url);
    return catalog.urls.has(normalized)
      ? `- ${title}\n  - ${url}`
      : `- ${title}`;
  });

  if (sourceLines.length === 0) {
    return text;
  }

  if (!/^(?:\s*[-•*]?\s*)?(?:источники|источник|ссылки):/imu.test(text)) {
    const appended = `${text}\n\nПодтвержденные источники:\n${sourceLines.join("\n")}`;
    return appended;
  }
  return text;
}

function normalizeUrl(raw: string): string {
  try {
    const normalized = new URL(raw);
    normalized.hash = "";
    normalized.search = "";
    return normalized.toString();
  } catch {
    return "";
  }
}
