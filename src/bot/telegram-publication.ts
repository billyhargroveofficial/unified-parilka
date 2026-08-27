import { markdownToReadablePlainText } from "./telegram-markdown-plain.js";

/** Telegram's documented classic `sendMessage` UTF-16 text payload limit. */
export const TELEGRAM_TEXT_LIMIT_UTF16 = 4_096;

/** Telegram's documented native Rich Message UTF-8 payload limit. */
export const TELEGRAM_RICH_TEXT_LIMIT_UTF8 = 32_768;

/**
 * The exact model result that crosses the Telegram send boundary.
 *
 * This is deliberately a transport contract, not a content policy. It applies
 * deterministic Markdown table-block normalization before mode selection.
 * Rich publications retain Markdown for the native path, but always carry a
 * separately projected readable plain-text fallback.
 * This matters when Telegram rejects the native parser: classic sendMessage
 * must never expose raw formatting syntax to the chat. The Rich Message byte
 * limit applies to the normalized Markdown; local audio and replies beyond
 * that limit use the classic plain path, which the publisher splits losslessly.
 */
export type TelegramPublication =
  | {
      mode: "rich";
      markdown: string;
      plainText: string;
      maxChunkUtf16: number;
    }
  | {
      mode: "plain";
      plainText: string;
      maxChunkUtf16: number;
    };

export function createTelegramPublication(
  text: string,
  responseOrigin?: "local_audio",
): TelegramPublication {
  const normalized = normalizeTelegramMarkdownTables(text);
  // A model answer is normally non-empty. A Markdown-only answer (for example
  // just "***") has no visible text, so retain a small readable placeholder
  // rather than construct an invalid Telegram publication with an empty body.
  const plainText = markdownToReadablePlainText(normalized) || "—";
  if (
    responseOrigin === "local_audio" ||
    utf8Length(normalized) > TELEGRAM_RICH_TEXT_LIMIT_UTF8
  ) {
    return {
      mode: "plain",
      plainText,
      maxChunkUtf16: TELEGRAM_TEXT_LIMIT_UTF16,
    };
  }
  return {
    mode: "rich",
    markdown: normalized,
    plainText,
    maxChunkUtf16: TELEGRAM_TEXT_LIMIT_UTF16,
  };
}

