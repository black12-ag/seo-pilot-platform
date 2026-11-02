import { hasOrgPermission } from "@/lib/org-permissions";
import { ContentRepository } from "@/server/features/content/repositories/ContentRepository";
import { ContentReviewRepository } from "@/server/features/content/repositories/ContentReviewRepository";
import { AppError } from "@/server/lib/errors";
import { sha256Hex } from "@/server/lib/audit/ids";
import type { ContentActor } from "@/types/schemas/content";
import {
  decideContentReviewInputSchema,
  getContentReviewInputSchema,
  requestContentReviewInputSchema,
  withdrawContentApprovalInputSchema,
  type DecideContentReviewInput,
  type GetContentReviewInput,
  type RequestContentReviewInput,
  type WithdrawContentApprovalInput,
  type SavedContentReview,
} from "@/types/schemas/contentReview";
import { contentAccess } from "./contentAccess";
import { ContentService } from "./ContentService";
import { createContentCheckSet } from "./contentChecks";
import {
  currentEligibility,
  type PublishableInput,
} from "./contentEligibility";

function reviewAt(
  review: SavedContentReview,
  eventId?: string,
): SavedContentReview {
  if (!eventId) return { ...review, version: 0, state: "pending", events: [] };
  const reviewEvent = review.events.find((entry) => entry.id === eventId);
  if (!reviewEvent) throw new AppError("CONFLICT", "review_unavailable");
  const states = {
    approve: "approved",
    request_changes: "changes_requested",
    reject: "rejected",
    cancel: "cancelled",
    withdraw: "withdrawn",
  } as const;
  return {
    ...review,
    version: reviewEvent.requestVersion,
    state: states[reviewEvent.decision],
    events: review.events.filter(
      (entry) => entry.requestVersion <= reviewEvent.requestVersion,
    ),
  };
}

async function get(actor: ContentActor, raw: GetContentReviewInput) {
  const input = getContentReviewInputSchema.parse(raw);
  await contentAccess(actor, input.projectId);
  const review = await ContentReviewRepository.getReview(
    actor.organizationId,
    input.projectId,
    input.contentId,
    input.requestId,
  );
  await contentAccess(actor, input.projectId);
  return review;
}

async function request(actor: ContentActor, raw: RequestContentReviewInput) {
  const input = requestContentReviewInputSchema.parse(raw);
  const access = await contentAccess(actor, input.projectId);
  if (!access.membership)
    throw new AppError("CONFLICT", "reviewer_unverifiable");
  const hash = await sha256Hex(JSON.stringify(input));
  const prior = await ContentRepository.getMutation(
    actor.organizationId,
    input.projectId,
    input.mutationId,
  );
  if (prior) {
    if (prior.kind !== "review_request" || prior.requestHash !== hash)
      throw new AppError("CONFLICT", "mutation_id_conflict");
    const review = await get(actor, {
      projectId: input.projectId,
      contentId: input.contentId,
      requestId: prior.resultId,
    });
    if (!review) throw new AppError("CONFLICT", "review_unavailable");
    return reviewAt(review);
  }
  const read = await ContentService.getRevision(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
    revisionId: input.revisionId,
  });
  if (
    read.revision.version !== input.expectedHeadVersion ||
    read.currentContextVersion !== input.expectedContextVersion ||
    read.revision.contextVersion !== input.expectedContextVersion ||
    read.checks.id !== input.checkSetId
  )
    throw new AppError("CONFLICT", "review_inputs_changed");
  if (read.sources.some((source) => source.state === "unavailable"))
    throw new AppError("CONFLICT", "source_unavailable");
  const receipt = await ContentReviewRepository.requestReview(
    { actor: access.scope, membershipId: access.membership.id },
    {
      input,
      requestId: crypto.randomUUID(),
      requestHash: hash,
      createdAtMs: Date.now(),
    },
  );
  await contentAccess(actor, input.projectId);
  if (!receipt.ok) throw new AppError("CONFLICT", receipt.code);
  const result = await get(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
    requestId: receipt.resultId,
  });
  if (!result) throw new AppError("CONFLICT", "review_unavailable");
  return reviewAt(result);
}

