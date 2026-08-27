import { z } from "zod";
import { isCalendarDay } from "./calendar.js";
import {
  MAX_FIND_CHAT_MESSAGES_LIMIT,
  MAX_READ_CHAT_SLICE_COUNT,
  type BotReadToolName,
} from "./contracts.js";

const querySchema = z.string().trim().min(1).max(500);
const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.")
  .refine(isCalendarDay, "Expected a real Gregorian calendar date.");

export const ragBm25SearchArgsSchema = z
  .object({
    query: querySchema,
    limit: z.number().int().min(1).max(8).default(5),
  })
  .strict();

export const keywordSearchArgsSchema = z
  .object({
    query: querySchema,
    match: z.enum(["all", "any", "phrase", "prefix"]).default("all"),
    sender: z.string().trim().min(1).max(200).optional(),
    day_from: calendarDaySchema.optional(),
    day_to: calendarDaySchema.optional(),
    before_id: z.number().int().positive().safe().optional(),
    after_id: z.number().int().positive().safe().optional(),
    order: z.enum(["relevance", "newest", "oldest"]).default("relevance"),
    include_bot: z.boolean().default(true),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_FIND_CHAT_MESSAGES_LIMIT)
      .default(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.day_to !== undefined && value.day_from === undefined) {
      context.addIssue({
        code: "custom",
        path: ["day_to"],
        message: "day_to requires day_from.",
      });
    }
  });

const transcriptCursorSchema = z.string().trim().min(1).max(512);
const skillNameSchema = z.string().trim().min(1).max(120);

export const readChatSliceArgsSchema = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("recent"),
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_READ_CHAT_SLICE_COUNT)
          .optional(),
        cursor: transcriptCursorSchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.count !== undefined && value.cursor !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["cursor"],
            message: "Pass either count or cursor, not both.",
          });
        }
        if (value.count === undefined && value.cursor === undefined) {
          context.addIssue({
            code: "custom",
            path: ["count"],
            message: "recent requires count or a continuation cursor.",
          });
        }
      }),
    z
      .object({
        mode: z.literal("period"),
        day_from: calendarDaySchema.optional(),
        day_to: calendarDaySchema.optional(),
        cursor: transcriptCursorSchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.cursor !== undefined) {
          if (value.day_from !== undefined || value.day_to !== undefined) {
            context.addIssue({
              code: "custom",
              path: ["cursor"],
              message: "Pass either period days or cursor, not both.",
            });
          }
          return;
        }
        if (value.day_from === undefined) {
          context.addIssue({
            code: "custom",
            path: ["day_from"],
            message: "period requires day_from or a continuation cursor.",
          });
        }
      }),
  ]);

export const dayDigestArgsSchema = z
  .object({
    day_from: calendarDaySchema,
    day_to: calendarDaySchema.optional(),
  })
  .strict();

export const threadContextArgsSchema = z
  .object({
    message_id: z.number().int().positive().safe(),
    before: z.number().int().min(0).max(30).default(8),
    after: z.number().int().min(0).max(30).default(8),
  })
  .strict();

export const loadChatSkillArgsSchema = z
  .object({
    name: skillNameSchema,
  })
  .strict();

export type RagBm25SearchArgs = z.infer<typeof ragBm25SearchArgsSchema>;
export type KeywordSearchArgs = z.infer<typeof keywordSearchArgsSchema>;
export type ReadChatSliceArgs = z.infer<typeof readChatSliceArgsSchema>;
export type DayDigestArgs = z.infer<typeof dayDigestArgsSchema>;
export type ThreadContextArgs = z.infer<
  typeof threadContextArgsSchema
>;
export type LoadChatSkillArgs = z.infer<typeof loadChatSkillArgsSchema>;

/**
 * Validate model-supplied arguments before any selector reaches Telegram's
 * transient progress UI. The returned object contains only schema-owned
 * fields/defaults; rejected calls stay invisible until their bounded failure.
 */
export function validatedBotReadToolProgressInput(
  name: BotReadToolName,
  rawArgs: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const input = rawArgs ?? {};
  const result = (() => {
    switch (name) {
      case "rag_bm25_search": return ragBm25SearchArgsSchema.safeParse(input);
      case "keyword_search": return keywordSearchArgsSchema.safeParse(input);
      case "read_chat_slice": return readChatSliceArgsSchema.safeParse(input);
      case "day_digest": return dayDigestArgsSchema.safeParse(input);
      case "thread_context": return threadContextArgsSchema.safeParse(input);
      case "load_chat_skill": return loadChatSkillArgsSchema.safeParse(input);
    }
  })();
  return result.success
    ? result.data as Readonly<Record<string, unknown>>
    : undefined;
}
