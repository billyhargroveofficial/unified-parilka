export function normalizeBotUsername(raw: string | undefined): string {
  if (!raw) return "";
  return raw.trim().replace(/^@/u, "");
}

/**
 * A reply or wake-word is not enough. The body must contain a literal
 * @botusername token.
 */
export function hasLiteralBotMention(text: string | undefined, botUsername: string): boolean {
  const username = normalizeBotUsername(botUsername);
  if (!username) return false;
  const body = text ?? "";
  const pattern = new RegExp(`(^|[^\\w])@${escapeRegExp(username)}\\b`, "iu");
  return pattern.test(body);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
