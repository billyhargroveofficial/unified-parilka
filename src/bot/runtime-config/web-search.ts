import { isIP } from "node:net";
import type {
  BotRuntimeConfig,
  BotRuntimeEnvironment,
} from "./contracts.js";
import {
  absolutePath,
  boundedPlain,
  enumValue,
  integer,
} from "./env-rules.js";
import {
  VERTEX_WEB_SEARCH_DEFAULT_INSTRUCTION,
  VERTEX_WEB_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
  VERTEX_WEB_SEARCH_DEFAULT_MODEL,
  VERTEX_WEB_SEARCH_DEFAULT_PROJECT,
  VERTEX_WEB_SEARCH_DEFAULT_REGION,
} from "../web-search-vertex.js";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export function optionalWebSearchConfig(
  env: BotRuntimeEnvironment,
): Pick<BotRuntimeConfig, "webSearch"> | Record<never, never> {
  const provider = enumValue(
    env.PARILKA_BOT_WEB_SEARCH_PROVIDER,
    "PARILKA_BOT_WEB_SEARCH_PROVIDER",
    ["http", "vertex", "auto"] as const,
    "auto",
  );
  const endpointRaw = env.PARILKA_BOT_WEB_SEARCH_ENDPOINT?.trim() ?? "";
  const tokenEnvRaw =
    env.PARILKA_BOT_WEB_SEARCH_BEARER_TOKEN_ENV?.trim() ?? "";
  const endpointPresent = endpointRaw.length > 0;
  const tokenEnvPresent = tokenEnvRaw.length > 0;
  const vertexProjectPresent =
    (env.PARILKA_VERTEX_PROJECT?.trim() ?? "").length > 0;

  let target: "http" | "vertex" | null;
  if (provider === "http") {
    target = "http";
  } else if (provider === "vertex") {
    target = "vertex";
  } else if (endpointPresent) {
    target = "http";
  } else if (vertexProjectPresent) {
    target = "vertex";
  } else {
    target = null;
  }

  if (target === null) {
    if (tokenEnvPresent) {
      throw new Error(
        "PARILKA_BOT_WEB_SEARCH_BEARER_TOKEN_ENV requires PARILKA_BOT_WEB_SEARCH_ENDPOINT.",
      );
    }
    return {};
  }

  if (target === "http") {
    if (!endpointPresent) {
      throw new Error(
        "PARILKA_BOT_WEB_SEARCH_ENDPOINT is required when PARILKA_BOT_WEB_SEARCH_PROVIDER=http.",
      );
    }
    const endpoint = safeProviderEndpoint(endpointRaw);
    if (!tokenEnvPresent) {
      return { webSearch: { kind: "http", endpoint } };
    }
    if (!ENV_NAME_PATTERN.test(tokenEnvRaw)) {
      throw new Error(
        "PARILKA_BOT_WEB_SEARCH_BEARER_TOKEN_ENV must name a valid environment variable.",
      );
    }
    const bearerToken = env[tokenEnvRaw]?.trim();
    if (!bearerToken) {
      throw new Error(
        "The environment variable referenced by PARILKA_BOT_WEB_SEARCH_BEARER_TOKEN_ENV is missing or empty.",
      );
    }
    if (bearerToken.length > 16_384) {
      throw new Error(
        "The configured web-search bearer token is too long.",
      );
    }
    return {
      webSearch: { kind: "http", endpoint, bearerToken },
    };
  }

  return { webSearch: buildVertexConfig(env) };
}

function buildVertexConfig(
  env: BotRuntimeEnvironment,
): NonNullable<BotRuntimeConfig["webSearch"]> & { kind: "vertex" } {
  const gcloudPathRaw = env.PARILKA_GCLOUD_PATH?.trim() ?? "";
  const gcloudPath =
    gcloudPathRaw.length > 0
      ? absolutePath(gcloudPathRaw, "PARILKA_GCLOUD_PATH")
      : undefined;
  return {
    kind: "vertex",
    project: boundedPlain(
      env.PARILKA_VERTEX_PROJECT ?? VERTEX_WEB_SEARCH_DEFAULT_PROJECT,
      "PARILKA_VERTEX_PROJECT",
      128,
    ),
    model: boundedPlain(
      env.PARILKA_VERTEX_WEB_SEARCH_MODEL ??
        VERTEX_WEB_SEARCH_DEFAULT_MODEL,
      "PARILKA_VERTEX_WEB_SEARCH_MODEL",
      80,
    ),
    region: boundedPlain(
      env.PARILKA_VERTEX_WEB_SEARCH_REGION ??
        VERTEX_WEB_SEARCH_DEFAULT_REGION,
      "PARILKA_VERTEX_WEB_SEARCH_REGION",
      32,
    ),
    maxOutputTokens: integer(
      env.PARILKA_VERTEX_WEB_SEARCH_MAX_OUTPUT_TOKENS,
      "PARILKA_VERTEX_WEB_SEARCH_MAX_OUTPUT_TOKENS",
      VERTEX_WEB_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
      1,
      8_192,
    ),
    systemInstruction: boundedPlain(
      env.PARILKA_VERTEX_WEB_SEARCH_SYSTEM_INSTRUCTION ??
        VERTEX_WEB_SEARCH_DEFAULT_INSTRUCTION,
      "PARILKA_VERTEX_WEB_SEARCH_SYSTEM_INSTRUCTION",
      4_000,
    ),
    ...(gcloudPath === undefined ? {} : { gcloudPath }),
  };
}

function safeProviderEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "PARILKA_BOT_WEB_SEARCH_ENDPOINT must be an absolute URL.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "PARILKA_BOT_WEB_SEARCH_ENDPOINT cannot contain credentials, query parameters, or a fragment.",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHost(url.hostname))
  ) {
    throw new Error(
      "PARILKA_BOT_WEB_SEARCH_ENDPOINT must use HTTPS; HTTP is allowed only for a loopback host.",
    );
  }
  return url.toString();
}

function isLoopbackHost(rawHostname: string): boolean {
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }
  const version = isIP(normalized);
  if (version === 4) {
    return normalized.split(".")[0] === "127";
  }
  return (
    version === 6 &&
    (normalized === "::1" ||
      normalized === "0:0:0:0:0:0:0:1")
  );
}