async function event(
  actor: ContentActor,
  input: DecideContentReviewInput | WithdrawContentApprovalInput,
) {
  const access = await contentAccess(actor, input.projectId);
  if (actor.surface !== "web")
    throw new AppError("FORBIDDEN", "human_web_required");
  if (!access.membership)
    throw new AppError("CONFLICT", "reviewer_unverifiable");
  const withdrawing = !("decision" in input);
  if (
    (!("decision" in input) || input.decision !== "cancel") &&
    !hasOrgPermission(access.scope.role, { content: ["review"] })
  )
    throw new AppError("FORBIDDEN", "review_permission_required");
  const hash = await sha256Hex(JSON.stringify(input));
  const prior = await ContentRepository.getMutation(
    actor.organizationId,
    input.projectId,
    input.mutationId,
  );
  if (prior) {
    if (
      prior.kind !== (withdrawing ? "review_withdraw" : "review_decision") ||
      prior.requestHash !== hash
    )
      throw new AppError("CONFLICT", "mutation_id_conflict");
    const review = await get(actor, {
      projectId: input.projectId,
      contentId: input.contentId,
      requestId: input.requestId,
    });
    if (!review || !review.events.some((entry) => entry.id === prior.resultId))
      throw new AppError("CONFLICT", "review_unavailable");
    return reviewAt(review, prior.resultId);
  }
  const review = await get(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
    requestId: input.requestId,
  });
  if (!review) throw new AppError("NOT_FOUND");
  const read = await ContentService.getRevision(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
    revisionId: review.revisionId,
  });
  if (
    read.currentContextVersion !== read.revision.contextVersion ||
    read.checks.id !== review.checkSetId
  )
    throw new AppError("CONFLICT", "review_inputs_changed");
  if (read.sources.some((source) => source.state === "unavailable"))
    throw new AppError("CONFLICT", "source_unavailable");
  if ("decision" in input && input.decision === "approve") {
    const assessments = new Map(
      input.claimAssessments.map((assessment) => [
        assessment.claimId,
        assessment,
      ]),
    );
    if (
      !input.assessedRemainingText ||
      assessments.size !== input.claimAssessments.length ||
      assessments.size !== read.revision.claims.length ||
      read.revision.claims.some((claim) => !assessments.has(claim.id))
    )
      throw new AppError("VALIDATION_ERROR", "claim_assessment_incomplete");
    if (
      read.revision.claims.some(
        (claim) =>
          claim.factual &&
          ["product", "security", "financial", "legal"].includes(claim.kind) &&
          (assessments.get(claim.id)?.assessment !== "supported" ||
            !claim.evidence.some((entry) => entry.relation === "supports") ||
            claim.evidence.some((entry) => entry.relation === "contradicts")),
      )
    )
      throw new AppError("VALIDATION_ERROR", "sensitive_claim_unsupported");
    const currentChecks = await createContentCheckSet(
      read.revision,
      new Map(
        read.sources.flatMap((entry) =>
          entry.source ? [[entry.sourceId, entry.source] as const] : [],
        ),
      ),
      Date.now(),
    );
    if (currentChecks.checks.some((check) => check.status === "stale"))
      throw new AppError("CONFLICT", "source_stale");
    if (currentChecks.checks.some((check) => check.severity === "blocker"))
      throw new AppError("CONFLICT", "checks_blocked");
  }
  const write = {
    input,
    eventId: crypto.randomUUID(),
    requestHash: hash,
    expectedContextVersion: read.revision.contextVersion,
    contextHash: read.revision.contextHash,
    sourceSetHash: read.revision.sourceSetHash,
    checkSetHash: read.checks.checkSetHash,
    createdAtMs: Date.now(),
  };
  const scope = { actor: access.scope, membershipId: access.membership.id };
  const receipt = withdrawing
    ? await ContentReviewRepository.withdrawApproval(scope, write)
    : await ContentReviewRepository.decideReview(scope, write);
  await contentAccess(actor, input.projectId);
  if (!receipt.ok) throw new AppError("CONFLICT", receipt.code);
  const result = await get(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
    requestId: input.requestId,
  });
  if (!result) throw new AppError("CONFLICT", "review_unavailable");
  return reviewAt(result, receipt.resultId);
}
async function decide(actor: ContentActor, raw: DecideContentReviewInput) {
  return event(actor, decideContentReviewInputSchema.parse(raw));
}
async function withdraw(
  actor: ContentActor,
  raw: WithdrawContentApprovalInput,
) {
  return event(actor, withdrawContentApprovalInputSchema.parse(raw));
}

async function requirePublishableRevision(
  actor: ContentActor,
  input: PublishableInput,
) {
  const result = await currentEligibility(actor, input);
  if (!result.eligible)
    throw new AppError("CONFLICT", result.reason, { reason: result.reason });
  return result.value;
}

export const ContentReviewService = {
  get,
  request,
  decide,
  withdraw,
  currentEligibility,
  requirePublishableRevision,
} as const;
