import { createHash } from "node:crypto";
import type { MessageStore } from "../store.js";
import type { DreamSnapshot } from "./types.js";

/**
 * Read-only snapshot of committed Dream state for one chat.
 * The content hash is deterministic and covers every field that affects output.
 */
export function captureDreamSnapshot(
  store: MessageStore,
  chatId: string,
): DreamSnapshot {
  const memory = store.getChatMemory(chatId);
  const fastMemory = store.listFastChatMemory(chatId);
  const lessons = store.listChatLessons(chatId);
  const skills = store.listChatSkills(chatId);

  const hash = createHash("sha256");
  hash.update("v1\n");
  hash.update(`chat:${chatId}\n`);

  if (memory) {
    hash.update(`mem:${memory.revision}:${memory.lastConsolidatedMessageId ?? "none"}\n`);
    hash.update(`memlen:${Array.from(memory.memoryText).length}\n`);
    hash.update(memory.memoryText);
    hash.update("\n");
  } else {
    hash.update("mem:none\n");
  }

  hash.update(`fast:${fastMemory.length}\n`);
  for (const entry of fastMemory) {
    hash.update(`fk:${entry.key}\n`);
    hash.update(`ft:${entry.title}\n`);
    hash.update(`fn:${entry.note}\n`);
    hash.update(`fu:${entry.updatedAtMs}\n`);
    if (entry.sourceMessageId !== undefined) {
      hash.update(`fs:${entry.sourceMessageId}\n`);
    }
  }

  hash.update(`lessons:${lessons.length}\n`);
  for (const lesson of lessons) {
    hash.update(`lk:${lesson.key}\n`);
    hash.update(`lt:${lesson.title}\n`);
    hash.update(`lp:${lesson.problem}\n`);
    hash.update(`ls:${lesson.solution}\n`);
    hash.update(`lw:${lesson.whenToApply}\n`);
    hash.update(`lu:${lesson.updatedAtMs}\n`);
    if (lesson.sourceMessageId !== undefined) {
      hash.update(`lm:${lesson.sourceMessageId}\n`);
    }
  }

  hash.update(`skills:${skills.length}\n`);
  for (const skill of skills) {
    hash.update(`sk:${skill.key}\n`);
    hash.update(`sn:${skill.name}\n`);
    hash.update(`sd:${skill.description}\n`);
    hash.update(`si:${skill.instructions}\n`);
    hash.update(`su:${skill.updatedAtMs}\n`);
    if (skill.sourceMessageId !== undefined) {
      hash.update(`sm:${skill.sourceMessageId}\n`);
    }
  }

  return {
    chatId,
    memory,
    fastMemory,
    lessons,
    skills,
    contentHash: hash.digest("hex"),
  };
}
