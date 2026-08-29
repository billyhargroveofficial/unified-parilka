import type {
  StoredChatLesson,
  StoredChatMemory,
  StoredChatSkill,
  StoredFastChatMemory,
} from "../storage/types.js";

/** Deterministic snapshot of committed Dream state for one chat. */
export interface DreamSnapshot {
  chatId: string;
  memory: StoredChatMemory | undefined;
  fastMemory: StoredFastChatMemory[];
  lessons: StoredChatLesson[];
  skills: StoredChatSkill[];
  /** Bounded deterministic content hash of the snapshot payload. */
  contentHash: string;
}

export interface ManagedSkill {
  dirName: string;
  sourceKey: string;
  skill: StoredChatSkill;
  contentHash: string;
}

export interface ManagedLessonAggregate {
  dirName: string;
  lessons: StoredChatLesson[];
  /** Provenance of the newest sorted lesson (deterministic aggregate). */
  sourceMessageId: number | null;
  updatedAtMs: number;
  contentHash: string;
}

export interface MemoryRenderPlan {
  /** Parsed, trimmed, non-empty owner entries in their original order. */
  ownerEntries: string[];
  /** Serialized managed semantic entry, or "" when absent. */
  semanticEntry: string;
  /** Serialized managed fast entries, newest-first. */
  fastEntries: string[];
  /** Codepoint length of the owner entries joined by the delimiter. */
  ownerChars: number;
  /** Codepoint length of all managed entries joined by the delimiter. */
  managedChars: number;
  /** Codepoint length of owner + semantic + all fast entries joined by the delimiter. */
  combinedChars: number;
}

export interface MemoryAssembledContent {
  /** Final MEMORY.md content: owner entries first, then semantic, then the fast prefix. */
  content: string;
  /** Number of managed entries actually present in the content. */
  managedEntries: number;
}

export interface ProjectionReport {
  ok: boolean;
  mode: "dry_run" | "applied" | "skipped_disabled";
  chatId: string;
  dbPath: string;
  profileHome: string;
  contentHash: string;
  memory: {
    status: "ok" | "skipped" | "failed" | "oversize";
    managedEntries: number;
    ownerChars: number;
    totalChars: number;
    limit: number;
    error?: string;
  };
  skills: {
    status: "ok" | "skipped" | "failed";
    created: number;
    updated: number;
    removed: number;
    lessonsCount: number;
    error?: string;
  };
  lock?: {
    mechanism: string;
    acquired: boolean;
  };
}

export interface ProjectionOptions {
  apply: boolean;
  dbPath: string;
  chatId: string;
  profileHome: string;
  lockTimeoutMs: number;
}

export interface MemoryLock {
  release(): void;
}
