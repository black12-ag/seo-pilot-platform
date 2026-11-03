import { z } from "zod";
import {
  decideContentReviewInputSchema,
  requestContentReviewInputSchema,
  withdrawContentApprovalInputSchema,
} from "./contentReview";
import {
  CONTENT_CLAIM_LIMIT,
  CONTENT_SOURCE_LIMIT,
  contentClaimInputSchema,
  savedContentClaimSchema,
  savedContentSourceSchema,
} from "./contentEvidence";

export const CONTENT_MARKDOWN_BYTES = 200 * 1024;
const id = z.string().min(1).max(255);
const version = z.number().int().nonnegative();
const prose = z.string().max(10000);

export const contentActorSchema = z.strictObject({
  userId: id,
  organizationId: id,
  role: z.string().min(1).max(255),
  surface: z.enum(["web", "mcp", "sam"]),
});
export const contentStateSchema = z.enum([
  "brief",
  "draft",
  "review_requested",
  "changes_requested",
  "approved",
  "rejected",
  "privacy_erased",
]);
export const savedContentItemSchema = z.strictObject({
  id,
  projectId: id,
  title: z.string(),
  topic: z.string(),
  headVersion: version,
  state: contentStateSchema,
  archivedAtMs: z.number().int().nonnegative().nullable(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});
const contentRevisionSummarySchema = z.strictObject({
  id,
  version,
  parentRevisionId: id.nullable(),
  authorUserId: id.nullable(),
  surface: z.enum(["web", "mcp", "sam"]),
  createdAtMs: z.number().int().nonnegative(),
  redactedAtMs: z.number().int().nonnegative().nullable(),
});
export const contentRevisionPageSchema = z.strictObject({
  items: z.array(contentRevisionSummarySchema),
  nextCursor: id.nullable(),
});
export const contentItemPageSchema = z.strictObject({
  items: z.array(savedContentItemSchema),
  nextCursor: id.nullable(),
});
export const listContentInputSchema = z.strictObject({
  projectId: id,
  cursor: id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  state: contentStateSchema.optional(),
  archived: z.boolean().optional(),
});
export const contentLocaleSchema = z.strictObject({
  language: z.string().min(1).max(50),
  country: z.string().min(1).max(100),
});
export const getContentRevisionInputSchema = z.strictObject({
  projectId: id,
  contentId: id,
  revisionId: id.optional(),
  locale: contentLocaleSchema.optional(),
});
export const listContentRevisionsInputSchema = z.strictObject({
  projectId: id,
  contentId: id,
  cursor: id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const listContentSourcesInputSchema = z.strictObject({
  projectId: id,
  cursor: id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const exportContentRevisionInputSchema = z.strictObject({
  projectId: id,
  contentId: id,
  revisionId: id,
  format: z.enum(["markdown", "json"]),
});

export const contentBriefSchema = z.strictObject({
  target: z.string().max(2000),
  objective: prose,
  audience: prose,
  outputKind: z.string().min(1).max(100),
  topic: z.string().min(1).max(500),
  locale: contentLocaleSchema,
  freshnessMaxAgeDays: z.number().int().min(1).max(30).optional(),
});
export const contentMetadataSchema = z.strictObject({
  title: z.string().max(500),
  slug: z.string().max(500),
  description: z.string().max(2000),
  schemaSuggestion: z.string().max(10000),
});
const contentMarkdownSchema = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= CONTENT_MARKDOWN_BYTES,
    "Markdown exceeds the UTF-8 byte limit",
  );
export const createContentBriefInputSchema = z.strictObject({
  projectId: id,
  mutationId: id,
  expectedHeadVersion: z.literal(0),
  brief: contentBriefSchema,
});
export const saveContentRevisionInputSchema = z.strictObject({
  projectId: id,
  contentId: id,
  mutationId: id,
  expectedHeadVersion: version,
  expectedContextVersion: version,
  brief: contentBriefSchema,
  markdown: contentMarkdownSchema,
  metadata: contentMetadataSchema,
  sourceIds: z.array(id).max(CONTENT_SOURCE_LIMIT),
  claims: z.array(contentClaimInputSchema).max(CONTENT_CLAIM_LIMIT),
  openQuestions: z.array(prose).max(100),
  omissions: z.array(prose).max(100),
});
export const archiveContentInputSchema = z.strictObject({
  projectId: id,
  contentId: id,
  mutationId: id,
  expectedHeadVersion: version,
});

export const savedContentRevisionSchema = z.strictObject({
  id: id,
  projectId: id,
  contentId: id,
  version,
  parentRevisionId: id.nullable(),
  brief: contentBriefSchema,
  markdown: contentMarkdownSchema,
  metadata: contentMetadataSchema,
  contextJson: z.string(),
  contextVersion: version,
  contextHash: z.string(),
  sourceSetHash: z.string(),
  contentHash: z.string(),
  sourceIds: z.array(id).max(CONTENT_SOURCE_LIMIT),
  claims: z.array(savedContentClaimSchema).max(CONTENT_CLAIM_LIMIT),
  openQuestions: z.array(prose).max(100),
  omissions: z.array(prose).max(100),
  authorUserId: id.nullable(),
  surface: z.enum(["web", "mcp", "sam"]),
  createdAtMs: z.number().int().nonnegative(),
});
export const saveContentRevisionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    revision: savedContentRevisionSchema,
    headVersion: version,
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.literal("revision_conflict"),
    currentHeadVersion: version,
  }),
]);

