import { ZodError, z } from "zod";
import {
  MAX_FAST_NOTE_CHARS,
  MAX_FAST_TITLE_CHARS,
  MAX_KNOWLEDGE_QUERY_CHARS,
  MAX_LESSON_FIELD_CHARS,
  MAX_LESSON_TITLE_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  MAX_SKILL_NAME_CHARS,
} from "../store.js";
import type {
  StoredChatLesson,
  StoredChatSkill,
  StoredFastChatMemory,
} from "../store.js";

export const BOT_MEMORY_READ_TOOL_NAMES = [
  "search_long_memory",
  "load_chat_skill",
] as const;

export const BOT_MEMORY_WRITE_TOOL_NAMES = [
  "remember_fast",
  "remember_lesson",
  "save_chat_skill",
] as const;

export const BOT_MEMORY_TOOL_NAMES = [
  ...BOT_MEMORY_READ_TOOL_NAMES,
  ...BOT_MEMORY_WRITE_TOOL_NAMES,
] as const;

export type BotMemoryToolName = (typeof BOT_MEMORY_TOOL_NAMES)[number];
export type BotMemoryReadToolName = (typeof BOT_MEMORY_READ_TOOL_NAMES)[number];
export type BotMemoryWriteToolName = (typeof BOT_MEMORY_WRITE_TOOL_NAMES)[number];

export interface BotMemoryToolDefinition {
  readonly name: BotMemoryToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const BOT_MEMORY_TOOL_DEFINITIONS: readonly BotMemoryToolDefinition[] = [
  {
    name: "search_long_memory",
    description:
      "Поиск по долгим урокам именно этого чата. Используй, когда нужен ранее сохранённый вывод «проблема → решение → когда применять», а не сырая история сообщений.",
    inputSchema: objectSchema(
      {
        query: stringProperty(1, MAX_KNOWLEDGE_QUERY_CHARS, "Короткий поисковый запрос."),
        limit: integerProperty(1, 12, "Число уроков, по умолчанию 6."),
      },
      ["query"],
    ),
  },
  {
    name: "load_chat_skill",
    description:
      "Загружает полную инструкцию одного сохранённого навыка чата по его имени. Индекс навыков уже виден в контексте; не загружай всё подряд.",
    inputSchema: objectSchema(
      {
        name: stringProperty(1, MAX_SKILL_NAME_CHARS, "Имя навыка из индекса."),
      },
      ["name"],
    ),
  },
  {
    name: "remember_fast",
    description:
      "Сохраняет или обновляет короткую оперативную заметку для следующих ходов. Доступен только когда авторизованный владелец прямо попросил запомнить/обновить память.",
    inputSchema: objectSchema(
      {
        title: stringProperty(1, MAX_FAST_TITLE_CHARS, "Короткий устойчивый ключ заметки."),
        note: stringProperty(1, MAX_FAST_NOTE_CHARS, "Проверенный краткий факт или договорённость."),
      },
      ["title", "note"],
    ),
  },
  {
    name: "remember_lesson",
    description:
      "Сохраняет или обновляет долгий урок: конкретная проблема, проверенное решение и когда его применять. Доступен только по прямой просьбе авторизованного владельца сохранить это на будущее.",
    inputSchema: objectSchema(
      {
        title: stringProperty(1, MAX_LESSON_TITLE_CHARS, "Короткое имя урока."),
        problem: stringProperty(1, MAX_LESSON_FIELD_CHARS, "Что именно сломалось или было трудно."),
        solution: stringProperty(1, MAX_LESSON_FIELD_CHARS, "Проверенное решение или правило."),
        when_to_apply: stringProperty(1, MAX_LESSON_FIELD_CHARS, "Условия повторного применения."),
      },
      ["title", "problem", "solution", "when_to_apply"],
    ),
  },
  {
    name: "save_chat_skill",
    description:
      "Сохраняет или обновляет чатовый навык: имя, короткое назначение и подробный playbook. Доступен только когда авторизованный владелец прямо просит создать или обновить навык.",
    inputSchema: objectSchema(
      {
        name: stringProperty(1, MAX_SKILL_NAME_CHARS, "Имя навыка."),
        description: stringProperty(1, MAX_SKILL_DESCRIPTION_CHARS, "Однострочное назначение для индекса."),
        instructions: stringProperty(1, MAX_SKILL_INSTRUCTIONS_CHARS, "Проверенный пошаговый playbook без секретов."),
      },
      ["name", "description", "instructions"],
    ),
  },
];

export interface BotMemoryStore {
  searchChatLessons(input: {
    chatId: string;
    query: string;
    limit?: number;
  }): StoredChatLesson[];
  getChatSkill(input: {
    chatId: string;
    name: string;
  }): StoredChatSkill | undefined;
  upsertFastChatMemory(input: {
    chatId: string;
    title: string;
    note: string;
    sourceMessageId?: number;
  }): StoredFastChatMemory;
  upsertChatLesson(input: {
    chatId: string;
    title: string;
    problem: string;
    solution: string;
    whenToApply: string;
    sourceMessageId?: number;
  }): StoredChatLesson;
  upsertChatSkill(input: {
    chatId: string;
    name: string;
    description: string;
    instructions: string;
    sourceMessageId?: number;
  }): StoredChatSkill;
}

export interface BotMemoryToolCallContext {
  readonly chatId: string;
  readonly sourceMessageId: number;
  /** Immutable Bot API user ID of the addressed trigger, if it had one. */
  readonly senderId?: string;
  readonly allowWrite: boolean;
}

export type BotMemoryToolResult =
  | {
      ok: true;
      tool: BotMemoryToolName;
      status: "done" | "empty";
      result: Record<string, unknown>;
    }
  | {
      ok: false;
      tool: string;
      error: {
        code:
          | "invalid_arguments"
          | "unknown_tool"
          | "write_not_authorized"
          | "storage_error";
        retryable: boolean;
        message: string;
      };
    };

const searchLongMemoryArgs = z
  .object({
    query: z.string().trim().min(1).max(MAX_KNOWLEDGE_QUERY_CHARS),
    limit: z.number().int().min(1).max(12).default(6),
  })
  .strict();

const loadChatSkillArgs = z
  .object({ name: z.string().trim().min(1).max(MAX_SKILL_NAME_CHARS) })
  .strict();

const rememberFastArgs = z
  .object({
    title: z.string().trim().min(1).max(MAX_FAST_TITLE_CHARS),
    note: z.string().trim().min(1).max(MAX_FAST_NOTE_CHARS),
  })
  .strict();

const rememberLessonArgs = z
  .object({
    title: z.string().trim().min(1).max(MAX_LESSON_TITLE_CHARS),
    problem: z.string().trim().min(1).max(MAX_LESSON_FIELD_CHARS),
    solution: z.string().trim().min(1).max(MAX_LESSON_FIELD_CHARS),
    when_to_apply: z.string().trim().min(1).max(MAX_LESSON_FIELD_CHARS),
  })
  .strict();

const saveChatSkillArgs = z
  .object({
    name: z.string().trim().min(1).max(MAX_SKILL_NAME_CHARS),
    description: z.string().trim().min(1).max(MAX_SKILL_DESCRIPTION_CHARS),
    instructions: z.string().trim().min(1).max(MAX_SKILL_INSTRUCTIONS_CHARS),
  })
  .strict();

const MAX_MEMORY_TOOL_OUTPUT_CHARS = 4_000;

export class BotMemoryTools {
  readonly #store: BotMemoryStore;
  readonly #writeAuthorizerIds: ReadonlySet<string>;

