import { z } from "zod";
import { hasOrgPermission } from "@/lib/org-permissions";
import { ContentRepository } from "@/server/features/content/repositories/ContentRepository";
import { ContentReviewRepository } from "@/server/features/content/repositories/ContentReviewRepository";
import { AppError } from "@/server/lib/errors";
import { sha256Hex } from "@/server/lib/audit/ids";
import type { ContentActor } from "@/types/schemas/content";
import { contentAccess } from "./contentAccess";
import { ContentService } from "./ContentService";
import { createContentCheckSet } from "./contentChecks";

async function getCurrentReview(
  actor: ContentActor,
  input: { projectId: string; contentId: string },
) {
  const review = await ContentReviewRepository.getReview(
    actor.organizationId,
    input.projectId,
    input.contentId,
  );
  await contentAccess(actor, input.projectId);
  return review;
}

const publishableInputSchema = z.strictObject({
  projectId: z.string().min(1).max(255),
  contentId: z.string().min(1).max(255),
  revisionId: z.string().min(1).max(255),
  expectedHeadVersion: z.number().int().nonnegative(),
});
export type PublishableInput = z.infer<typeof publishableInputSchema>;
type EligibilityReason =
  | "content_archived"
  | "head_changed"
  | "revision_unavailable"
  | "revision_erased"
  | "reviewer_unverifiable"
  | "review_missing"
  | "review_revision_changed"
  | "approval_withdrawn"
  | "review_not_approved"
  | "reviewer_removed"
  | "reviewer_permission_lost"
  | "context_changed"
  | "checks_changed"
  | "source_unavailable"
  | "source_changed"
  | "source_stale"
  | "checks_blocked"
  | "review_changed";

async function validateRead(
  read: Awaited<ReturnType<typeof ContentService.getRevision>>,
  checkSetId: string,
): Promise<{ reason: EligibilityReason } | { sourceHash: string }> {
  if (
    read.currentContextVersion !== read.revision.contextVersion ||
    (await sha256Hex(JSON.stringify(read.currentContextSnapshot))) !==
      read.revision.contextHash
  )
    return { reason: "context_changed" };
  if (
    checkSetId !== read.checks.id ||
    read.checks.contentHash !== read.revision.contentHash ||
    read.checks.contextHash !== read.revision.contextHash ||
    read.checks.sourceSetHash !== read.revision.sourceSetHash
  )
    return { reason: "checks_changed" };
  if (read.sources.some((source) => source.state === "unavailable"))
    return { reason: "source_unavailable" };
  const sources = read.sources.flatMap((entry) =>
    entry.source ? [entry.source] : [],
  );
  const sourceHash = await sha256Hex(
    JSON.stringify(
      sources.map(({ id, textHash, auditReference }) => ({
        id,
        textHash,
        auditReference,
      })),
    ),
  );
  if (sourceHash !== read.revision.sourceSetHash)
    return { reason: "source_changed" };
  const checks = await createContentCheckSet(
    read.revision,
    new Map(sources.map((source) => [source.id, source])),
    Date.now(),
  );
  if (checks.checks.some((check) => check.status === "stale"))
    return { reason: "source_stale" };
  if (checks.checks.some((check) => check.severity === "blocker"))
    return { reason: "checks_blocked" };
  return { sourceHash };
}

const reject = (reason: EligibilityReason) => ({
  eligible: false as const,
  reason,
});

