import { z } from "zod";
import {
  CONTENT_SOURCE_BYTES,
  contentUrlCaptureSchema,
} from "./contentSourceIntake";

export const CONTENT_SOURCE_LIMIT = 10;
export const CONTENT_CLAIM_LIMIT = 100;
export const CONTENT_CLAIM_EVIDENCE_LIMIT = 10;

const id = z.string().min(1).max(255);
const sourceText = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= CONTENT_SOURCE_BYTES,
    "Source exceeds the UTF-8 byte limit",
  );

export const contentSourceInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pasted"),
    title: z.string().trim().min(1).max(500),
    attribution: z.string().trim().min(1).max(500),
    text: sourceText,
    publisherDate: z.string().max(50).nullable(),
    language: z.string().max(50).nullable(),
    market: z.string().max(100).nullable(),
  }),
  z.strictObject({
    kind: z.literal("audit"),
    auditId: id,
    pageId: id.nullable(),
    issueId: id.nullable(),
  }),
]);

export const captureContentSourceInputSchema = z.strictObject({
  projectId: id,
  mutationId: id,
  source: contentSourceInputSchema,
});

const contentClaimEvidenceInputSchema = z.strictObject({
  sourceId: id,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  excerpt: sourceText,
  relation: z.enum(["supports", "contradicts", "background"]),
});

export const contentClaimInputSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("markdown"),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal("metadata"),
      field: z.enum(["title", "slug", "description", "schemaSuggestion"]),
    }),
  ]),
  text: z.string().min(1).max(10000),
  kind: z.enum([
    "product",
    "security",
    "financial",
    "legal",
    "general",
    "opinion",
  ]),
  factual: z.boolean(),
  evidence: z
    .array(contentClaimEvidenceInputSchema)
    .max(CONTENT_CLAIM_EVIDENCE_LIMIT),
});

export const savedContentClaimSchema = contentClaimInputSchema.extend({
  id: id,
  textHash: z.string(),
  evidence: z
    .array(
      contentClaimEvidenceInputSchema.extend({
        id: id,
        excerptHash: z.string(),
        passageId: z.string(),
      }),
    )
    .max(CONTENT_CLAIM_EVIDENCE_LIMIT),
});

export const savedContentSourceSchema = z.strictObject({
  id,
  projectId: id,
  kind: z.enum(["pasted", "audit", "web"]),
  title: z.string(),
  attribution: z.string(),
  sourceText,
  textHash: z.string(),
  capturedAtMs: z.number().int().nonnegative(),
  publisherDate: z.string().nullable(),
  language: z.string().nullable(),
  market: z.string().nullable(),
  extractionMethod: z.string(),
  extractionVersion: z.string(),
  extractionStatus: z.string(),
  extractionReason: z.string().nullable(),
  createdByUserId: id.nullable(),
  urlCapture: contentUrlCaptureSchema.nullable().default(null),
  auditReference: z
    .strictObject({
      auditId: id,
      pageId: id.nullable(),
      issueId: id.nullable(),
    })
    .nullable(),
});
const contentSourceSummarySchema = z.strictObject({
  id,
  title: z.string(),
  kind: z.enum(["pasted", "audit", "web"]),
  capturedAtMs: z.number().int().nonnegative(),
  extractionStatus: z.string(),
  available: z.boolean(),
});
export const contentSourcePageSchema = z.strictObject({
  items: z.array(contentSourceSummarySchema),
  nextCursor: id.nullable(),
});
export const savedContentCheckSetSchema = z.strictObject({
  id,
  projectId: id,
  contentId: id,
  revisionId: id,
  checkSetHash: z.string(),
  contentHash: z.string(),
  contextHash: z.string(),
  sourceSetHash: z.string(),
  ruleVersion: z.string(),
  createdAtMs: z.number().int().nonnegative(),
  checks: z.array(
    z.strictObject({
      id,
      claimId: id.nullable(),
      field: z.string().nullable(),
      rule: z.string(),
      status: z.string(),
      severity: z.string(),
      explanation: z.string(),
    }),
  ),
});

export type ContentSourceInput = z.infer<typeof contentSourceInputSchema>;
export type SavedContentSource = z.infer<typeof savedContentSourceSchema>;
export type SavedContentCheckSet = z.infer<typeof savedContentCheckSetSchema>;
export type CaptureContentSourceInput = z.infer<
  typeof captureContentSourceInputSchema
>;
export type ContentClaimInput = z.infer<typeof contentClaimInputSchema>;