  constructor(options: {
    store: BotMemoryStore;
    writeAuthorizerIds?: readonly string[];
  }) {
    this.#store = options.store;
    this.#writeAuthorizerIds = new Set(
      options.writeAuthorizerIds ?? [],
    );
  }

  /**
   * The caller supplies only a Bot API sender ID from the durable trigger.
   * Usernames, message text and model-controlled data never take part here.
   */
  isWriteAuthorizer(senderId: string | undefined): boolean {
    return senderId !== undefined && this.#writeAuthorizerIds.has(senderId);
  }

  listTools(): readonly BotMemoryToolDefinition[] {
    return BOT_MEMORY_TOOL_DEFINITIONS;
  }

  callTool(
    name: string,
    rawArgs: unknown,
    context: BotMemoryToolCallContext,
  ): BotMemoryToolResult {
    if (!isBotMemoryToolName(name)) {
      return failure(name, "unknown_tool", "Unknown memory tool.");
    }
    if (
      isWriteToolName(name) &&
      (!context.allowWrite || !this.isWriteAuthorizer(context.senderId))
    ) {
      return failure(
        name,
        "write_not_authorized",
        "This turn is not authorized to write chat memory.",
      );
    }

    try {
      switch (name) {
        case "search_long_memory": {
          const input = searchLongMemoryArgs.parse(rawArgs ?? {});
          const lessons = this.#store.searchChatLessons({
            chatId: context.chatId,
            query: input.query,
            limit: input.limit,
          });
          return success(name, lessons.length === 0 ? "empty" : "done", {
            query: input.query,
            lessons: lessons.map(projectLesson),
          });
        }
        case "load_chat_skill": {
          const input = loadChatSkillArgs.parse(rawArgs ?? {});
          const skill = this.#store.getChatSkill({
            chatId: context.chatId,
            name: input.name,
          });
          return success(name, skill ? "done" : "empty", {
            name: input.name,
            ...(skill === undefined ? {} : { skill: projectSkill(skill) }),
          });
        }
        case "remember_fast": {
          const input = rememberFastArgs.parse(rawArgs ?? {});
          const stored = this.#store.upsertFastChatMemory({
            chatId: context.chatId,
            title: input.title,
            note: input.note,
            sourceMessageId: context.sourceMessageId,
          });
          return success(name, "done", {
            saved: "fast_memory",
            title: stored.title,
            sourceMessageId: stored.sourceMessageId,
          });
        }
        case "remember_lesson": {
          const input = rememberLessonArgs.parse(rawArgs ?? {});
          const stored = this.#store.upsertChatLesson({
            chatId: context.chatId,
            title: input.title,
            problem: input.problem,
            solution: input.solution,
            whenToApply: input.when_to_apply,
            sourceMessageId: context.sourceMessageId,
          });
          return success(name, "done", {
            saved: "long_lesson",
            title: stored.title,
            sourceMessageId: stored.sourceMessageId,
          });
        }
        case "save_chat_skill": {
          const input = saveChatSkillArgs.parse(rawArgs ?? {});
          const stored = this.#store.upsertChatSkill({
            chatId: context.chatId,
            name: input.name,
            description: input.description,
            instructions: input.instructions,
            sourceMessageId: context.sourceMessageId,
          });
          return success(name, "done", {
            saved: "chat_skill",
            name: stored.name,
            sourceMessageId: stored.sourceMessageId,
          });
        }
      }
    } catch (error) {
      if (error instanceof ZodError) {
        return failure(name, "invalid_arguments", "Invalid memory tool arguments.");
      }
      return failure(name, "storage_error", "Memory storage operation failed.");
    }
  }
}

