import type {
  BotRuntimeConfig,
  SafeBotRuntimeConfig,
} from "./contracts.js";

export function safeBotRuntimeConfig(
  config: Readonly<BotRuntimeConfig>,
): SafeBotRuntimeConfig {
  const {
    token: _token,
    webSearch,
    researchGateway,
    audioTranscribe,
    memoryWriteAuthorizerIds,
    ...safe
  } = config;
  return {
    ...safe,
    tokenConfigured: true,
    memoryWriteAuthorizerCount: memoryWriteAuthorizerIds.length,
    audioTranscribe: {
      endpoint: audioTranscribe.endpoint,
      timeoutMs: audioTranscribe.timeoutMs,
      bearerTokenConfigured: audioTranscribe.bearerToken !== undefined,
    },
    ...(webSearch === undefined
      ? {}
      : webSearch.kind === "http"
        ? {
            webSearch: {
              kind: "http",
              endpoint: webSearch.endpoint,
              bearerTokenConfigured:
                webSearch.bearerToken !== undefined,
            },
          }
        : {
            webSearch: {
              kind: "vertex",
              project: webSearch.project,
              model: webSearch.model,
              region: webSearch.region,
              maxOutputTokens: webSearch.maxOutputTokens,
              gcloudPathConfigured:
                webSearch.gcloudPath !== undefined,
            },
          }),
    ...(researchGateway === undefined
      ? {}
      : {
          researchGateway: {
            configured: true,
            timeoutMs: researchGateway.timeoutMs,
          },
        }),
  };
}
