import { z } from "zod";
import { isCalendarDay } from "./calendar.js";
import {
  MAX_FIND_CHAT_MESSAGES_LIMIT,
  MAX_READ_CHAT_SLICE_COUNT,
  MAX_WEB_FETCH_TEXT_CHARS,
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

export const webSearchArgsSchema = z
  .object({ query: querySchema })
  .strict();

export const webFetchArgsSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .superRefine((value, context) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          context.addIssue({
            code: "custom",
            message: "Expected an absolute HTTPS URL.",
          });
          return;
        }
        if (url.protocol !== "https:") {
          context.addIssue({
            code: "custom",
            message: "Only HTTPS URLs are allowed.",
          });
        }
        if (url.username || url.password) {
          context.addIssue({
            code: "custom",
            message: "URL credentials are not allowed.",
          });
        }
        if (url.port && url.port !== "443") {
          context.addIssue({
            code: "custom",
            message: "Only the default HTTPS port is allowed.",
          });
        }
      }),
    max_chars: z
      .number()
      .int()
      .min(500)
      .max(MAX_WEB_FETCH_TEXT_CHARS)
      .default(2_400),
  })
  .strict();

export const webSearchResponseSchema = z
  .object({
    text: z.string().trim().max(8_000),
    sources: z
      .array(
        z
          .object({
            url: z
              .url()
              .refine(
                (value) =>
                  value.startsWith("https://") ||
                  value.startsWith("http://"),
                "Expected an HTTP(S) URL.",
              ),
            title: z.string().max(500).optional(),
            snippet: z.string().max(4_000).optional(),
            publishedAt: z.string().max(100).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const paperSearchArgsSchema = z
  .object({
    query: querySchema,
    source: z.enum(["arxiv", "europepmc"]).default("arxiv"),
    max_results: z.number().int().min(1).max(5).default(3),
  })
  .strict();

export const researchLookupArgsSchema = z
  .object({
    query: querySchema,
    limit: z.number().int().min(1).max(5).default(3),
  })
  .strict();

export const paperSearchResponseSchema = z
  .object({
    query: z.string().min(1).max(500),
    source: z.enum(["arxiv", "europepmc"]),
    papers: z
      .array(
        z
          .object({
            title: z.string().max(500),
            authors: z.array(z.string().max(200)).max(50),
            year: z.string().max(20).optional(),
            abstract: z.string().max(8_000).optional(),
            url: z
              .url()
              .refine(
                (value) =>
                  value.startsWith("https://") ||
                  value.startsWith("http://"),
                "Expected an HTTP(S) URL.",
              ),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

export const webFetchResponseSchema = z
  .object({
    url: publicHttpsResponseUrlSchema(),
    status: z.number().int().min(100).max(599),
    statusText: z.string().max(200).optional(),
    contentType: z.string().max(200),
    byteLength: z.number().int().min(0).max(1_000_000),
    text: z.string().max(MAX_WEB_FETCH_TEXT_CHARS),
    title: z.string().max(500).optional(),
    redirectUrl: publicHttpsResponseUrlSchema().optional(),
  })
  .strict();

/**
 * Deliberately strict: an HH gateway implementation that tries to expose a
 * source path, raw record, or other undeclared field fails closed here.
 */
export const researchGatewayResponseSchema = z
  .object({
    status: z.enum(["done", "empty"]),
    policy: z.literal("anonymized_research_only"),
    notice: z.string().trim().min(1).max(600),
    findings: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(1_500),
            as_of: z.string().max(32).nullable().optional(),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    limitations: z.array(z.string().trim().min(1).max(600)).max(5).optional(),
  })
  .strict();

export type RagBm25SearchArgs = z.infer<typeof ragBm25SearchArgsSchema>;
export type KeywordSearchArgs = z.infer<typeof keywordSearchArgsSchema>;
export type ReadChatSliceArgs = z.infer<typeof readChatSliceArgsSchema>;
export type DayDigestArgs = z.infer<typeof dayDigestArgsSchema>;
export type ThreadContextArgs = z.infer<
  typeof threadContextArgsSchema
>;
export type WebSearchArgs = z.infer<typeof webSearchArgsSchema>;
export type WebFetchArgs = z.infer<typeof webFetchArgsSchema>;
export type PaperSearchArgs = z.infer<typeof paperSearchArgsSchema>;
export type ResearchLookupArgs = z.infer<typeof researchLookupArgsSchema>;

function publicHttpsResponseUrlSchema() {
  return z
    .string()
    .url()
    .max(2_048)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password &&
        (!url.port || url.port === "443");
    }, "Expected a credential-free default-port HTTPS URL.");
}