function success(
  tool: BotMemoryToolName,
  status: "done" | "empty",
  result: Record<string, unknown>,
): BotMemoryToolResult {
  return {
    ok: true,
    tool,
    status,
    result: boundMemoryResult(result),
  };
}

function failure(
  tool: string,
  code: Extract<BotMemoryToolResult, { ok: false }> ["error"]["code"],
  message: string,
): BotMemoryToolResult {
  return {
    ok: false,
    tool,
    error: { code, retryable: false, message },
  };
}

function isBotMemoryToolName(value: string): value is BotMemoryToolName {
  return (BOT_MEMORY_TOOL_NAMES as readonly string[]).includes(value);
}

function isWriteToolName(value: BotMemoryToolName): value is BotMemoryWriteToolName {
  return (BOT_MEMORY_WRITE_TOOL_NAMES as readonly string[]).includes(value);
}

function projectLesson(lesson: StoredChatLesson): Record<string, unknown> {
  return {
    title: lesson.title,
    problem: lesson.problem,
    solution: lesson.solution,
    whenToApply: lesson.whenToApply,
    ...(lesson.sourceMessageId === undefined
      ? {}
      : { sourceMessageId: lesson.sourceMessageId }),
  };
}

function projectSkill(skill: StoredChatSkill): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    ...(skill.sourceMessageId === undefined
      ? {}
      : { sourceMessageId: skill.sourceMessageId }),
  };
}

function boundMemoryResult(result: Record<string, unknown>): Record<string, unknown> {
  const root = structuredClone(result);
  let truncated = false;
  while (JSON.stringify(root).length > MAX_MEMORY_TOOL_OUTPUT_CHARS) {
    const slot = longestStringSlot(root);
    if (slot && slot.value.length > 64) {
      const marker = "…[TRUNCATED]";
      slot.parent[slot.key] =
        `${slot.value.slice(0, Math.max(32, slot.value.length - 512 - marker.length))}${marker}`;
      markTruncated(root, truncated);
      truncated = true;
      continue;
    }
    const array = longestArray(root);
    if (array && array.value.length > 0) {
      array.value.pop();
      markTruncated(root, truncated);
      truncated = true;
      continue;
    }
    return { projection: { truncated: true, maxCharacters: MAX_MEMORY_TOOL_OUTPUT_CHARS } };
  }
  return root;
}

function markTruncated(root: Record<string, unknown>, alreadyMarked: boolean): void {
  if (!alreadyMarked) {
    root.projection = {
      truncated: true,
      maxCharacters: MAX_MEMORY_TOOL_OUTPUT_CHARS,
    };
  }
}

function longestStringSlot(root: Record<string, unknown>):
  | { parent: Record<string, unknown>; key: string; value: string }
  | undefined {
  let selected:
    | { parent: Record<string, unknown>; key: string; value: string }
    | undefined;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") {
        if (!selected || child.length > selected.value.length) {
          selected = { parent: value as Record<string, unknown>, key, value: child };
        }
      } else {
        visit(child);
      }
    }
  };
  visit(root);
  return selected;
}

function longestArray(root: Record<string, unknown>): { value: unknown[] } | undefined {
  let selected: { value: unknown[] } | undefined;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (!selected || value.length > selected.value.length) {
        selected = { value };
      }
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) {
        visit(child);
      }
    }
  };
  visit(root);
  return selected;
}

function stringProperty(
  minLength: number,
  maxLength: number,
  description: string,
): Record<string, unknown> {
  return { type: "string", minLength, maxLength, description };
}

function integerProperty(
  minimum: number,
  maximum: number,
  description: string,
): Record<string, unknown> {
  return { type: "integer", minimum, maximum, description };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
