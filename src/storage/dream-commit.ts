import { StoreCore } from "./core.js";
import {
  computeDreamAudit,
  type DreamAuditSnapshots,
} from "./dream-audit-codec.js";
import { renderDreamAuditPublication } from "./dream-publication-renderer.js";
import type { EnqueueDreamPublicationInput } from "./dream-publications.js";
import {
  MAX_FAST_TITLE_CHARS,
  MAX_LESSON_TITLE_CHARS,
  MAX_SKILL_NAME_CHARS,
  normalizedKnowledgeKey,
} from "./chat-knowledge.js";
import type {
  StoredChatLesson,
  StoredChatMemory,
  StoredChatSkill,
  StoredDreamDay,
  StoredFastChatMemory,
  UpsertChatLessonInput,
  UpsertChatMemoryInput,
  UpsertChatSkillInput,
  UpsertDreamDayInput,
  UpsertFastChatMemoryInput,
} from "./types.js";

export type CommitDreamDayInput = {
  day: UpsertDreamDayInput;
  memory?: UpsertChatMemoryInput;
  fast: readonly UpsertFastChatMemoryInput[];
  lessons: readonly UpsertChatLessonInput[];
  skills: readonly UpsertChatSkillInput[];
  deletedFastKeys?: readonly string[];
  deletedLessonKeys?: readonly string[];
  deletedSkillKeys?: readonly string[];
};

export abstract class DreamCommitMethods extends StoreCore {
  declare protected upsertFastChatMemoryLocked: (
    input: UpsertFastChatMemoryInput,
  ) => StoredFastChatMemory;
  declare protected upsertChatLessonLocked: (
    input: UpsertChatLessonInput,
  ) => StoredChatLesson;
  declare protected upsertChatSkillLocked: (
    input: UpsertChatSkillInput,
  ) => StoredChatSkill;
  declare protected upsertChatMemoryLocked: (
    input: UpsertChatMemoryInput,
  ) => StoredChatMemory;
  declare protected upsertDreamDayLocked: (
    input: UpsertDreamDayInput,
  ) => StoredDreamDay;
  declare protected deleteFastChatMemoryLocked: (chatId: string, key: string) => void;
  declare protected deleteChatLessonLocked: (chatId: string, key: string) => void;
  declare protected deleteChatSkillLocked: (chatId: string, key: string) => void;
  declare protected getChatMemory: (chatId: string) => StoredChatMemory | undefined;
  declare protected getDreamDay: (params: {
    chatId: string;
    day: string;
  }) => StoredDreamDay | undefined;
  declare protected listFastChatMemory: (
    chatId: string,
    limit?: number,
  ) => StoredFastChatMemory[];
  declare protected listChatLessons: (
    chatId: string,
    limit?: number,
  ) => StoredChatLesson[];
  declare protected listChatSkills: (
    chatId: string,
    limit?: number,
  ) => StoredChatSkill[];
  declare protected insertDreamAuditLocked: (input: {
    chatId: string;
    day: string;
    audit: ReturnType<typeof computeDreamAudit>;
    nowMs: number;
  }) => void;
  declare protected dreamAuditExistsLocked: (chatId: string, day: string) => boolean;
  declare protected enqueueDreamPublicationLocked: (
    input: EnqueueDreamPublicationInput,
  ) => unknown;

