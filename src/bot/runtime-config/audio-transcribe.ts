import { isIP } from "node:net";
import type {
  BotAudioTranscribeRuntimeConfig,
  BotRuntimeEnvironment,
} from "./contracts.js";
import { integer } from "./env-rules.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:17432";
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Flov is deliberately a machine-local dependency. The bot never accepts a
 * transcription endpoint from a chat/model/tool call, and plain HTTP is
 * allowed only for a loopback address.
 */
export function audioTranscribeConfig(
  env: BotRuntimeEnvironment,
): BotAudioTranscribeRuntimeConfig {
  return {
    endpoint: loopbackHttpEndpoint(
      env.PARILKA_BOT_AUDIO_TRANSCRIBE_ENDPOINT ?? DEFAULT_ENDPOINT,
    ),
    timeoutMs: integer(
      env.PARILKA_BOT_AUDIO_TRANSCRIBE_TIMEOUT_MS,
      "PARILKA_BOT_AUDIO_TRANSCRIBE_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      1_000,
      600_000,
    ),
    ...optionalBearerToken(env.PARILKA_BOT_AUDIO_TRANSCRIBE_BEARER_TOKEN),
  };
}

function optionalBearerToken(
  raw: string | undefined,
): Pick<BotAudioTranscribeRuntimeConfig, "bearerToken"> | Record<never, never> {
  const token = raw?.trim();
  if (!token) {
    return {};
  }
  // It becomes an HTTP header later. Validate it here so an invalid secret
  // cannot leak through an implementation-specific fetch error or log.
  if (
    token.length > 16_384 ||
    !/^[\x21-\x7e]+$/u.test(token)
  ) {
    throw new Error(
      "PARILKA_BOT_AUDIO_TRANSCRIBE_BEARER_TOKEN must be a non-empty safe HTTP header value no longer than 16384 characters.",
    );
  }
  return { bearerToken: token };
}

function loopbackHttpEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      "PARILKA_BOT_AUDIO_TRANSCRIBE_ENDPOINT must be an absolute loopback HTTP URL.",
    );
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHost(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "PARILKA_BOT_AUDIO_TRANSCRIBE_ENDPOINT must be a credential-free loopback HTTP origin without a path, query, or fragment.",
    );
  }
  return url.origin;
}

function isLoopbackHost(rawHostname: string): boolean {
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  const version = isIP(normalized);
  if (version === 4) {
    return normalized.split(".")[0] === "127";
  }
  return version === 6 && (
    normalized === "::1" || normalized === "0:0:0:0:0:0:0:1"
  );
}
