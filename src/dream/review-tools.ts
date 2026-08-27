import type {
  StoredChatMemory,
  StoredChatSkill,
  StoredFastChatMemory,
  StoredChatLesson,
  UpsertChatSkillInput,
  UpsertFastChatMemoryInput,
  UpsertChatLessonInput,
} from "../store.js";
import { findSimilarSkill, patchSkill } from "./skill-manager.js";

type ToolSet = Record<string, { execute?: (input: unknown) => Promise<unknown> }>;

/** Local host-tool shape; no AI SDK runtime is loaded by Dream. */
function tool<T extends { execute: (input: unknown) => Promise<unknown> }>(definition: T): T {
  return definition;
}

function jsonSchema<T>(schema: T): T {
  return schema;
}

export interface DreamKnowledgeStore {
  getChatMemory(chatId: string): StoredChatMemory | undefined;
  listFastChatMemory(chatId: string, limit?: number): StoredFastChatMemory[];
  upsertFastChatMemory(input: UpsertFastChatMemoryInput): StoredFastChatMemory;
  listChatLessons(chatId: string, limit?: number): StoredChatLesson[];
  searchChatLessons(input: { chatId: string; query: string; limit?: number }): StoredChatLesson[];
  upsertChatLesson(input: UpsertChatLessonInput): StoredChatLesson;
  listChatSkills(chatId: string, limit?: number): StoredChatSkill[];
  getChatSkill(input: { chatId: string; name: string }): StoredChatSkill | undefined;
  upsertChatSkill(input: UpsertChatSkillInput): StoredChatSkill;
}

export type RememberFastInput = Omit<
  UpsertFastChatMemoryInput,
  "updatedAtMs"
>;

export type RememberLessonInput = Omit<
  UpsertChatLessonInput,
  "updatedAtMs"
>;

export type SaveSkillInput = Omit<UpsertChatSkillInput, "updatedAtMs">;

export interface DreamDeletionStore {
  deleteFastChatMemory(chatId: string, key: string): void;
  deleteChatLesson(chatId: string, key: string): void;
  deleteChatSkill(chatId: string, key: string): void;
}

export interface ReviewToolContext {
  chatId: string;
  sourceMessageId: number;
  nowMs: number;
  store: DreamKnowledgeStore;
  deletionStore?: DreamDeletionStore;
}

export const reviewSearchLongMemorySchema = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      maxLength: 240,
      description: "Short search query in any language.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

export const reviewLoadChatSkillSchema = {
  type: "object" as const,
  properties: {
    name: {
      type: "string" as const,
      maxLength: 120,
      description: "Exact skill name.",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

export const reviewRememberFastSchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string" as const,
      maxLength: 160,
      description: "Short unique title for the note.",
    },
    note: {
      type: "string" as const,
      maxLength: 800,
      description: "Compact fact with sender attribution.",
    },
  },
  required: ["title", "note"],
  additionalProperties: false,
};

export const reviewRememberLessonSchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string" as const,
      maxLength: 160,
      description: "Short lesson title.",
    },
    problem: {
      type: "string" as const,
      maxLength: 1200,
      description: "What went wrong or what to avoid.",
    },
    solution: {
      type: "string" as const,
      maxLength: 1200,
      description: "The corrected approach or accepted solution.",
    },
    whenToApply: {
      type: "string" as const,
      maxLength: 1200,
      description: "When this lesson is relevant.",
    },
  },
  required: ["title", "problem", "solution", "whenToApply"],
  additionalProperties: false,
};

export const reviewSaveChatSkillSchema = {
  type: "object" as const,
  properties: {
    name: {
      type: "string" as const,
      maxLength: 120,
      description: "Short unique skill name.",
    },
    description: {
      type: "string" as const,
      maxLength: 400,
      description: "One-line index for similarity search.",
    },
    instructions: {
      type: "string" as const,
      maxLength: 4000,
      description: "Full playbook: triggers, procedure, pitfalls, verification.",
    },
  },
  required: ["name", "description", "instructions"],
  additionalProperties: false,
};

export const reviewDeleteFastSchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string" as const,
      maxLength: 160,
      description: "Exact title of the fast-memory note to delete.",
    },
  },
  required: ["title"],
  additionalProperties: false,
};

export const reviewDeleteLessonSchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string" as const,
      maxLength: 160,
      description: "Exact title of the lesson to delete.",
    },
  },
  required: ["title"],
  additionalProperties: false,
};