  commitDreamDay(input: CommitDreamDayInput): StoredDreamDay {
    if (input.day.status !== "completed") {
      throw new Error("commitDreamDay requires day.status === 'completed'.");
    }
    const chatId = input.day.chatId;

    // Normalize delete keys once, with correct per-layer limits, reject dupes.
    const deletedFast = normalizeDeleteKeys(
      input.deletedFastKeys ?? [],
      MAX_FAST_TITLE_CHARS,
      "fast",
    );
    const deletedLessons = normalizeDeleteKeys(
      input.deletedLessonKeys ?? [],
      MAX_LESSON_TITLE_CHARS,
      "lesson",
    );
    const deletedSkills = normalizeDeleteKeys(
      input.deletedSkillKeys ?? [],
      MAX_SKILL_NAME_CHARS,
      "skill",
    );

    assertNoOverlap(input, deletedFast, deletedLessons, deletedSkills);
    assertSameChatBundle(input, chatId);

    return this.immediateTransaction("commitDreamDay", () => {
      const day = input.day.day;

      if (this.dreamAuditExistsLocked(chatId, day)) {
        const existingDay = this.getDreamDay({ chatId, day });
        if (existingDay?.status !== "completed") {
          throw new Error(
            `Dream audit row exists for ${chatId}/${day} but day status is ${existingDay?.status ?? "missing"} (corruption).`,
          );
        }
        return existingDay;
      }

      const nowMs = input.day.updatedAtMs ?? Date.now();

      const before: DreamAuditSnapshots = {
        memoryBefore: this.getChatMemory(chatId),
        fastBefore: this.listFastChatMemory(chatId),
        lessonsBefore: this.listChatLessons(chatId),
        skillsBefore: this.listChatSkills(chatId),
        memoryAfter: undefined,
        fastAfter: [],
        lessonsAfter: [],
        skillsAfter: [],
      };

      for (const item of input.fast) this.upsertFastChatMemoryLocked(item);
      for (const item of input.lessons) this.upsertChatLessonLocked(item);
      for (const item of input.skills) this.upsertChatSkillLocked(item);
      if (input.memory !== undefined) this.upsertChatMemoryLocked(input.memory);

      for (const key of deletedFast) this.deleteFastChatMemoryLocked(chatId, key);
      for (const key of deletedLessons) this.deleteChatLessonLocked(chatId, key);
      for (const key of deletedSkills) this.deleteChatSkillLocked(chatId, key);

      const dayResult = this.upsertDreamDayLocked(input.day);

      before.memoryAfter = this.getChatMemory(chatId);
      before.fastAfter = this.listFastChatMemory(chatId);
      before.lessonsAfter = this.listChatLessons(chatId);
      before.skillsAfter = this.listChatSkills(chatId);

      const audit = computeDreamAudit(chatId, day, before, {
        fast: new Set(deletedFast),
        lessons: new Set(deletedLessons),
        skills: new Set(deletedSkills),
      });
      this.insertDreamAuditLocked({ chatId, day, audit, nowMs });
      const publication = renderDreamAuditPublication(audit, nowMs);
      if (publication !== undefined) {
        this.enqueueDreamPublicationLocked(publication);
      }

      return dayResult;
    });
  }
}

function normalizeDeleteKeys(
  keys: readonly string[],
  maxChars: number,
  kind: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new Error(`commitDreamDay deleted ${kind} key must be a non-empty string.`);
    }
    const nk = normalizedKnowledgeKey(raw, maxChars);
    if (seen.has(nk)) {
      throw new Error(`commitDreamDay duplicate deleted ${kind} key after normalization: "${raw}".`);
    }
    seen.add(nk);
    out.push(nk);
  }
  return out;
}

function assertSameChatBundle(input: CommitDreamDayInput, chatId: string): void {
  for (const item of input.fast) {
    if (item.chatId !== chatId) throw new Error("commitDreamDay fast write chatId mismatch.");
  }
  for (const item of input.lessons) {
    if (item.chatId !== chatId) throw new Error("commitDreamDay lesson write chatId mismatch.");
  }
  for (const item of input.skills) {
    if (item.chatId !== chatId) throw new Error("commitDreamDay skill write chatId mismatch.");
  }
  if (input.memory !== undefined && input.memory.chatId !== chatId) {
    throw new Error("commitDreamDay memory write chatId mismatch.");
  }
}

function assertNoOverlap(
  input: CommitDreamDayInput,
  deletedFast: string[],
  deletedLessons: string[],
  deletedSkills: string[],
): void {
  const fastUpsert = new Set(
    input.fast.map((i) => normalizedKnowledgeKey(i.title, MAX_FAST_TITLE_CHARS)),
  );
  for (const key of deletedFast) {
    if (fastUpsert.has(key)) {
      throw new Error(`commitDreamDay fast key appears in both upserts and deletes.`);
    }
  }
  const lessonUpsert = new Set(
    input.lessons.map((i) => normalizedKnowledgeKey(i.title, MAX_LESSON_TITLE_CHARS)),
  );
  for (const key of deletedLessons) {
    if (lessonUpsert.has(key)) {
      throw new Error(`commitDreamDay lesson key appears in both upserts and deletes.`);
    }
  }
  const skillUpsert = new Set(
    input.skills.map((i) => normalizedKnowledgeKey(i.name, MAX_SKILL_NAME_CHARS)),
  );
  for (const key of deletedSkills) {
    if (skillUpsert.has(key)) {
      throw new Error(`commitDreamDay skill key appears in both upserts and deletes.`);
    }
  }
}

export type DreamCommitApi = Pick<DreamCommitMethods, "commitDreamDay">;
