import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  contentItems,
  contentMutations,
  contentReviewRequests,
  contentReviewEvents,
  contentClaimAssessments,
  member,
  projects,
} from "@/db/schema";
import { hasOrgPermission } from "@/lib/org-permissions";
import { lockProject } from "@/server/features/site-authority/repositories/siteAuthorityProjectWrites";
import { savedContentReviewSchema } from "@/types/schemas/contentReview";
import { lockRevisionSources } from "./contentProjectWrites";
import {
  contentWriteGuard,
  lockContentMembership,
  type ContentMutationReceipt,
  type ContentWriteScope,
  type PreparedReviewRequestWrite,
  type PreparedReviewEventWrite,
} from "./contentRevisionWrites";

function requestGuard(
  scope: ContentWriteScope,
  {
    projectId,
    contentId,
    revisionId,
    headVersion,
    contextVersion,
    checkSetId,
  }: {
    projectId: string;
    contentId: string;
    revisionId: string | SQL;
    headVersion: number;
    contextVersion: number;
    checkSetId: string | SQL;
  },
) {
  return sql`${contentWriteGuard(scope, projectId)} and coalesce((select context_version from content_project_state where project_id = ${projectId}), 0) = ${contextVersion}
    and exists (select 1 from content_items i join content_revisions r on r.project_id = i.project_id and r.content_id = i.id and r.version = i.head_version
      join content_revision_check_heads h on h.revision_id = r.id and h.project_id = r.project_id and h.content_id = r.content_id
      join content_check_sets cs on cs.id = h.check_set_id
      where i.project_id = ${projectId} and i.id = ${contentId} and i.archived_at_ms is null and i.head_version = ${headVersion}
        and r.id = ${revisionId} and r.redacted_at_ms is null and r.context_version = ${contextVersion} and h.check_set_id = ${checkSetId}
        and cs.content_hash = r.content_hash and cs.context_hash = r.context_hash and cs.source_set_hash = r.source_set_hash
        and not exists (select 1 from content_revision_sources rs left join content_sources s on s.project_id = rs.project_id and s.id = rs.source_id
          where rs.revision_id = r.id and (s.id is null or s.extraction_status = 'erased' or (s.kind = 'audit' and not exists (select 1 from content_source_audit_references ar where ar.project_id = s.project_id and ar.source_id = s.id)))))`;
}

async function receipt(
  scope: ContentWriteScope,
  {
    projectId,
    mutationId,
    requestHash,
    kind,
    attemptedId,
  }: {
    projectId: string;
    mutationId: string;
    requestHash: string;
    kind: string;
    attemptedId: string;
  },
): Promise<ContentMutationReceipt> {
  const [row] = await db
    .select()
    .from(contentMutations)
    .where(
      and(
        eq(contentMutations.projectId, projectId),
        eq(contentMutations.mutationId, mutationId),
        contentWriteGuard(scope, projectId),
      ),
    )
    .limit(1);
  if (!row || row.requestHash !== requestHash)
    return { ok: false, code: "conflict" };
  if (row.kind !== kind || row.completed !== 1)
    return { ok: false, code: "conflict" };
  return { ok: true, resultId: row.resultId, replayed: row.id !== attemptedId };
}

