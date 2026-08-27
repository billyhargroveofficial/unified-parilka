// JavaScript's `\b` is ASCII-oriented, so it is incorrect for Cyrillic
// routing. The surrounding punctuation/space check preserves deterministic
// whole-word matching without pretending that every question needs history.
const HISTORY_INTENT = /(?:^|[^\p{L}\p{N}_])(?:напомни|вспомни|найди\s+в\s+чат(?:е|ике)?|говорил(?:а|и)?|писал(?:а|и)?|обсуждал(?:а|и)?|упоминал(?:а|и)?|решили|договорил(?:ись|и)|переписк\p{L}*|истори\p{L}*\s+чат\p{L}*|выше|раньше|ранее)(?=$|[^\p{L}\p{N}_])/iu;
const TEMPORAL_INTENT = /(?:^|[^\p{L}\p{N}_])(?:сегодня|вчера|позавчера|на\s+(?:этой|прошлой)\s+неделе|\d{4}-\d{2}-\d{2})(?=$|[^\p{L}\p{N}_])/iu;

/** Pure, deliberately conservative router: false negatives leave six tools. */
export function hasHistoryIntent(text: string, hasReplyTarget: boolean): boolean {
  return hasReplyTarget || HISTORY_INTENT.test(text);
}

export function hasTemporalIntent(text: string): boolean {
  return TEMPORAL_INTENT.test(text);
}
