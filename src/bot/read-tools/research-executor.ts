import type {
  BotReadToolSuccess,
  ReadToolEvidence,
  ResearchGatewayProvider,
  ResearchGatewayResponse,
} from "./contracts.js";
import {
  ReadToolExecutionError,
  success,
} from "./payload.js";
import {
  researchGatewayResponseSchema,
  type ResearchLookupArgs,
} from "./schemas.js";

const EMAIL = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu;
const PHONE_CANDIDATE = /(?<!\w)\+?\d[\d\s()\-]{7,}\d(?!\w)/gu;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>]+/giu;
const HANDLE = /(?<!\w)@[\p{L}\p{N}_]{3,}/gu;
const ABSOLUTE_PATH = /(?<!\w)(?:\/[^\s`"']+|[a-z]:\\[^\s`"']+)/giu;
const SECRET = /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|cookie)\b/iu;
const PRIVATE_CONTEXT = /(?<![\p{L}\p{N}_])(?:фио|фамили\p{L}*|контакт\p{L}*|телефон|почт\p{L}*|linkedin|telegram|аккаунт\p{L}*|паспорт\p{L}*|снилс|инн)(?![\p{L}\p{N}_])/iu;
const CYRILLIC_PERSON_NAME = /(?<![\p{L}\p{N}_])[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}(?:\s+[А-ЯЁ][а-яё]{2,})?(?![\p{L}\p{N}_])/gu;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const HAS_EMAIL = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu;
const HAS_HANDLE = /(?<!\w)@[\p{L}\p{N}_]{3,}/u;
const HAS_CYRILLIC_PERSON_NAME = /(?<![\p{L}\p{N}_])[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}(?:\s+[А-ЯЁ][а-яё]{2,})?(?![\p{L}\p{N}_])/u;
const IDENTIFIER = /\b(?:resume|vacancy|candidate|person|account|user)[_-]?id\b\s*[:=]?\s*\S+/iu;
const RESEARCH_QUERY_PHONE = /(?<!\w)\+?\d[\d\s()\-]{7,}\d(?!\w)/u;
const RESEARCH_QUERY_PII = [
  HAS_EMAIL,
  RESEARCH_QUERY_PHONE,
  HAS_HANDLE,
  HAS_CYRILLIC_PERSON_NAME,
  /(?<![\p{L}\p{N}_])(?:фио|фамили\p{L}*|личн\p{L}*|персональн\p{L}*|частн\p{L}*|контакт\p{L}*|телефон\p{L}*|почт\p{L}*|паспорт\p{L}*|снилс|инн|досье|анкета|профил\p{L}*|аккаунт\p{L}*)(?![\p{L}\p{N}_])/iu,
  /\b(?:personal|private)\s+(?:data|information|details|records|contact)\b/iu,
  /\b(?:resume|cv|profile|dossier|candidate|person|account)[_-]?(?:id|data|details|information|record|link|url)\b/iu,
  /(?<![\p{L}\p{N}_])(?:данн\p{L}*|сведен\p{L}*|информац\p{L}*|детал\p{L}*)\s+(?:о|про)\s+(?:конкретн\p{L}*|одн\p{L}*|эт\p{L}*|определённ\p{L}*|определенн\p{L}*)\s+(?:человек\p{L}*|кандидат\p{L}*|люд\p{L}*)(?![\p{L}\p{N}_])/iu,
  /(?<![\p{L}\p{N}_])(?:конкретн\p{L}*|эт\p{L}*|этого|этой)\s+(?:человек\p{L}*|кандидат\p{L}*|автор\p{L}*|сотрудник\p{L}*)(?![\p{L}\p{N}_])/iu,
  /(?:вытащ\p{L}*|достань\p{L}*|найд\p{L}*|покаж\p{L}*|раскр\p{L}*|собер\p{L}*|перечисл\p{L}*).{0,80}(?:личн\p{L}*|персональн\p{L}*|фио|имя|фамил\p{L}*|контакт\p{L}*|телефон\p{L}*|почт\p{L}*|резюм\p{L}*|досье|профил\p{L}*|аккаунт\p{L}*|id\b)/iu,
];

export async function executeResearchLookup(
  provider: ResearchGatewayProvider | undefined,
  args: ResearchLookupArgs,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<BotReadToolSuccess> {
  if (!provider) {
    throw new ReadToolExecutionError(
      "provider_unavailable",
      false,
      "Private research gateway is not configured.",
    );
  }
  if (isUnsafeResearchQuery(args.query)) {
    throw new ReadToolExecutionError(
      "invalid_arguments",
      false,
      "Private research gateway accepts aggregate research questions only.",
    );
  }
  const response = await callResearchGateway({
    provider,
    query: args.query,
    limit: args.limit,
    timeoutMs,
    externalSignal,
  });
  const parsed = researchGatewayResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      "Private research gateway returned an invalid disclosure.",
    );
  }

  const disclosure = sanitizeDisclosure(parsed.data);
  const evidence: ReadToolEvidence[] = disclosure.findings.map((finding) => ({
    source: "research",
    chat: null,
    message: null,
    speaker: { id: null, name: null },
    date: finding.asOf ?? null,
    title: "HH research gateway",
    text: "Обезличенный фрагмент закрытого исследовательского корпуса.",
  }));
  return success(
    "research_lookup",
    disclosure.status,
    {
      policy: "aggregate_and_anonymized_only",
      notice:
        "Фрагменты — обезличенное исследовательское основание. Пересказывай, не цитируй и не пытайся идентифицировать человека.",
      findingCount: disclosure.findings.length,
      findings: disclosure.findings,
      limitations: disclosure.limitations,
    },
    evidence,
  );
}