async function requestReview(
  scope: ContentWriteScope,
  write: PreparedReviewRequestWrite,
): Promise<ContentMutationReceipt> {
  const { input, requestId, requestHash, createdAtMs } = write;
  const receiptId = crypto.randomUUID();
  const guard = requestGuard(scope, {
    projectId: input.projectId,
    contentId: input.contentId,
    revisionId: input.revisionId,
    headVersion: input.expectedHeadVersion,
    contextVersion: input.expectedContextVersion,
    checkSetId: input.checkSetId,
  });
  const assignee = sql`exists (select 1 from member a where a.organization_id = ${scope.actor.organizationId} and a.user_id = ${input.assigneeUserId})`;
  const admitted = sql`exists (select 1 from content_mutations m where m.id = ${receiptId} and m.project_id = ${input.projectId} and m.completed = 0 and m.request_hash = ${requestHash})`;
  await runBatch((tx) => [
    lockProject(tx, input.projectId, scope.actor.organizationId),
    ...lockContentMembership(tx, scope, input.projectId),
    ...lockRevisionSources(
      tx,
      input.projectId,
      input.revisionId,
      contentWriteGuard(scope, input.projectId),
    ),
    tx
      .update(member)
      .set({ role: sql`${member.role}` })
      .where(
        and(
          eq(member.organizationId, scope.actor.organizationId),
          eq(member.userId, input.assigneeUserId),
          contentWriteGuard(scope, input.projectId),
        ),
      ),
    tx
      .insert(contentMutations)
      .select(
        sql`select ${receiptId}, ${input.projectId}, ${input.mutationId}, ${requestHash}, 'review_request', ${requestId}, 0, ${createdAtMs} where ${guard} and ${assignee}`,
      )
      .onConflictDoNothing(),
    tx
      .insert(contentReviewRequests)
      .select(
        sql`select ${requestId}, ${input.projectId}, ${input.contentId}, ${input.revisionId}, ${input.checkSetId}, ${receiptId}, ${input.assigneeUserId}, ${scope.membershipId === null ? null : scope.actor.userId}, 0, 'pending', ${input.expectedContextVersion}, ${createdAtMs}, i.review_version + 1 from content_items i where i.id = ${input.contentId} and i.project_id = ${input.projectId} and ${guard} and ${assignee} and ${admitted}`,
      ),
    tx
      .update(contentItems)
      .set({ reviewVersion: sql`${contentItems.reviewVersion} + 1` })
      .where(
        and(
          eq(contentItems.projectId, input.projectId),
          eq(contentItems.id, input.contentId),
          guard,
          assignee,
          admitted,
          sql`exists (select 1 from content_review_requests q where q.id = ${requestId} and q.mutation_receipt_id = ${receiptId} and q.sequence = ${contentItems.reviewVersion} + 1)`,
        ),
      ),
    tx
      .update(contentMutations)
      .set({
        completed: sql`case when ${guard} and ${assignee} and exists (select 1 from content_review_requests q join content_items i on i.id = q.content_id and i.project_id = q.project_id where q.id = ${requestId} and q.mutation_receipt_id = ${receiptId} and q.sequence = i.review_version) then 1 else null end`,
      })
      .where(eq(contentMutations.id, receiptId)),
  ]);
  return receipt(scope, {
    projectId: input.projectId,
    mutationId: input.mutationId,
    requestHash,
    kind: "review_request",
    attemptedId: receiptId,
  });
}

function eventGuard(
  scope: ContentWriteScope,
  write: PreparedReviewEventWrite,
  requestVersion: number,
  state: string,
) {
  const { input } = write;
  const decision = "decision" in input ? input.decision : "withdraw";
  const allowed =
    scope.actor.surface === "web" &&
    scope.membershipId !== null &&
    (decision === "cancel" ||
      hasOrgPermission(scope.actor.role, { content: ["review"] }));
  return sql`${allowed ? 1 : 0} = 1 and exists (select 1 from content_review_requests q join content_items i on i.id = q.content_id and i.project_id = q.project_id
    join content_revisions r on r.id = q.revision_id and r.project_id = q.project_id and r.content_id = q.content_id
    join content_check_sets cs on cs.id = q.check_set_id and cs.revision_id = r.id
    where q.id = ${input.requestId} and q.project_id = ${input.projectId} and q.content_id = ${input.contentId} and q.version = ${requestVersion} and q.state = ${state} and q.sequence = i.review_version
      and i.head_version = ${input.expectedHeadVersion} and r.version = i.head_version and q.context_version = ${write.expectedContextVersion}
      and cs.context_hash = ${write.contextHash} and cs.source_set_hash = ${write.sourceSetHash} and cs.check_set_hash = ${write.checkSetHash}
      ${decision === "approve" && "claimAssessments" in input ? sql`and ${input.assessedRemainingText ? 1 : 0} = 1 and (select count(*) from content_claims c where c.revision_id = r.id) = ${input.claimAssessments.length} and not exists (select 1 from content_claims c where c.revision_id = r.id and c.factual = 1 and c.kind in ('product','security','financial','legal') and (not exists (select 1 from content_claim_evidence e where e.claim_id = c.id and e.relation = 'supports') or exists (select 1 from content_claim_evidence e where e.claim_id = c.id and e.relation = 'contradicts')))` : sql``}
      ${decision === "cancel" ? sql`and (q.requested_by_user_id = ${scope.actor.userId} or q.assignee_user_id = ${scope.actor.userId} or ${hasOrgPermission(scope.actor.role, { content: ["review"] }) ? 1 : 0} = 1)` : sql``}
      and ${requestGuard(scope, { projectId: input.projectId, contentId: input.contentId, revisionId: sql`q.revision_id`, headVersion: input.expectedHeadVersion, contextVersion: write.expectedContextVersion, checkSetId: sql`q.check_set_id` })})`;
}