export type ContentLocale = z.infer<typeof contentLocaleSchema>;
export type ContentRevisionPage = z.infer<typeof contentRevisionPageSchema>;
export type ContentItemPage = z.infer<typeof contentItemPageSchema>;
export type ContentActor = z.infer<typeof contentActorSchema>;
export type ListContentInput = z.infer<typeof listContentInputSchema>;
export type ListContentRevisionsInput = z.infer<
  typeof listContentRevisionsInputSchema
>;
export type ListContentSourcesInput = z.infer<
  typeof listContentSourcesInputSchema
>;
export type GetContentRevisionInput = z.infer<
  typeof getContentRevisionInputSchema
>;
export type ExportContentRevisionInput = z.infer<
  typeof exportContentRevisionInputSchema
>;
export type ContentBrief = z.infer<typeof contentBriefSchema>;
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;
export type CreateContentBriefInput = z.infer<
  typeof createContentBriefInputSchema
>;
export type SaveContentRevisionInput = z.infer<
  typeof saveContentRevisionInputSchema
>;
export type ArchiveContentInput = z.infer<typeof archiveContentInputSchema>;
export type SavedContentRevision = z.infer<typeof savedContentRevisionSchema>;
export type SaveContentRevisionResult = z.infer<
  typeof saveContentRevisionResultSchema
>;

const hash = z.string().min(1).max(128);
const contentWriteScopeSchema = z.strictObject({
  actor: contentActorSchema,
  membershipId: id.nullable(),
});
const contentCheckSetWriteSchema = z.strictObject({
  id,
  hash,
  ruleVersion: z.string().min(1).max(100),
  createdAtMs: z.number().int().nonnegative(),
  checks: z
    .array(
      z.strictObject({
        id,
        claimId: id.nullable(),
        field: z.string().nullable(),
        rule: z.string(),
        status: z.string(),
        severity: z.string(),
        explanation: z.string(),
      }),
    )
    .max(1000),
});
export const preparedRevisionWriteSchema = z.strictObject({
  mutationId: id,
  requestHash: hash,
  expectedHeadVersion: version,
  expectedContextVersion: version,
  sourceHashes: z
    .array(z.strictObject({ sourceId: id, textHash: hash }))
    .max(10),
  revision: savedContentRevisionSchema.omit({
    authorUserId: true,
    surface: true,
  }),
  checkSet: contentCheckSetWriteSchema,
});
export const preparedSourceWriteSchema = z.strictObject({
  mutationId: id,
  requestHash: hash,
  source: savedContentSourceSchema.omit({ createdByUserId: true }),
});
const preparedArchiveWriteSchema = z.strictObject({
  input: archiveContentInputSchema,
  requestHash: hash,
});
const preparedReviewRequestWriteSchema = z.strictObject({
  input: requestContentReviewInputSchema,
  requestId: id,
  requestHash: hash,
  createdAtMs: z.number().int().nonnegative(),
});
const preparedReviewEventWriteSchema = z.strictObject({
  input: z.union([
    decideContentReviewInputSchema,
    withdrawContentApprovalInputSchema,
  ]),
  eventId: id,
  requestHash: hash,
  expectedContextVersion: version,
  contextHash: hash,
  sourceSetHash: hash,
  checkSetHash: hash,
  createdAtMs: z.number().int().nonnegative(),
});
const contentMutationReceiptSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), resultId: id, replayed: z.boolean() }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["conflict", "revision_conflict"]),
  }),
]);
export type ContentWriteScope = z.infer<typeof contentWriteScopeSchema>;
export type PreparedRevisionWrite = z.infer<typeof preparedRevisionWriteSchema>;
export type PreparedSourceWrite = z.input<typeof preparedSourceWriteSchema>;
export type PreparedArchiveWrite = z.infer<typeof preparedArchiveWriteSchema>;
export type PreparedReviewRequestWrite = z.infer<
  typeof preparedReviewRequestWriteSchema
>;
export type PreparedReviewEventWrite = z.infer<
  typeof preparedReviewEventWriteSchema
>;
export type ContentMutationReceipt = z.infer<
  typeof contentMutationReceiptSchema
>;
