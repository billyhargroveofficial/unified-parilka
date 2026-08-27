import type {
  CachedChatSearchResult,
  CachedDigestResult,
  DigestCacheQuery,
} from "../read-tools.js";
import type { StoredMessage } from "../../store.js";

/**
 * Deliberately narrow read boundary for the pre-turn packet.  It is
 * structural, so CanonicalBotReadCache can be wired in later without a new
 * storage or model-facing tool surface.
 */
export interface CausalRagCache {
  search(params: {
    chatId: string;
    query: string;
    limit: number;
    signal: AbortSignal;
    beforeId: number;
  }): Promise<CachedChatSearchResult>;
  getDigests(params: DigestCacheQuery): CachedDigestResult;
}

export interface CausalRagInput {
  readonly chatId: string;
  readonly triggerMessageId: number;
  readonly triggerText: string;
  /** May contain the trigger; the builder always removes it. */
  readonly context: readonly StoredMessage[];
  readonly replyTarget?: StoredMessage;
  readonly signal?: AbortSignal;
}

export type CausalRagSource =
  | {
      readonly label: string;
      readonly kind: "context" | "history";
      /** Host-only provenance. Never rendered into `packet`. */
      readonly messageId: number;
    }
  | {
      readonly label: string;
      readonly kind: "digest";
      readonly dayFrom: string;
      readonly dayTo: string;
    };

export interface CausalRagPacket {
  /** Untrusted material to append to the current user input. */
  readonly packet: string;
  /** Host-only attribution map for a later Telegram citation renderer. */
  readonly sources: readonly CausalRagSource[];
  readonly historyAttempted: boolean;
  readonly historyDegraded: boolean;
  readonly digestAttempted: boolean;
  readonly digestDegraded: boolean;
}
