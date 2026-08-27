const LINK_MAX_SPAN_UTF16 = 4_096;
const MAX_NESTING = 4;
const TABLE_ROW_JOINER = " · ";
const UNESCAPED_PIPE = /(?<!\\)\|/u;
const UNESCAPED_PIPE_AT_END = /(?<!\\)\|$/u;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/u;
const TABLE_SEPARATOR_SHAPE_CELL = /^:?-+:?$/u;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const BLOCKQUOTE_LINE_PATTERN = /^ {0,3}>/u;
const ESCAPABLE = new Set([
  "\\", "`", "*", "_", "{", "}", "[", "]", "<", ">", "(", ")",
  "#", "+", "-", ".", "!", "|", "~",
]);

/**
 * Projects the Markdown subset produced by Responses into readable Telegram
 * plain text. The scanner is bounded: nested links and link candidates have
 * fixed limits, and it contains no backtracking regex over model text.
 *
 * Visible prose, code and URLs survive. Markdown links become
 * `label (https://...)`, so citations remain useful after a Rich Message
 * parser rejection. Valid compact tables become a header and readable rows.
 */
export function markdownToReadablePlainText(markdown: string): string {
  return markdown.length === 0 ? "" : projectBlocks(markdown);
}

function projectBlocks(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const output: string[] = [];
  let fence: Fence | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence !== null) {
      if (isFenceClose(line, fence)) {
        fence = null;
      } else {
        // Fenced bodies are literal visible text: preserve their formatting
        // characters instead of treating code as a second Markdown document.
        output.push(line);
      }
      continue;
    }

    const openedFence = parseFenceOpen(line);
    if (openedFence !== null) {
      fence = openedFence;
      continue;
    }

    const header = splitTableRowCells(line);
    const separator = index + 1 < lines.length &&
        hasTableSeparatorShape(lines[index + 1] ?? "")
      ? splitTableRowCells(lines[index + 1] ?? "")
      : null;
    if (
      header !== null &&
      separator !== null &&
      header.length === separator.length &&
      separator.every((cell) => TABLE_SEPARATOR_CELL.test(cell))
    ) {
      output.push(header.map((cell) => projectInline(cell)).join(TABLE_ROW_JOINER));
      let rowIndex = index + 2;
      while (rowIndex < lines.length) {
        const row = splitTableRowCells(lines[rowIndex] ?? "");
        if (row === null || row.length !== header.length) {
          break;
        }
        output.push(`- ${row.map((cell) => projectInline(cell)).join(TABLE_ROW_JOINER)}`);
        rowIndex += 1;
      }
      index = rowIndex - 1;
      continue;
    }

    output.push(projectLine(line));
  }
  return output.join("\n");
}

function projectLine(line: string): string {
  let value = line;
  value = value.replace(/^ {0,3}#{1,6}(?=\s|$)\s?/u, "");
  value = value.replace(/^ {0,3}>\s?/u, "");
  value = value.replace(/^ {0,3}[+*]\s+(?=\S)/u, "- ");
  return /^ {0,3}(?:[-*_]\s*){3,}$/u.test(value) ? "" : projectInline(value);
}

function projectInline(value: string, depth = 0): string {
  const output: string[] = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index] ?? "";
    if (char === "\\") {
      const escaped = value[index + 1];
      if (escaped !== undefined && ESCAPABLE.has(escaped)) {
        output.push(escaped);
        index += 2;
      } else {
        output.push(char);
        index += 1;
      }
      continue;
    }
    if (char === "`") {
      const runLength = markerRunLength(value, index, "`");
      const close = value.indexOf("`".repeat(runLength), index + runLength);
      if (close >= 0) {
        output.push(value.slice(index + runLength, close));
        index = close + runLength;
      } else {
        index += runLength;
      }
      continue;
    }
    if (
      (char === "[" || (char === "!" && value[index + 1] === "[")) &&
      depth < MAX_NESTING
    ) {
      const link = readLink(value, index, depth);
      if (link !== undefined) {
        output.push(link.plainText);
        index = link.end;
        continue;
      }
    }
    if (char === "<") {
      const autolink = readAutolink(value, index);
      if (autolink !== undefined) {
        output.push(autolink.plainText);
        index = autolink.end;
        continue;
      }
    }
    if (isFormattingMarker(value, index, char)) {
      index += markerRunLength(value, index, char);
      continue;
    }
    output.push(char);
    index += 1;
  }
  return output.join("");
}

