export type BotRuntimeMode = "live" | "shadow";

export interface BotWebSearchHttpRuntimeConfig {
  kind: "http";
  endpoint: string;
  bearerToken?: string;
}

export interface BotWebSearchVertexRuntimeConfig {
  kind: "vertex";
  project: string;
  model: string;
  region: string;
  maxOutputTokens: number;
  systemInstruction: string;
  gcloudPath?: string;
}

export type BotWebSearchRuntimeConfig =
  | BotWebSearchHttpRuntimeConfig
  | BotWebSearchVertexRuntimeConfig;

export interface BotResearchGatewayRuntimeConfig {
  socketPath: string;
  timeoutMs: number;
}

/** Machine-local Flov endpoint used only for audio sent to this bot. */
export interface BotAudioTranscribeRuntimeConfig {
  endpoint: string;
  timeoutMs: number;
  /** Optional bearer credential for a locally hardened Flov API. */
  bearerToken?: string;
}

export interface BotRuntimeConfig {
  token: string;
  exclusivePollerConfirmed: true;
  allowedChatId: string;
  botId: string;
  botUsername: string;
  botDisplayName: string;
  chatTitle: string;
  historyDescription: string;
  approximateMemberCount?: number;
  /** Private allowlist of immutable Telegram user IDs permitted to write chat memory. */
  memoryWriteAuthorizerIds: readonly string[];
  dbPath: string;
  modelConfigPath: string;
  webSearch?: BotWebSearchRuntimeConfig;
  researchGateway?: BotResearchGatewayRuntimeConfig;
  audioTranscribe: BotAudioTranscribeRuntimeConfig;
  /** Loopback SearXNG JSON API origin. Default http://127.0.0.1:8080. */
  searxngEndpoint: string;
  /** Loopback Firecrawl v2 API origin. Default http://127.0.0.1:3002. */
  firecrawlEndpoint: string;
  mode: BotRuntimeMode;
  workerConcurrency: number;
  triggerCooldownMs: number;
  updateMaxAttempts: number;
  initialOffset?: number;
  pollTimeoutSec: number;
  pollLimit: number;
  pollBackoffInitialMs: number;
  pollBackoffMaxMs: number;
  modelStepTimeoutMs: number;
  publishTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export type SafeBotRuntimeConfig = Omit<
  BotRuntimeConfig,
  | "token"
  | "webSearch"
  | "researchGateway"
  | "audioTranscribe"
  | "memoryWriteAuthorizerIds"
> & {
  tokenConfigured: true;
  memoryWriteAuthorizerCount: number;
  audioTranscribe: Omit<BotAudioTranscribeRuntimeConfig, "bearerToken"> & {
    bearerTokenConfigured: boolean;
  };
  webSearch?:
    | {
        kind: "http";
        endpoint: string;
        bearerTokenConfigured: boolean;
      }
    | {
        kind: "vertex";
        project: string;
        model: string;
        region: string;
        maxOutputTokens: number;
        gcloudPathConfigured: boolean;
      };
  researchGateway?: {
    configured: true;
    timeoutMs: number;
  };
};

export type BotRuntimeEnvironment = Readonly<
  Record<string, string | undefined>
>;
