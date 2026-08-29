import { createHash } from "node:crypto";
import type {
  StoredChatLesson,
  StoredChatSkill,
} from "../storage/types.js";
import { codepointLength } from "./render-memory.js";

const SKILL_DIR_PREFIX = "parilka-skill-";
export const LESSONS_DIR = "parilka-lessons";
const MAX_SKILL_DESC_CODEPOINTS = 60;
const MAX_LESSONS_FILE_CODEPOINTS = 100_000;

export function skillDirName(key: string): string {
  return `${SKILL_DIR_PREFIX}${createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * Render SKILL.md for a single bot_chat_skill. The frontmatter name is
 * exactly the directory name and all scalars are JSON-quoted; the description
 * is truncated to 60 Unicode codepoints.
 */
export function renderSkillMd(
  skill: StoredChatSkill,
  dirName: string,
): string {
  const description = truncateCodepoints(
    skill.description,
    MAX_SKILL_DESC_CODEPOINTS,
  );
  const provenance = `source: ${skill.key} msg: ${skill.sourceMessageId ?? "none"} updated: ${skill.updatedAtMs}`;
  return [
    "---",
    `name: ${JSON.stringify(dirName)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    `**Description:** ${skill.description}`,
    "",
    "**Instructions:**",
    "",
    skill.instructions.trim(),
    "",
    `*Provenance: ${provenance}*`,
    "",
  ].join("\n");
}

/**
 * Render SKILL.md for the aggregated lessons. Lessons are newest-first and the
 * final file never exceeds 100000 Unicode codepoints including separators,
 * the omission footer, and the final newline — the actual candidate string is
 * measured. Each entry carries source key, source message id, and updated
 * time.
 */
export function renderLessonsSkillMd(lessons: StoredChatLesson[]): string {
  const header = [
    "---",
    `name: ${JSON.stringify(LESSONS_DIR)}`,
    `description: ${JSON.stringify(
      "Parilka lessons: problem-solution patterns from chat history",
    )}`,
    "---",
    "",
    "# Parilka Lessons",
    "",
  ].join("\n");
  const sorted = [...lessons].sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs || b.key.localeCompare(a.key),
  );
  const parts: string[] = [];
  for (const lesson of sorted) {
    const entry = formatLessonEntry(lesson, parts.length + 1);
    const omitted = sorted.length - (parts.length + 1);
    const footer =
      omitted > 0 ? `\n\n*${omitted} lesson(s) omitted (skill size limit)*` : "";
    const candidate = `${header}${parts.length > 0 ? `\n${parts.join("\n")}` : ""}${entry}${footer}\n`;
    if (codepointLength(candidate) > MAX_LESSONS_FILE_CODEPOINTS) {
      break;
    }
    parts.push(entry);
  }
  const omitted = sorted.length - parts.length;
  const footer =
    omitted > 0 ? `\n\n*${omitted} lesson(s) omitted (skill size limit)*` : "";
  return `${header}${parts.length > 0 ? `\n${parts.join("\n")}` : ""}${footer}\n`;
}

function formatLessonEntry(lesson: StoredChatLesson, index: number): string {
  const provenance = `source: ${lesson.key} msg: ${lesson.sourceMessageId ?? "none"} updated: ${lesson.updatedAtMs}`;
  return [
    "",
    `## ${index}. ${lesson.title}`,
    "",
    `**Problem:** ${lesson.problem}`,
    "",
    `**Solution:** ${lesson.solution}`,
    "",
    `**When to apply:** ${lesson.whenToApply}`,
    "",
    `*Provenance: ${provenance}*`,
  ].join("\n");
}

export function skillContentHash(
  skill: StoredChatSkill,
  dirName: string,
): string {
  return createHash("sha256").update(renderSkillMd(skill, dirName)).digest("hex");
}

export function lessonsContentHash(lessons: StoredChatLesson[]): string {
  return createHash("sha256")
    .update(renderLessonsSkillMd(lessons))
    .digest("hex");
}

function truncateCodepoints(text: string, maxCodepoints: number): string {
  const codepoints = Array.from(text);
  if (codepoints.length <= maxCodepoints) return text;
  return codepoints.slice(0, maxCodepoints - 3).join("") + "...";
}
