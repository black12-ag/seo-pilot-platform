import { z } from "zod";
import { CONTENT_CLAIM_LIMIT } from "./contentEvidence";

const id = z.string().min(1).max(255);
const version = z.number().int().nonnegative();
export const getContentReviewInputSchema = z.strictObject({
  projectId: id,
  contentId: id,
  requestId: id.optional(),
});
export const requestContentReviewInputSchema = z.strictObject({
  projectId: id,
  contentId: id,
  revisionId: id,
  mutationId: id,
  expectedHeadVersion: version,
  expectedContextVersion: version,
  checkSetId: id,
  assigneeUserId: id,
});
export const decideContentReviewInputSchema = z.strictObject({
  projectId: id,
  contentId: id,
  requestId: id,
  mutationId: id,
  expectedRequestVersion: version,
  expectedHeadVersion: version,
  decision: z.enum(["approve", "request_changes", "reject", "cancel"]),
  claimAssessments: z
    .array(
      z.strictObject({
        claimId: id,
        assessment: z.enum([
          "supported",
          "unsupported",
          "contradicted",
          "not_applicable",
        ]),
        reason: z.string().max(10000),
      }),
    )
    .max(CONTENT_CLAIM_LIMIT),
  assessedRemainingText: z.boolean(),
  reason: z.string().max(10000),
});
export const withdrawContentApprovalInputSchema = z.strictObject({
  projectId: id,
  contentId: id,
  requestId: id,
  mutationId: id,
  expectedRequestVersion: version,
  expectedHeadVersion: version,
  reason: z.string().max(10000),
});

const savedContentReviewEventSchema = z.strictObject({
  id,
  requestId: id,
  requestVersion: version,
  revisionId: id,
  reviewerUserId: id.nullable(),
  reviewerMembershipId: id.nullable(),
  decision: z.enum([
    "approve",
    "request_changes",
    "reject",
    "cancel",
    "withdraw",
  ]),
  surface: z.enum(["web", "mcp", "sam"]),
  reason: z.string(),
  assessedRemainingText: z.boolean(),
  createdAtMs: z.number().int().nonnegative(),
  claimAssessments: z
    .array(
      z.strictObject({
        claimId: id,
        assessment: z.enum([
          "supported",
          "unsupported",
          "contradicted",
          "not_applicable",
        ]),
        reason: z.string(),
      }),
    )
    .max(CONTENT_CLAIM_LIMIT),
});
export const savedContentReviewSchema = z.strictObject({
  id,
  projectId: id,
  contentId: id,
  revisionId: id,
  checkSetId: id,
  assigneeUserId: id.nullable(),
  requestedByUserId: id.nullable(),
  version,
  sequence: version,
  state: z.enum([
    "pending",
    "approved",
    "changes_requested",
    "rejected",
    "cancelled",
    "withdrawn",
  ]),
  contextVersion: version,
  createdAtMs: z.number().int().nonnegative(),
  events: z.array(savedContentReviewEventSchema),
});

export type RequestContentReviewInput = z.infer<
  typeof requestContentReviewInputSchema
>;
export type GetContentReviewInput = z.infer<typeof getContentReviewInputSchema>;
export type DecideContentReviewInput = z.infer<
  typeof decideContentReviewInputSchema
>;
export type WithdrawContentApprovalInput = z.infer<
  typeof withdrawContentApprovalInputSchema
>;
export type SavedContentReview = z.infer<typeof savedContentReviewSchema>;