async function writeEvent(
  scope: ContentWriteScope,
  write: PreparedReviewEventWrite,
  withdrawing: boolean,
): Promise<ContentMutationReceipt> {
  const { input } = write;
  if (withdrawing === "decision" in input)
    return { ok: false, code: "conflict" };
  const decision = "decision" in input ? input.decision : "withdraw";
  if (
    "claimAssessments" in input &&
    new Set(input.claimAssessments.map((assessment) => assessment.claimId))
      .size !== input.claimAssessments.length
  )
    return { ok: false, code: "conflict" };
  const nextState =
    decision === "approve"
      ? "approved"
      : decision === "request_changes"
        ? "changes_requested"
        : decision === "reject"
          ? "rejected"
          : decision === "cancel"
            ? "cancelled"
            : "withdrawn";
  const expectedState = withdrawing ? "approved" : "pending";
  const before = eventGuard(
    scope,
    write,
    input.expectedRequestVersion,
    expectedState,
  );
  const after = eventGuard(
    scope,
    write,
    input.expectedRequestVersion + 1,
    nextState,
  );
  const receiptId = crypto.randomUUID();
  const kind = withdrawing ? "review_withdraw" : "review_decision";
  const assessments = "claimAssessments" in input ? input.claimAssessments : [];
  const admitted = sql`exists (select 1 from content_mutations m where m.id = ${receiptId} and m.project_id = ${input.projectId} and m.request_hash = ${write.requestHash} and m.completed = 0)`;
  await runBatch((tx) => [
    lockProject(tx, input.projectId, scope.actor.organizationId),
    ...lockContentMembership(tx, scope, input.projectId),
    ...lockRevisionSources(
      tx,
      input.projectId,
      sql`(select q.revision_id from content_review_requests q where q.id = ${input.requestId} and q.project_id = ${input.projectId})`,
      contentWriteGuard(scope, input.projectId),
    ),
    tx
      .insert(contentMutations)
      .select(
        sql`select ${receiptId}, ${input.projectId}, ${input.mutationId}, ${write.requestHash}, ${kind}, ${write.eventId}, 0, ${write.createdAtMs} where ${before}`,
      )
      .onConflictDoNothing(),
    tx
      .insert(contentReviewEvents)
      .select(
        sql`select ${write.eventId}, q.project_id, q.content_id, q.revision_id, q.id, ${receiptId}, ${scope.actor.userId}, ${scope.membershipId}, ${decision}, ${scope.actor.surface}, ${input.reason}, ${"assessedRemainingText" in input && input.assessedRemainingText ? 1 : 0}, ${write.createdAtMs}, ${input.expectedRequestVersion + 1} from content_review_requests q where q.id = ${input.requestId} and ${before} and ${admitted}`,
      ),
    ...assessments.map((assessment) =>
      tx
        .insert(contentClaimAssessments)
        .select(
          sql`select ${crypto.randomUUID()}, q.project_id, q.content_id, q.revision_id, ${write.eventId}, ${assessment.claimId}, ${assessment.assessment}, ${assessment.reason} from content_review_requests q where q.id = ${input.requestId} and ${before} and ${admitted} and exists (select 1 from content_review_events e where e.id = ${write.eventId} and e.mutation_receipt_id = ${receiptId})`,
        ),
    ),
    tx
      .update(contentReviewRequests)
      .set({ version: input.expectedRequestVersion + 1, state: nextState })
      .where(
        and(
          eq(contentReviewRequests.id, input.requestId),
          before,
          admitted,
          sql`exists (select 1 from content_review_events e where e.id = ${write.eventId} and e.mutation_receipt_id = ${receiptId})`,
        ),
      ),
    tx
      .update(contentMutations)
      .set({
        completed: sql`case when ${after} and exists (select 1 from content_review_events e where e.id = ${write.eventId} and e.mutation_receipt_id = ${receiptId} and e.request_version = ${input.expectedRequestVersion + 1}) and (select count(*) from content_claim_assessments a where a.event_id = ${write.eventId}) = ${assessments.length} then 1 else null end`,
      })
      .where(eq(contentMutations.id, receiptId)),
  ]);
  return receipt(scope, {
    projectId: input.projectId,
    mutationId: input.mutationId,
    requestHash: write.requestHash,
    kind,
    attemptedId: receiptId,
  });
}

