import type {
  BotResearchGatewayRuntimeConfig,
  BotRuntimeEnvironment,
} from "./contracts.js";
import {
  absoluteSocketPath,
  integer,
} from "./env-rules.js";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The client needs only a runtime Unix-socket path. It never receives a
 * research root, database path, credential, report manifest, or filesystem
 * detail from the private HH application.
 */
export function optionalResearchGatewayConfig(
  env: BotRuntimeEnvironment,
): { researchGateway?: BotResearchGatewayRuntimeConfig } {
  const rawSocketPath = env.PARILKA_BOT_RESEARCH_GATEWAY_SOCKET;
  if (rawSocketPath === undefined || rawSocketPath.trim().length === 0) {
    return {};
  }
  return {
    researchGateway: {
      socketPath: absoluteSocketPath(
        rawSocketPath,
        "PARILKA_BOT_RESEARCH_GATEWAY_SOCKET",
      ),
      timeoutMs: integer(
        env.PARILKA_BOT_RESEARCH_GATEWAY_TIMEOUT_MS,
        "PARILKA_BOT_RESEARCH_GATEWAY_TIMEOUT_MS",
        DEFAULT_TIMEOUT_MS,
        1_000,
        60_000,
      ),
    },
  };
}
