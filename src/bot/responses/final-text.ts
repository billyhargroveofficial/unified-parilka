/**
 * Luna may occasionally mirror the trusted-input JSON vocabulary and wrap an
 * otherwise valid Markdown answer as `{ "answer": "..." }`. Remove only that
 * exact one-field envelope; preserve arbitrary/multi-field JSON requested by
 * the user and every other model response verbatim apart from outer space.
 */
export function normalizeResponsesFinalText(value: string): string {
  const trimmed = stripOpaqueCitationTokens(value).trim();
  const candidate = singleJsonFenceBody(trimmed) ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return trimmed;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.answer !== "string") {
    return trimmed;
  }
  const answer = stripOpaqueCitationTokens(parsed.answer).trim();
  return answer === "" ? trimmed : answer;
}

/** Subscription synthesis can leak non-public ChatGPT citation placeholders. */
function stripOpaqueCitationTokens(value: string): string {
  return value.replace(/\s*\uE200(?:cite|filecite)(?:\uE202[^\uE201]*)+\uE201/gu, "");
}

function singleJsonFenceBody(value: string): string | undefined {
  const match = /^```json\s*\n([\s\S]*?)\n```$/iu.exec(value);
  return match?.[1]?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