export const reviewDeleteSkillSchema = {
  type: "object" as const,
  properties: {
    name: {
      type: "string" as const,
      maxLength: 120,
      description: "Exact name of the skill to delete.",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

export type ReviewToolName =
  | "review_search_long_memory"
  | "review_load_chat_skill"
  | "review_remember_fast"
  | "review_remember_lesson"
  | "review_save_chat_skill"
  | "review_delete_fast"
  | "review_delete_lesson"
  | "review_delete_skill";

export type ReviewJsonSchema = {
  readonly type: "object";
  readonly properties: Record<string, {
    readonly type: "string";
    readonly maxLength: number;
    readonly description: string;
  }>;
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
};

export type ReviewDynamicTool = {
  readonly name: ReviewToolName;
  readonly description: string;
  readonly inputSchema: ReviewJsonSchema;
};

/** Schemas sent to the Dream model runner. Keep these model-facing only. */
export const REVIEW_DYNAMIC_TOOLS: readonly ReviewDynamicTool[] = [
  {
    name: "review_search_long_memory",
    description: "Search existing long-memory semantic summary, lessons and skills for relevant context.",
    inputSchema: reviewSearchLongMemorySchema,
  },
  {
    name: "review_load_chat_skill",
    description: "Load the full instructions of an existing chat-local skill by name. Use this before patching a skill.",
    inputSchema: reviewLoadChatSkillSchema,
  },
  {
    name: "review_remember_fast",
    description: "Store a short, chat-wide hot fact that should affect upcoming turns.",
    inputSchema: reviewRememberFastSchema,
  },
  {
    name: "review_remember_lesson",
    description: "Store a durable problem → solution → when-to-use lesson learned from a correction or successful outcome.",
    inputSchema: reviewRememberLessonSchema,
  },
  {
    name: "review_save_chat_skill",
    description: "Create or patch a reusable class-level skill, not a one-off answer.",
    inputSchema: reviewSaveChatSkillSchema,
  },
  {
    name: "review_delete_fast",
    description: "Delete a stale fast-memory note by its title.",
    inputSchema: reviewDeleteFastSchema,
  },
  {
    name: "review_delete_lesson",
    description: "Delete a stale lesson by its title.",
    inputSchema: reviewDeleteLessonSchema,
  },
  {
    name: "review_delete_skill",
    description: "Delete a stale skill by its name.",
    inputSchema: reviewDeleteSkillSchema,
  },
];

export type ReviewToolDispatch = (
  name: string,
  input: unknown,
) => Promise<string>;

export function buildReviewToolSet(context: ReviewToolContext): ToolSet {
  return {
    review_search_long_memory: tool({
      description:
        "Search existing long-memory semantic summary, lessons and skills for relevant context.",
      inputSchema: jsonSchema<Record<string, unknown>>(reviewSearchLongMemorySchema),
      execute: async (input) => {
        const args = input as { query: string };
        const memory = context.store.getChatMemory(context.chatId);
        const lessons = context.store.searchChatLessons({
          chatId: context.chatId,
          query: args.query,
          limit: 6,
        });
        const skills = context.store.listChatSkills(context.chatId, 12);
        const fast = context.store.listFastChatMemory(context.chatId, 12);
        return JSON.stringify(
          {
            memory: memory?.memoryText ?? "",
            fast: fast.map((m) => ({ title: m.title, note: m.note })),
            lessons: lessons.map((l) => ({
              title: l.title,
              problem: l.problem,
              solution: l.solution,
              whenToApply: l.whenToApply,
            })),
            skills: skills.map((s) => ({ name: s.name, description: s.description })),
          },
          null,
          2,
        );
      },
    }),
    review_load_chat_skill: tool({
      description:
        "Load the full instructions of an existing chat-local skill by name. Use this before patching a skill.",
      inputSchema: jsonSchema<Record<string, unknown>>(reviewLoadChatSkillSchema),
      execute: async (input) => {
        const args = input as { name: string };
        const skill = context.store.getChatSkill({
          chatId: context.chatId,
          name: args.name,
        });
        if (!skill) {
          return JSON.stringify({ found: false, name: args.name });
        }
        return JSON.stringify(
          {
            found: true,
            name: skill.name,
            description: skill.description,
            instructions: skill.instructions,
          },
          null,
          2,
        );
      },
    }),
    review_remember_fast: tool({
      description:
        "Store a short, chat-wide hot fact that should affect upcoming turns. Use only for stable agreements or precisely attributed facts, not for every line.",
      inputSchema: jsonSchema<Record<string, unknown>>(reviewRememberFastSchema),
      execute: async (input) => {
        const args = input as { title: string; note: string };
        const upsertInput: RememberFastInput = {
          chatId: context.chatId,
          title: args.title,
          note: args.note,
          sourceMessageId: context.sourceMessageId,
        };
        context.store.upsertFastChatMemory(upsertInput);
        return JSON.stringify({ ok: true, title: args.title });
      },
    }),
    review_remember_lesson: tool({
      description:
        "Store a durable problem → solution → when-to-use lesson learned from a correction or successful outcome.",
      inputSchema: jsonSchema<Record<string, unknown>>(reviewRememberLessonSchema),
      execute: async (input) => {
        const args = input as {
          title: string;
          problem: string;
          solution: string;
          whenToApply: string;
        };
        const upsertInput: RememberLessonInput = {
          chatId: context.chatId,
          title: args.title,
          problem: args.problem,
          solution: args.solution,
          whenToApply: args.whenToApply,
          sourceMessageId: context.sourceMessageId,
        };
        context.store.upsertChatLesson(upsertInput);
        return JSON.stringify({ ok: true, title: args.title });
      },
    }),
    review_save_chat_skill: tool({
      description:
        "Create or patch a reusable class-level skill. First search/list skills and load the most similar existing skill; patch it when applicable, otherwise create a new one. Skills must contain triggers, procedure, pitfalls, and verification steps — not a single date or answer.",
      inputSchema: jsonSchema<Record<string, unknown>>(reviewSaveChatSkillSchema),
      execute: async (input) => {
        const args = input as {
          name: string;
          description: string;
          instructions: string;
        };
        // Default limit is MAX_CHAT_SKILLS; do not pass a larger value —
        // listChatSkills hard-rejects limits above the exported max.
        const allSkills = context.store.listChatSkills(context.chatId);
        const similar = findSimilarSkill(allSkills, {
          name: args.name,
          description: args.description,
        });
        if (similar) {
          context.store.upsertChatSkill(
            patchSkill(similar, {
              chatId: context.chatId,
              name: similar.name,
              description: args.description,
              instructions: args.instructions,
              sourceMessageId: context.sourceMessageId,
            }),
          );
        } else {
          context.store.upsertChatSkill({
            chatId: context.chatId,
            name: args.name,
            description: args.description,
            instructions: args.instructions,
            sourceMessageId: context.sourceMessageId,
          });
        }
        return JSON.stringify({ ok: true, name: args.name, patched: similar != null });
      },
    }),
    review_delete_fast: tool({
      description:
        "Delete a stale fast-memory note by its title. Use only for facts that are no longer true, outdated, or were stored by mistake.",
      inputSchema: jsonSchema<Record<string, unknown>>(reviewDeleteFastSchema),
      execute: async (input) => {
        const args = input as { title: string };
        if (!context.deletionStore) {
          return JSON.stringify({ ok: false, error: "Deletion not available in this context." });
        }
        context.deletionStore.deleteFastChatMemory(context.chatId, args.title);
        return JSON.stringify({ ok: true, deleted: args.title });
      },
    }),
    review_delete_lesson: tool({
      description:
        "Delete a stale lesson by its title. Use only for lessons that are no longer relevant, were learned from a one-time event, or have been superseded.",
      inputSchema: jsonSchema<Record<string, unknown>>(reviewDeleteLessonSchema),
      execute: async (input) => {
        const args = input as { title: string };
        if (!context.deletionStore) {
          return JSON.stringify({ ok: false, error: "Deletion not available in this context." });
        }
        context.deletionStore.deleteChatLesson(context.chatId, args.title);
        return JSON.stringify({ ok: true, deleted: args.title });
      },
    }),
    review_delete_skill: tool({
      description:
        "Delete a stale skill by its name. Use only for skills that are obsolete, have been replaced, or were created in error.",
      inputSchema: jsonSchema<Record<string, unknown>>(reviewDeleteSkillSchema),
      execute: async (input) => {
        const args = input as { name: string };
        if (!context.deletionStore) {
          return JSON.stringify({ ok: false, error: "Deletion not available in this context." });
        }
        context.deletionStore.deleteChatSkill(context.chatId, args.name);
        return JSON.stringify({ ok: true, deleted: args.name });
      },
    }),
  };
}

/**
 * Host-side dispatcher for Responses function tools. It validates the raw
 * model arguments before they reach a staged store, so malformed calls
 * cannot partially mutate the current review attempt. The context is never
 * model-provided: chat and source-message identity stay injected here.
 */
export function buildReviewToolDispatcher(
  context: ReviewToolContext,
): ReviewToolDispatch {
  const tools = buildReviewToolSet(context) as Record<string, unknown>;
  const definitions = new Map(
    REVIEW_DYNAMIC_TOOLS.map((definition) => [definition.name, definition]),
  );
  return async (name: string, input: unknown): Promise<string> => {
    const definition = definitions.get(name as ReviewToolName);
    if (!definition) {
      throw reviewToolInputError("unknown_tool");
    }
    assertReviewToolInput(definition.inputSchema, input);
    const execute = (tools[name] as {
      execute?: (args: unknown) => Promise<unknown>;
    } | undefined)?.execute;
    if (!execute) {
      // Treat a programming/configuration fault as fail-closed too: there is
      // no generic fallback that might accidentally expose a wider tool set.
      throw reviewToolInputError("tool_unavailable");
    }
    const result = await execute(input);
    return typeof result === "string" ? result : JSON.stringify(result);
  };
}

function assertReviewToolInput(
  schema: ReviewJsonSchema,
  input: unknown,
): asserts input is Record<string, string> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw reviewToolInputError("invalid_arguments");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw reviewToolInputError("unexpected_argument");
  }
  for (const key of schema.required) {
    const value = record[key];
    const property = schema.properties[key];
    if (
      property === undefined ||
      typeof value !== "string" ||
      value.length > property.maxLength
    ) {
      throw reviewToolInputError("invalid_arguments");
    }
  }
}

function reviewToolInputError(code: string): Error {
  return Object.assign(new Error("Dream review tool arguments are invalid."), {
    name: "DreamReviewToolInputError",
    code,
  });
}
