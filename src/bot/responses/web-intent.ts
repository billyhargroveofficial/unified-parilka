/**
 * Conservative trigger for an explicit request to use or check hosted web.
 * It does not infer that ordinary factual questions need search: those retain
 * the model's normal tool choice and stay fast for conversational turns.
 */
const WEB_TERM = /(?<![\p{L}\p{N}_])(?:web[\s_-]?(?:search|fetch)|web|search|fetch|веб[\s_-]?(?:поиск|фетч)|веб|интернет(?:е|ом)?|сети|поиск(?:а|е|ом)?|фетч)(?![\p{L}\p{N}_])/iu;
const REQUEST_VERB = /(?<![\p{L}\p{N}_])(?:проверь|проверить|используй|использовать|найди|найти|поищи|поискать|открой|открыть|запусти|запустить|сделай|сделать|можешь|умеешь|работает|доступен|доступна|доступно|есть)(?![\p{L}\p{N}_])/iu;
const GOOGLE_REQUEST = /(?<![\p{L}\p{N}_])(?:погугли|загугли|гугли|google)(?![\p{L}\p{N}_])/iu;
/** Remove only an explicitly negated web clause before looking for a positive request. */
const NEGATED_WEB_REQUEST = /(?<![\p{L}\p{N}_])(?:(?:без|не\s+(?:используй|использовать|делай|делать|проверяй|проверять|проверить))\s+(?:web[\s_-]?(?:search|fetch)|web|search|fetch|веб(?:а|ом)?(?:[\s_-](?:поиск|фетч))?|интернет(?:а|е|ом)?|сети|поиск(?:а|е|ом)?|фетч)|(?:web[\s_-]?(?:search|fetch)|web|search|fetch|веб(?:а|ом)?(?:[\s_-](?:поиск|фетч))?|интернет(?:а|е|ом)?|сети|поиск(?:а|е|ом)?|фетч)\s+не\s+(?:используй|использовать|делай|делать|проверяй|проверять|проверить|нужен|нужна|нужно|надо))(?![\p{L}\p{N}_])/giu;

export function requiresHostedWebSearchFirstLeg(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  const normalized = text.replace(/\0/gu, " ").trim();
  if (normalized === "") return false;
  const positive = normalized.replace(NEGATED_WEB_REQUEST, " ");
  return GOOGLE_REQUEST.test(positive) || (WEB_TERM.test(positive) && REQUEST_VERB.test(positive));
}