export async function currentEligibility(
  actor: ContentActor,
  raw: PublishableInput,
) {
  const input = publishableInputSchema.parse(raw);
  const access = await contentAccess(actor, input.projectId);
  const item = await ContentRepository.getItemStatus(
    actor.organizationId,
    input.projectId,
    input.contentId,
  );
  if (!item) throw new AppError("NOT_FOUND");
  if (item.archivedAtMs !== null) return reject("content_archived");
  if (item.headVersion !== input.expectedHeadVersion)
    return reject("head_changed");
  const status = await ContentRepository.getRevisionStatus(
    actor.organizationId,
    input.projectId,
    input.contentId,
    input.revisionId,
  );
  if (!status) return reject("revision_unavailable");
  if (status.redactedAtMs !== null) return reject("revision_erased");
  if (status.version !== item.headVersion) return reject("head_changed");
  if (!access.membership) return reject("reviewer_unverifiable");
  const review = await getCurrentReview(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
  });
  if (!review) return reject("review_missing");
  if (review.revisionId !== input.revisionId)
    return reject("review_revision_changed");
  if (review.state !== "approved")
    return reject(
      review.state === "withdrawn"
        ? "approval_withdrawn"
        : "review_not_approved",
    );
  const approval = review.events.at(-1);
  if (
    !approval ||
    approval.decision !== "approve" ||
    approval.surface !== "web" ||
    !approval.reviewerUserId
  )
    return reject("reviewer_unverifiable");
  if (!approval.reviewerMembershipId) return reject("reviewer_removed");
  const reviewer = await ContentRepository.getMembership(
    actor.organizationId,
    approval.reviewerUserId,
  );
  if (!reviewer || reviewer.id !== approval.reviewerMembershipId)
    return reject("reviewer_removed");
  if (!hasOrgPermission(reviewer.role, { content: ["review"] }))
    return reject("reviewer_permission_lost");
  const read = await ContentService.getRevision(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
    revisionId: input.revisionId,
  });
  const validation = await validateRead(read, review.checkSetId);
  if ("reason" in validation) return reject(validation.reason);
  const sourceHash = validation.sourceHash;
  const [latestItem, latestReview, latestReviewer, version] = await Promise.all(
    [
      ContentRepository.getItemStatus(
        actor.organizationId,
        input.projectId,
        input.contentId,
      ),
      getCurrentReview(actor, {
        projectId: input.projectId,
        contentId: input.contentId,
      }),
      ContentRepository.getMembership(
        actor.organizationId,
        approval.reviewerUserId,
      ),
      ContentRepository.getContextVersion(
        actor.organizationId,
        input.projectId,
      ),
    ],
  );
  await contentAccess(actor, input.projectId);
  if (!latestItem || latestItem.archivedAtMs !== null)
    return reject("content_archived");
  if (latestItem.headVersion !== item.headVersion)
    return reject("head_changed");
  if (version !== read.revision.contextVersion)
    return reject("context_changed");
  if (!latestReviewer || latestReviewer.id !== approval.reviewerMembershipId)
    return reject("reviewer_removed");
  if (!hasOrgPermission(latestReviewer.role, { content: ["review"] }))
    return reject("reviewer_permission_lost");
  if (
    !latestReview ||
    latestReview.id !== review.id ||
    latestReview.version !== review.version ||
    latestReview.state !== "approved"
  )
    return reject("review_changed");
  const latestStatus = await ContentRepository.getRevisionStatus(
    actor.organizationId,
    input.projectId,
    input.contentId,
    input.revisionId,
  );
  if (!latestStatus || latestStatus.redactedAtMs !== null)
    return reject("revision_erased");
  const latestRead = await ContentService.getRevision(actor, {
    projectId: input.projectId,
    contentId: input.contentId,
    revisionId: input.revisionId,
  });
  if (latestRead.sources.some((source) => source.state === "unavailable"))
    return reject("source_unavailable");
  const latestSourceHash = await sha256Hex(
    JSON.stringify(
      latestRead.sources.flatMap((entry) =>
        entry.source
          ? [
              {
                id: entry.source.id,
                textHash: entry.source.textHash,
                auditReference: entry.source.auditReference,
              },
            ]
          : [],
      ),
    ),
  );
  if (latestSourceHash !== sourceHash) return reject("source_changed");
  if (latestRead.currentContextVersion !== read.revision.contextVersion)
    return reject("context_changed");
  if (
    latestRead.checks.id !== read.checks.id ||
    latestRead.checks.checkSetHash !== read.checks.checkSetHash
  )
    return reject("checks_changed");
  return {
    eligible: true as const,
    value: {
      projectId: input.projectId,
      contentId: input.contentId,
      revisionId: read.revision.id,
      headVersion: item.headVersion,
      markdown: read.revision.markdown,
      metadata: read.revision.metadata,
      locale: read.revision.brief.locale,
      contentHash: read.revision.contentHash,
      contextHash: read.revision.contextHash,
      sourceSetHash: read.revision.sourceSetHash,
      contextVersion: read.revision.contextVersion,
      checkSetId: read.checks.id,
      checkSetHash: read.checks.checkSetHash,
      review: {
        requestId: review.id,
        eventId: approval.id,
        version: review.version,
        reviewedAtMs: approval.createdAtMs,
      },
    },
  };
}
