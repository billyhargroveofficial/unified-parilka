const MACHINE_CODE = /^[a-zA-Z0-9_.:-]{1,120}$/;
const PURE_NUMERIC = /^\d+$/;
const MAX_DIAGNOSTIC_CHARS = 240;

/**
 * Persistable, secret-free machine diagnostic for Dream job rows and run
 * reports. Provider messages and free-form exception text are never returned.
 *
 * Prefer the outermost (first) semantic string machine code in the cause chain
 * so intentional wrappers like ETIMEDOUT win over nested ABORT_ERR / numeric
 * DOM codes. Pure-numeric fallback only when no semantic code exists.
 */
export function safeDreamErrorCode(error: unknown): string {
  const routed = routedDiagnostic(error);
  if (routed !== undefined) {
    return routed;
  }
  const code = readMachineCode(error);
  if (code !== undefined) {
    return boundDiagnostic(code);
  }
  if (error instanceof Error && error.name.length > 0) {
    return sanitizeMachineToken(error.name) ?? "unknown";
  }
  return "unknown";
}

function routedDiagnostic(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { code?: unknown; attempts?: unknown };
  const code = typeof record.code === "string" ? sanitizeMachineToken(record.code) : undefined;
  if (code === undefined || !Array.isArray(record.attempts)) return undefined;
  const lastAttempt = record.attempts.at(-1);
  const reason = typeof lastAttempt === "object" && lastAttempt !== null &&
    typeof (lastAttempt as { decision?: { reason?: unknown } }).decision?.reason === "string"
    ? sanitizeMachineToken((lastAttempt as { decision: { reason: string } }).decision.reason)
    : undefined;
  const parts: string[] = [code];
  if (reason !== undefined) {
    parts.push(reason);
  }
  const preferred = preferredCauseMachineCode(error);
  if (
    preferred !== undefined &&
    preferred !== code &&
    !parts.includes(preferred)
  ) {
    parts.push(preferred);
  }
  return boundDiagnostic(parts.join(":"));
}

/**
 * Walk the cause chain: keep the *first* (outermost) semantic string machine
 * code so intentional wrappers win (ETIMEDOUT over nested ABORT_ERR). Fall
 * back to the deepest pure-numeric code only when no semantic code exists.
 */
function preferredCauseMachineCode(error: unknown): string | undefined {
  let current: unknown =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  let firstSemantic: string | undefined;
  let deepestNumeric: string | undefined;
  const seen = new Set<unknown>();
  while (current != null && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    const code = readMachineCode(current);
    if (code !== undefined) {
      if (isSemanticMachineCode(code)) {
        if (firstSemantic === undefined) {
          firstSemantic = code;
        }
      } else {
        deepestNumeric = code;
      }
    }
    current =
      typeof current === "object" &&
      current !== null &&
      "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return firstSemantic ?? deepestNumeric;
}

function isSemanticMachineCode(code: string): boolean {
  return !PURE_NUMERIC.test(code);
}

function readMachineCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const raw = (error as { code?: unknown }).code;
  if (typeof raw !== "string" && typeof raw !== "number") {
    return undefined;
  }
  return sanitizeMachineToken(String(raw));
}

function sanitizeMachineToken(value: string): string | undefined {
  const trimmed = value.trim();
  if (!MACHINE_CODE.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function boundDiagnostic(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_CHARS) {
    return value;
  }
  return value.slice(0, MAX_DIAGNOSTIC_CHARS);
}
