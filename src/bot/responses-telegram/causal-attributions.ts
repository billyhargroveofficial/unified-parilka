import type { CausalRagSource } from "../causal-rag/index.js";

/**
 * Causal-RAG labels are model-input scaffolding, never user-facing citations.
 * A model can copy (or invent) a `〔C1〕`-style token, so the renderer removes
 * every such token from its text and adds a small, host-derived footer only
 * for labels that exist in the packet's provenance map.
 *
 * This deliberately exposes neither Telegram message ids nor storage paths.
 */
const CAUSAL_LABEL = /〔([CHD])\d+〕/giu;

type AttributionKind = "context" | "history" | "digest";

const ATTRIBUTION_LABEL: Readonly<Record<AttributionKind, string>> = {
  context: "Ближайшая переписка",
  history: "Найденные фрагменты истории",
  digest: "Краткие сводки истории",
};

/**
 * Converts trusted causal provenance into generic, host-rendered Telegram
 * attribution entries.  Unknown, duplicated, malformed, and forged labels
 * never become an attribution; all `〔C/H/Dn〕` tokens are removed regardless.
 */
export function renderTelegramCausalAttributions(
  text: string,
  sources: readonly CausalRagSource[],
): string {
  const mentioned = new Set<string>();
  for (const match of text.matchAll(CAUSAL_LABEL)) {
    mentioned.add(match[0]);
  }
  const visible = text.replace(CAUSAL_LABEL, "");
  const usedKinds = new Set<AttributionKind>();
  for (const source of sources) {
    if (mentioned.has(source.label) && isTrustedCausalSource(source)) {
      usedKinds.add(source.kind);
    }
  }
  if (usedKinds.size === 0) return visible;

  const entries = (Object.keys(ATTRIBUTION_LABEL) as AttributionKind[])
    .filter((kind) => usedKinds.has(kind))
    .map((kind) => `- ${ATTRIBUTION_LABEL[kind]}`);
  const footer = `Использованный контекст:\n${entries.join("\n")}`;
  return visible.trimEnd() === "" ? footer : `${visible.trimEnd()}\n\n${footer}`;
}

function isTrustedCausalSource(source: CausalRagSource): boolean {
  switch (source.kind) {
    case "context":
      return /^〔C[1-9]\d*〕$/u.test(source.label) &&
        Number.isSafeInteger(source.messageId) && source.messageId > 0;
    case "history":
      return /^〔H[1-9]\d*〕$/u.test(source.label) &&
        Number.isSafeInteger(source.messageId) && source.messageId > 0;
    case "digest":
      return /^〔D[1-9]\d*〕$/u.test(source.label) &&
        isIsoDay(source.dayFrom) && isIsoDay(source.dayTo);
  }
}

function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}
