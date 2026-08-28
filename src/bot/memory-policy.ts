/**
 * Only the addressed user's authoritative trigger may expose write tools.
 * Folded messages, search output, existing memory and a loaded skill never
 * influence this gate, so untrusted text cannot persist itself.
 */
const NEGATED_WRITE_REQUEST = /(?:не\s+(?:надо\s+|нужно\s+)?|don't\s+|do\s+not\s+)(?:запомни|запоминай|сохрани|сохраняй|запиши|записывай|добавь|обнови|создай|remember|save|update|create)/iu;

const DIRECT_WRITE_REQUEST = /(?:запомни(?!\p{L})|(?:сохрани|сохраняй|запиши|записывай|запоминай|добавь|обнови)\s+(?:это\s+)?(?:в\s+)?(?:памят\p{L}*|урок\p{L}*|навык\p{L}*|на\s+будущее)|(?:создай|обнови)\s+(?:чатовый\s+)?навык\p{L}*|remember(?!\p{L})(?:\s+this)?|(?:save|update)\s+(?:this\s+)?(?:memory|lesson|skill)|create\s+(?:a\s+)?skill)/iu;

/**
 * Bare imperative for reply-turn context where the object is already
 * present in the replied-to message.  Anchored at ^ so meta-discourse
 * («он сказал запиши», «объясни команду запиши») cannot open the gate.
 *
 * Post-verb alternation allows both «запиши это пожалуйста» and
 * «запиши пожалуйста это» via (это → пожалуйста | пожалуйста → это).
 */
const BARE_WRITE_IMPERATIVE = /^(?:@\S+\s+)?(?:(?:да|ок|ага|ладно|ну|пожалуйста|please|плз|плиз|pls)(?!\p{L})[,.\s]*)?(?:запиши|записывай|сохрани|сохраняй|запомни|запоминай|save)(?:(?:[,.\s]*(?:это|this))(?:[,.\s]*(?:пожалуйста|плз|плиз|please|pls))?|(?:[,.\s]*(?:пожалуйста|плз|плиз|please|pls))(?:[,.\s]*(?:это|this))?)?[.!?,]*\s*$/iu;

export function botMemoryWriteAllowedForText(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || NEGATED_WRITE_REQUEST.test(normalized)) {
    return false;
  }
  return DIRECT_WRITE_REQUEST.test(normalized) || BARE_WRITE_IMPERATIVE.test(normalized);
}