function readLink(
  value: string,
  index: number,
  depth: number,
): Projection | undefined {
  const labelStart = value[index] === "!" ? index + 2 : index + 1;
  const closeBracket = findUnescaped(value, "]", labelStart, LINK_MAX_SPAN_UTF16);
  if (
    closeBracket < 0 ||
    value[closeBracket + 1] !== "(" ||
    closeBracket + 2 - index > LINK_MAX_SPAN_UTF16
  ) {
    return undefined;
  }
  const closeParen = findClosingParenthesis(value, closeBracket + 2);
  if (closeParen < 0 || closeParen + 1 - index > LINK_MAX_SPAN_UTF16) {
    return undefined;
  }
  const label = projectInline(value.slice(labelStart, closeBracket), depth + 1).trim();
  const destination = readableDestination(value.slice(closeBracket + 2, closeParen));
  if (destination.length === 0) {
    return undefined;
  }
  return {
    plainText: label.length === 0 ? destination : `${label} (${destination})`,
    end: closeParen + 1,
  };
}

function readableDestination(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    return close > 1 ? trimmed.slice(1, close) : "";
  }
  const whitespace = trimmed.search(/\s/u);
  return whitespace < 0 ? trimmed : trimmed.slice(0, whitespace);
}

function readAutolink(value: string, index: number): Projection | undefined {
  if (!value.startsWith("<http://", index) && !value.startsWith("<https://", index)) {
    return undefined;
  }
  const close = value.indexOf(">", index + 1);
  if (close < 0 || close - index > LINK_MAX_SPAN_UTF16) {
    return undefined;
  }
  const url = value.slice(index + 1, close);
  return /^https?:\/\/[^\s<>]+$/u.test(url)
    ? { plainText: url, end: close + 1 }
    : undefined;
}

function findUnescaped(value: string, target: string, start: number, maxSpan: number): number {
  const end = Math.min(value.length, start + maxSpan);
  for (let index = start; index < end; index += 1) {
    if (value[index] === "\\") {
      index += 1;
    } else if (value[index] === target) {
      return index;
    }
  }
  return -1;
}

function findClosingParenthesis(value: string, start: number): number {
  const end = Math.min(value.length, start + LINK_MAX_SPAN_UTF16);
  let nesting = 0;
  for (let index = start; index < end; index += 1) {
    const char = value[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "(") {
      nesting += 1;
    } else if (char === ")") {
      if (nesting === 0) {
        return index;
      }
      nesting -= 1;
    }
  }
  return -1;
}

function isFormattingMarker(value: string, index: number, char: string): boolean {
  if (char !== "*" && char !== "_" && char !== "~") {
    return false;
  }
  const runLength = markerRunLength(value, index, char);
  if (char === "~" && runLength < 2) {
    return false;
  }
  const previous = index === 0 ? "" : value[index - 1] ?? "";
  const next = value[index + runLength] ?? "";
  return (
    (isBoundary(previous) && isVisible(next)) ||
    (isVisible(previous) && isBoundary(next))
  );
}

function markerRunLength(value: string, index: number, marker: string): number {
  let end = index;
  while (value[end] === marker) {
    end += 1;
  }
  return end - index;
}

function isBoundary(char: string): boolean {
  return char.length === 0 || /[\s\p{P}]/u.test(char);
}

function isVisible(char: string): boolean {
  return char.length > 0 && !/\s/u.test(char);
}

function hasTableSeparatorShape(line: string): boolean {
  const cells = splitTableRowCells(line);
  return cells !== null && cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_SHAPE_CELL.test(cell));
}

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

type Fence = { char: "`" | "~"; length: number };
type Projection = { plainText: string; end: number };

function parseFenceOpen(line: string): Fence | null {
  const match = FENCE_OPEN_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  const char = match[1].charAt(0);
  return { char: char === "~" ? "~" : "`", length: match[1].length };
}

function isFenceClose(line: string, fence: Fence): boolean {
  return new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`, "u").test(line);
}