async function getReview(
  organizationId: string,
  projectId: string,
  contentId: string,
  requestId?: string,
) {
  const [row] = await db
    .select({ request: contentReviewRequests })
    .from(contentReviewRequests)
    .innerJoin(
      contentItems,
      and(
        eq(contentItems.id, contentReviewRequests.contentId),
        eq(contentItems.projectId, contentReviewRequests.projectId),
      ),
    )
    .innerJoin(projects, eq(projects.id, contentReviewRequests.projectId))
    .where(
      and(
        eq(contentReviewRequests.projectId, projectId),
        eq(contentReviewRequests.contentId, contentId),
        eq(projects.organizationId, organizationId),
        sql`${projects.archivedAt} is null`,
        requestId
          ? eq(contentReviewRequests.id, requestId)
          : eq(contentReviewRequests.sequence, contentItems.reviewVersion),
      ),
    )
    .limit(1);
  if (!row) return null;
  const events = await db
    .select()
    .from(contentReviewEvents)
    .where(
      and(
        eq(contentReviewEvents.requestId, row.request.id),
        sql`exists (select 1 from projects p where p.id = ${projectId} and p.organization_id = ${organizationId} and p.archived_at is null)`,
      ),
    )
    .orderBy(asc(contentReviewEvents.requestVersion));
  const assessments = await db
    .select()
    .from(contentClaimAssessments)
    .where(
      and(
        eq(contentClaimAssessments.contentId, contentId),
        eq(contentClaimAssessments.projectId, projectId),
        sql`${contentClaimAssessments.eventId} in (select e.id from content_review_events e where e.request_id = ${row.request.id})`,
        sql`exists (select 1 from projects p where p.id = ${projectId} and p.organization_id = ${organizationId} and p.archived_at is null)`,
      ),
    )
    .orderBy(asc(contentClaimAssessments.claimId));
  return savedContentReviewSchema.parse({
    id: row.request.id,
    projectId: row.request.projectId,
    contentId: row.request.contentId,
    revisionId: row.request.revisionId,
    checkSetId: row.request.checkSetId,
    assigneeUserId: row.request.assigneeUserId,
    requestedByUserId: row.request.requestedByUserId,
    version: row.request.version,
    sequence: row.request.sequence,
    state: row.request.state,
    contextVersion: row.request.contextVersion,
    createdAtMs: row.request.createdAtMs,
    events: events.map((event) => ({
      id: event.id,
      requestId: event.requestId,
      revisionId: event.revisionId,
      requestVersion: event.requestVersion,
      reviewerUserId: event.reviewerUserId,
      reviewerMembershipId: event.reviewerMembershipId,
      decision: event.decision,
      surface: event.surface,
      reason: event.reason,
      createdAtMs: event.createdAtMs,
      assessedRemainingText: event.assessedRemainingText === 1,
      claimAssessments: assessments
        .filter((a) => a.eventId === event.id)
        .map(({ claimId, assessment, reason }) => ({
          claimId,
          assessment,
          reason,
        })),
    })),
  });
}

async function getReviewForRevision(
  organizationId: string,
  projectId: string,
  contentId: string,
  revisionId: string,
) {
  const [row] = await db
    .select({ id: contentReviewRequests.id })
    .from(contentReviewRequests)
    .innerJoin(projects, eq(projects.id, contentReviewRequests.projectId))
    .where(
      and(
        eq(contentReviewRequests.projectId, projectId),
        eq(contentReviewRequests.contentId, contentId),
        eq(contentReviewRequests.revisionId, revisionId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(desc(contentReviewRequests.sequence))
    .limit(1);
  return row ? getReview(organizationId, projectId, contentId, row.id) : null;
}

export const ContentReviewRepository = {
  requestReview,
  decideReview: (scope: ContentWriteScope, write: PreparedReviewEventWrite) =>
    writeEvent(scope, write, false),
  withdrawApproval: (
    scope: ContentWriteScope,
    write: PreparedReviewEventWrite,
  ) => writeEvent(scope, write, true),
  getReview,
  getReviewForRevision,
} as const;