export function utf16Length(text: string): number {
  return text.length;
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const TABLE_ROW_JOINER = " · ";
const COMPACT_TABLE_ROW_CELLS = 4;
const UNESCAPED_PIPE = /(?<!\\)\|/u;
const UNESCAPED_PIPE_AT_END = /(?<!\\)\|$/u;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/u;
const TABLE_SEPARATOR_SHAPE_CELL = /^:?-+:?$/u;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const BLOCKQUOTE_LINE_PATTERN = /^ {0,3}>/u;

/**
 * Telegram renders a table draft with raw pipes whenever the block is not a
 * clean GFM table — the production failure was a separator row without a
 * header row followed by nine-column data rows. This deterministic normalizer
 * runs before the rich/plain selection and the byte-limit check:
 *
 * - fenced code, blockquotes, inline code and pipe prose stay untouched;
 * - valid GFM tables with at most 4 columns stay byte-identical;
 * - valid GFM tables wider than 4 columns become labeled record lists that
 *   keep every cell value in order;
 * - invalid table-like blocks (orphan separator rows, ragged column counts,
 *   malformed separators) lose their raw pipes: short rows become compact
 *   bullets, wider rows become multiline ordinal record blocks, keeping the
 *   non-empty cell text in order and never inventing lost header labels.
 */
export function normalizeTelegramMarkdownTables(text: string): string {
  if (!text.includes("|")) {
    return text;
  }
  const lines = text.split("\n");
  const output: string[] = [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  // Source index of the output tail only while that tail is a verbatim line;
  // a rewritten block resets it so a following separator never misreads
  // rewritten output as its header row. `verbatimRunStart` proves the
  // preceding line is verbatim output too. `preservedTableEnd` remembers the
  // last source line of the most recent kept compact table, so a spaced
  // header is never peeled out of that table, while independent malformed
  // blocks after it stay detectable.
  let verbatimTailIndex = -1;
  let verbatimRunStart = -1;
  let preservedTableEnd = -1;
  const pushVerbatim = (verbatimLine: string, sourceIndex: number): void => {
    const extendsRun =
      verbatimTailIndex >= 0 && verbatimTailIndex === sourceIndex - 1;
    output.push(verbatimLine);
    verbatimTailIndex = sourceIndex;
    if (!extendsRun) {
      verbatimRunStart = sourceIndex;
    }
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (fence !== null) {
      if (isFenceClose(line, fence)) {
        fence = null;
      }
      pushVerbatim(line, index);
      index += 1;
      continue;
    }
    const openedFence = parseFenceOpen(line);
    if (openedFence !== null) {
      fence = openedFence;
      pushVerbatim(line, index);
      index += 1;
      continue;
    }
    const separatorCells = hasTableSeparatorShape(line)
      ? splitTableRowCells(line)
      : null;
    if (separatorCells === null) {
      pushVerbatim(line, index);
      index += 1;
      continue;
    }

    // A separator-shaped row anchors one table-like block: an optional header
    // row immediately before it — or one separated by a single blank line —
    // and the contiguous pipe rows after it.
    let headerCells: string[] | null = null;
    let spacedHeader = false;
    if (index > 0 && verbatimTailIndex === index - 1) {
      const immediate = splitTableRowCells(lines[index - 1]);
      if (immediate !== null) {
        headerCells = immediate;
      } else if (
        index > 1 &&
        lines[index - 1].trim() === "" &&
        verbatimRunStart <= index - 2 &&
        index - 2 > preservedTableEnd
      ) {
        const spaced = splitTableRowCells(lines[index - 2]);
        if (spaced !== null) {
          headerCells = spaced;
          spacedHeader = true;
        }
      }
    }
    let end = index + 1;
    const dataRows: string[][] = [];
    while (end < lines.length) {
      const next = lines[end];
      if (
        parseFenceOpen(next) !== null ||
        hasTableSeparatorShape(next)
      ) {
        break;
      }
      const cells = splitTableRowCells(next);
      if (cells === null) {
        break;
      }
      dataRows.push(cells);
      end += 1;
    }

    // A single blank line between header and separator never renders as a
    // native Telegram table, so it is never promoted back to valid.
    const header = headerCells;
    let wellFormed = false;
    if (!spacedHeader && header !== null) {
      const headerRow: readonly string[] = header;
      const separatorIsClean = separatorCells.every((cell) =>
        TABLE_SEPARATOR_CELL.test(cell),
      );
      const columnsMatch =
        headerRow.length === separatorCells.length &&
        dataRows.every((row) => row.length === headerRow.length);
      wellFormed = separatorIsClean && columnsMatch;
    }

    if (header !== null && wellFormed) {
      if (header.length <= 4) {
        // Compact valid tables render natively; keep them byte-identical.
        const extendsRun =
          verbatimTailIndex >= 0 && verbatimTailIndex === index - 1;
        for (let kept = index; kept < end; kept += 1) {
          output.push(lines[kept]);
        }
        verbatimTailIndex = end - 1;
        if (!extendsRun) {
          verbatimRunStart = index;
        }
        preservedTableEnd = end - 1;
      } else {
        output.pop(); // The header row becomes record labels, not data.
        output.push(...renderWideTableRecords(header, dataRows));
        verbatimTailIndex = -1;
        verbatimRunStart = -1;
      }
    } else {
      if (header !== null) {
        output.pop();
        if (spacedHeader) {
          output.pop(); // The intervening blank line.
        }
      }
      let rows: readonly (readonly string[])[];
      if (header !== null) {
        rows = [header, ...dataRows];
      } else if (dataRows.length > 0) {
        rows = dataRows;
      } else {
        // A lone separator still carries its cell text; never drop it.
        rows = [separatorCells];
      }
      output.push(...renderTableRowList(rows));
      verbatimTailIndex = -1;
      verbatimRunStart = -1;
    }
    index = end;
  }
  return output.join("\n");
}

function renderWideTableRecords(
  labels: readonly string[],
  dataRows: readonly (readonly string[])[],
): string[] {
  if (dataRows.length === 0) {
    return renderTableRowList([labels]);
  }
  const output: string[] = [];
  dataRows.forEach((row, position) => {
    if (position > 0) {
      output.push("");
    }
    output.push(`**${position + 1}.**`);
    row.forEach((cell, column) => {
      if (cell.length === 0) {
        return;
      }
      const label = labels[column] ?? "";
      output.push(label.length === 0 ? `- ${cell}` : `- ${label}: ${cell}`);
    });
  });
  return output;
}

/**
 * Fallback rendering for invalid or headerless table-like blocks. Rows with
 * at most four non-empty cells stay one compact bullet; wider rows become
 * their own multiline record block under a generic ordinal heading, because a
 * single nine-cell bullet joined by middle dots is still a mobile wall of
 * text. Blank lines separate the renderings that touch a record block so its
 * bullets never merge with a neighbor; adjacent compact bullets stay tight.
 * Labels are never invented: only the cell text, in source order.
 */
function renderTableRowList(
  rows: readonly (readonly string[])[],
): string[] {
  const output: string[] = [];
  let record = 0;
  let previousWasBlock = false;
  for (const row of rows) {
    const cells = row.filter((cell) => cell.length > 0);
    if (cells.length === 0) {
      continue;
    }
    const isBlock = cells.length > COMPACT_TABLE_ROW_CELLS;
    if (output.length > 0 && (isBlock || previousWasBlock)) {
      output.push("");
    }
    if (isBlock) {
      record += 1;
      output.push(`**${record}.**`);
      for (const cell of cells) {
        output.push(`- ${cell}`);
      }
    } else {
      output.push(`- ${cells.join(TABLE_ROW_JOINER)}`);
    }
    previousWasBlock = isBlock;
  }
  return output;
}

function parseFenceOpen(
  line: string,
): { char: "`" | "~"; length: number } | null {
  const match = FENCE_OPEN_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  const char = match[1].charAt(0);
  return { char: char === "~" ? "~" : "`", length: match[1].length };
}

function isFenceClose(
  line: string,
  fence: { char: "`" | "~"; length: number },
): boolean {
  return new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`, "u").test(
    line,
  );
}

function hasTableSeparatorShape(line: string): boolean {
  const cells = splitTableRowCells(line);
  return (
    cells !== null &&
    cells.length > 0 &&
    cells.every((cell) => TABLE_SEPARATOR_SHAPE_CELL.test(cell))
  );
}

/** Returns null for lines that are not table rows; otherwise trimmed cells. */
function splitTableRowCells(line: string): string[] | null {
  if (BLOCKQUOTE_LINE_PATTERN.test(line)) {
    return null;
  }
  const trimmed = line.trim();
  if (!UNESCAPED_PIPE.test(trimmed)) {
    return null;
  }
  let body = trimmed;
  if (body.startsWith("|")) {
    body = body.slice(1);
  }
  if (UNESCAPED_PIPE_AT_END.test(body)) {
    body = body.slice(0, -1);
  }
  return body.split(/(?<!\\)\|/u).map((cell) => cell.trim());
}

/**
 * Splits losslessly without cutting a UTF-16 surrogate pair. Paragraph, line,
 * and space boundaries are preferred before a scalar-safe hard cut.
 */
export function splitTelegramText(
  text: string,
  limit = TELEGRAM_TEXT_LIMIT_UTF16,
): string[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 2 ||
    limit > TELEGRAM_TEXT_LIMIT_UTF16
  ) {
    throw new RangeError(
      `Telegram text limit must be an integer between 2 and ${TELEGRAM_TEXT_LIMIT_UTF16}.`,
    );
  }
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = safeUtf16End(text, start, limit);
    if (hardEnd >= text.length) {
      chunks.push(text.slice(start));
      break;
    }
    const preferredEnd = preferredBreak(text, start, hardEnd);
    const end = preferredEnd > start ? preferredEnd : hardEnd;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function safeUtf16End(text: string, start: number, limit: number): number {
  let end = Math.min(text.length, start + limit);
  if (
    end < text.length &&
    end > start &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  if (end === start) {
    throw new RangeError(
      "Unable to fit one Unicode scalar into the Telegram chunk limit.",
    );
  }
  return end;
}

function preferredBreak(
  text: string,
  start: number,
  hardEnd: number,
): number {
  const paragraph = text.lastIndexOf("\n\n", hardEnd - 2);
  if (paragraph >= start) {
    return paragraph + 2;
  }
  const line = text.lastIndexOf("\n", hardEnd - 1);
  if (line >= start) {
    return line + 1;
  }
  const space = text.lastIndexOf(" ", hardEnd - 1);
  if (space >= start) {
    return space + 1;
  }
  return hardEnd;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
