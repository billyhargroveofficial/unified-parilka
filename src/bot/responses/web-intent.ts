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
const NATURAL_NEGATED_WEB_REQUEST = /(?<![\p{L}\p{N}_])(?:(?:не\s+(?:нужно|надо|следует)\s+(?:использовать|проверять|делать)\s+)(?:web[\s_-]?(?:search|fetch)|web|search|fetch|веб[\s_-]?(?:поиск|фетч)|веб|интернет|поиск|фетч)|(?:web[\s_-]?(?:search|fetch)|web|search|fetch|веб[\s_-]?(?:поиск|фетч)|веб|интернет|поиск|фетч)\s+(?:использовать\s+)?не\s+(?:нужно|надо|следует))(?![\p{L}\p{N}_])/giu;
const EXPLICIT_RESEARCH = /(?<![\p{L}\p{N}_])(?:deep[\s_-]?(?:dive|research)|дип[\s_-]?(?:дайв|ресерч)|дипдайв|(?:deep|глубок\p{L}*|детальн\p{L}*|тщательн\p{L}*|нереальн\p{L}*)\s+(?:(?:deep|дип)[\s_-]?)?(?:(?:web|веб)[\s_-]+)?(?:research|ресерч|исследован\p{L}*)|(?:проведи|провести|сделай|сделать|нужен|нужно)\s+(?:\p{L}+[\s_-]+){0,3}(?:(?:web|веб)[\s_-]+)?(?:research|ресерч|исследован\p{L}*))(?![\p{L}\p{N}_])/iu;
const NEGATED_RESEARCH = /(?<![\p{L}\p{N}_])(?:без|не\s+(?:делай|делать|проводи|проводить|нужен|нужно|надо))\s+(?:(?:делать|проводить)\s+)?(?:(?:deep|дип|глубок\p{L}*|детальн\p{L}*|тщательн\p{L}*)[\s_-]+)?(?:(?:web|веб)[\s_-]+)?(?:dive|дайв|deepdive|дипдайв|research|ресерч\p{L}*|исследован\p{L}*)(?![\p{L}\p{N}_])/iu;
const EXPLICIT_WEB_PROHIBITION = /(?<![\p{L}\p{N}_])(?:без\s+(?:web|веба|интернета|веб[\s_-]?поиска)|не\s+(?:используй|использовать|делай|делать)\s+(?:web|веб|интернет|веб[\s_-]?поиск)|не\s+(?:нужно|надо|следует)\s+(?:использовать|делать)\s+(?:web|веб|интернет|веб[\s_-]?поиск)|(?:web|веб|интернет|веб[\s_-]?поиск)\s+(?:использовать\s+)?не\s+(?:используй|использовать|нужен|нужно|надо|следует))(?![\p{L}\p{N}_])/iu;
const LOCAL_RESEARCH_SCOPE = /(?<![\p{L}\p{N}_])(?:по\s+(?:истории\s+(?:этого\s+)?чата|(?:этой\s+)?переписке)|(?:по|из|на\s+основе)\s+(?:этого|этой|приложенного|приложенной)\s+(?:файла|документа|скрина|изображения))(?![\p{L}\p{N}_])/iu;

export function requiresHostedWebSearchFirstLeg(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  const normalized = text.replace(/\0/gu, " ").trim();
  if (normalized === "") return false;
  const positive = normalized
    .replace(NEGATED_WEB_REQUEST, " ")
    .replace(NATURAL_NEGATED_WEB_REQUEST, " ");
  return GOOGLE_REQUEST.test(positive) || (WEB_TERM.test(positive) && REQUEST_VERB.test(positive));
}

/**
 * Opts in only an explicit research request. Generic recommendations and
 * requests for detail stay on the fast path; local-document/history analysis
 * stays local unless the same message also positively asks for hosted web.
 */
export function requiresBoundedHostedWebResearch(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  const normalized = text.replace(/\0/gu, " ").trim();
  if (normalized === "" || !EXPLICIT_RESEARCH.test(normalized) || NEGATED_RESEARCH.test(normalized)) return false;
  const explicitlyRequiresWeb = requiresHostedWebSearchFirstLeg(normalized);
  if (!explicitlyRequiresWeb && (EXPLICIT_WEB_PROHIBITION.test(normalized) || LOCAL_RESEARCH_SCOPE.test(normalized))) {
    return false;
  }
  return true;
}