/**
 * The tool description is model-facing guidance; this gate is the hard
 * application boundary for adversarial or accidental personal-data queries.
 */
export function isUnsafeResearchQuery(query: string): boolean {
  return RESEARCH_QUERY_PII.some((pattern) => pattern.test(query));
}

export function sanitizeResearchDisclosure(
  value: ResearchGatewayResponse,
): {
  status: "done" | "empty";
  findings: Array<{ text: string; asOf?: string }>;
  limitations: string[];
} {
  const parsed = researchGatewayResponseSchema.safeParse(value);
  if (!parsed.success) {
    return { status: "empty", findings: [], limitations: [] };
  }
  return sanitizeDisclosure(parsed.data);
}

function sanitizeDisclosure(value: {
  status: "done" | "empty";
  findings?: readonly { text: string; as_of?: string | null }[];
  limitations?: readonly string[];
}): {
  status: "done" | "empty";
  findings: Array<{ text: string; asOf?: string }>;
  limitations: string[];
} {
  const findings = (value.findings ?? [])
    .map((finding) => {
      const text = redactResearchText(finding.text);
      if (text === undefined) {
        return undefined;
      }
      return {
        text,
        ...(finding.as_of !== undefined &&
        finding.as_of !== null &&
        ISO_DAY.test(finding.as_of)
          ? { asOf: finding.as_of }
          : {}),
      };
    })
    .filter((finding): finding is { text: string; asOf?: string } =>
      finding !== undefined
    );
  const limitations = (value.limitations ?? [])
    .map(redactResearchText)
    .filter((text): text is string => text !== undefined);
  return {
    status: value.status === "done" && findings.length > 0 ? "done" : "empty",
    findings,
    limitations,
  };
}

export function redactResearchText(value: string): string | undefined {
  if (SECRET.test(value)) {
    return undefined;
  }
  if (
    HAS_EMAIL.test(value) ||
    hasPhone(value) ||
    HAS_HANDLE.test(value) ||
    IDENTIFIER.test(value) ||
    (PRIVATE_CONTEXT.test(value) && HAS_CYRILLIC_PERSON_NAME.test(value))
  ) {
    return undefined;
  }
  const redacted = value
    .replace(EMAIL, "[контакт скрыт]")
    .replace(PHONE_CANDIDATE, (candidate) =>
      isPhone(candidate) ? "[контакт скрыт]" : candidate
    )
    .replace(URL, "[ссылка скрыта]")
    .replace(HANDLE, "[аккаунт скрыт]")
    .replace(ABSOLUTE_PATH, "[путь скрыт]")
    .replace(CYRILLIC_PERSON_NAME, "[человек]")
    .replace(/\s+/gu, " ")
    .trim();
  return redacted.length >= 24 ? redacted : undefined;
}

function hasPhone(value: string): boolean {
  const matcher = new RegExp(PHONE_CANDIDATE.source, "gu");
  return [...value.matchAll(matcher)].some(([candidate]) =>
    candidate !== undefined && isPhone(candidate)
  );
}

function isPhone(value: string): boolean {
  return value.replace(/\D/gu, "").length >= 10;
}

async function callResearchGateway(params: {
  provider: ResearchGatewayProvider;
  query: string;
  limit: number;
  timeoutMs: number;
  externalSignal?: AbortSignal;
}): Promise<ResearchGatewayResponse> {
  if (params.externalSignal?.aborted) {
    throw abortError(params.externalSignal, "Private research gateway");
  }
  const controller = new AbortController();
  let timedOut = false;
  let externalTimedOut = false;
  const onExternalAbort = (): void => {
    externalTimedOut = params.externalSignal !== undefined &&
      abortSignalTimedOut(params.externalSignal);
    controller.abort(params.externalSignal?.reason);
  };
  params.externalSignal?.addEventListener("abort", onExternalAbort, {
    once: true,
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, params.timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          new ReadToolExecutionError(
            timedOut || externalTimedOut ? "timeout" : "aborted",
            timedOut || externalTimedOut,
            timedOut || externalTimedOut
              ? `Private research gateway exceeded ${params.timeoutMs} ms.`
              : "Private research gateway was aborted.",
          ),
        ),
      { once: true },
    );
  });
  try {
    return await Promise.race([
      params.provider.lookup({
        query: params.query,
        limit: params.limit,
        signal: controller.signal,
      }),
      aborted,
    ]);
  } catch (error) {
    if (timedOut) {
      throw new ReadToolExecutionError(
        "timeout",
        true,
        `Private research gateway exceeded ${params.timeoutMs} ms.`,
      );
    }
    if (params.externalSignal?.aborted) {
      throw abortError(params.externalSignal, "Private research gateway");
    }
    if (error instanceof ReadToolExecutionError) {
      throw error;
    }
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      "Private research gateway failed.",
    );
  } finally {
    clearTimeout(timeout);
    params.externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function abortSignalTimedOut(signal: AbortSignal): boolean {
  return (
    typeof signal.reason === "object" && signal.reason !== null &&
    (("name" in signal.reason &&
      (signal.reason as { name?: unknown }).name === "TimeoutError") ||
      ("code" in signal.reason &&
        (signal.reason as { code?: unknown }).code === "timeout"))
  );
}

function abortError(
  signal: AbortSignal,
  label: string,
): ReadToolExecutionError {
  const timedOut = abortSignalTimedOut(signal);
  return new ReadToolExecutionError(
    timedOut ? "timeout" : "aborted",
    timedOut,
    timedOut ? `${label} timed out.` : `${label} was aborted.`,
  );
}
