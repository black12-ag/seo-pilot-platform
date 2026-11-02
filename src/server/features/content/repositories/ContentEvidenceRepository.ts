import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  audits,
  auditPages,
  auditIssues,
  contentCheckSets,
  contentChecks,
  contentRevisionCheckHeads,
  contentMutations,
  contentSourceAuditReferences,
  contentSources,
  projects,
} from "@/db/schema";
import { lockProject } from "@/server/features/site-authority/repositories/siteAuthorityProjectWrites";
import {
  contentWriteGuard,
  lockContentMembership,
  type ContentMutationReceipt,
  type ContentWriteScope,
  type PreparedSourceWrite,
} from "./contentRevisionWrites";
import {
  contentSourcePageSchema,
  savedContentCheckSetSchema,
  type ContentSourceInput,
} from "@/types/schemas/contentEvidence";

async function getSource(
  organizationId: string,
  projectId: string,
  sourceId: string,
) {
  const [row] = await db
    .select({
      source: contentSources,
      auditReference: contentSourceAuditReferences,
    })
    .from(contentSources)
    .innerJoin(projects, eq(projects.id, contentSources.projectId))
    .leftJoin(
      contentSourceAuditReferences,
      eq(contentSourceAuditReferences.sourceId, contentSources.id),
    )
    .where(
      and(
        eq(contentSources.id, sourceId),
        eq(contentSources.projectId, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function captureSource(
  scope: ContentWriteScope,
  input: PreparedSourceWrite,
): Promise<ContentMutationReceipt> {
  const { source, mutationId, requestHash } = input;
  const receiptId = crypto.randomUUID();
  const guard = contentWriteGuard(scope, source.projectId);
  const ref = source.auditReference;
  const validRef =
    source.kind === "audit" && ref !== null
      ? sql`exists (select 1 from audits a where a.id = ${ref.auditId} and a.project_id = ${source.projectId})
      ${ref.pageId === null ? sql`` : sql`and exists (select 1 from audit_pages ap where ap.id = ${ref.pageId} and ap.audit_id = ${ref.auditId})`}
      ${ref.issueId === null ? sql`` : sql`and exists (select 1 from audit_issues ai where ai.id = ${ref.issueId} and ai.audit_id = ${ref.auditId} and ${ref.pageId === null ? sql`ai.page_id is null` : sql`ai.page_id = ${ref.pageId}`})`}`
      : sql`${source.kind === "pasted" && ref === null ? 1 : 0} = 1`;
  const admitted = sql`exists (select 1 from content_mutations r where r.id = ${receiptId} and r.project_id = ${source.projectId} and r.request_hash = ${requestHash} and r.completed = 0)`;
  await runBatch((tx) => [
    lockProject(tx, source.projectId, scope.actor.organizationId),
    ...lockContentMembership(tx, scope, source.projectId),
    tx
      .insert(contentMutations)
      .select(
        sql`select ${receiptId}, ${source.projectId}, ${mutationId}, ${requestHash}, 'capture', ${source.id}, 0, ${source.capturedAtMs} where ${guard} and ${validRef}`,
      )
      .onConflictDoNothing(),
    tx
      .insert(contentSources)
      .select(
        sql`select ${source.id}, ${source.projectId}, ${receiptId}, ${source.kind}, ${source.title}, ${source.attribution}, ${source.sourceText}, ${source.textHash}, ${source.capturedAtMs}, ${source.publisherDate}, ${source.language}, ${source.market}, ${source.extractionMethod}, ${source.extractionVersion}, ${source.extractionStatus}, ${source.extractionReason}, ${scope.membershipId === null ? null : scope.actor.userId} where ${guard} and ${admitted} and ${validRef}`,
      ),
    ...(ref
      ? [
          tx
            .insert(contentSourceAuditReferences)
            .select(
              sql`select ${source.id}, ${source.projectId}, ${ref.auditId}, ${ref.pageId}, ${ref.issueId} where ${guard} and ${admitted} and ${validRef} and exists (select 1 from content_sources s where s.id = ${source.id} and s.mutation_receipt_id = ${receiptId})`,
            ),
        ]
      : []),
    tx
      .update(contentMutations)
      .set({
        completed: sql`case when ${guard} and exists (select 1 from content_sources s where s.id = ${source.id} and s.project_id = ${source.projectId} and s.mutation_receipt_id = ${receiptId}) ${ref ? sql`and exists (select 1 from content_source_audit_references a where a.source_id = ${source.id} and a.audit_id = ${ref.auditId})` : sql``} then 1 else null end`,
      })
      .where(eq(contentMutations.id, receiptId)),
  ]);
  const [receipt] = await db
    .select()
    .from(contentMutations)
    .where(
      and(
        eq(contentMutations.projectId, source.projectId),
        eq(contentMutations.mutationId, mutationId),
        guard,
      ),
    )
    .limit(1);
  if (
    !receipt ||
    receipt.requestHash !== requestHash ||
    receipt.kind !== "capture" ||
    receipt.completed !== 1
  )
    return { ok: false, code: "conflict" };
  return {
    ok: true,
    resultId: receipt.resultId,
    replayed: receipt.id !== receiptId,
  };
}

async function getAuditObservation(
  organizationId: string,
  projectId: string,
  input: Extract<ContentSourceInput, { kind: "audit" }>,
) {
  const [audit] = await db
    .select({
      id: audits.id,
      startUrl: audits.startUrl,
      status: audits.status,
      startedAt: audits.startedAt,
      completedAt: audits.completedAt,
    })
    .from(audits)
    .innerJoin(projects, eq(projects.id, audits.projectId))
    .where(
      and(
        eq(audits.id, input.auditId),
        eq(audits.projectId, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  if (!audit) return null;
  const issue =
    input.issueId === null
      ? null
      : ((
          await db
            .select({
              id: auditIssues.id,
              pageId: auditIssues.pageId,
              pageUrl: auditIssues.pageUrl,
              issueType: auditIssues.issueType,
              severity: auditIssues.severity,
            })
            .from(auditIssues)
            .where(
              and(
                eq(auditIssues.id, input.issueId),
                eq(auditIssues.auditId, audit.id),
              ),
            )
            .limit(1)
        )[0] ?? null);
  if (input.issueId !== null && !issue) return null;
  if (input.pageId !== null && issue && issue.pageId !== input.pageId)
    return null;
  const pageId = input.pageId ?? issue?.pageId ?? null;
  const page =
    pageId === null
      ? null
      : ((
          await db
            .select({
              id: auditPages.id,
              url: auditPages.url,
              statusCode: auditPages.statusCode,
              title: auditPages.title,
            })
            .from(auditPages)
            .where(
              and(eq(auditPages.id, pageId), eq(auditPages.auditId, audit.id)),
            )
            .limit(1)
        )[0] ?? null);
  if (pageId !== null && !page) return null;
  return { audit, page, issue };
}

async function listSources(
  organizationId: string,
  projectId: string,
  options: { cursor?: string; limit?: number },
) {
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  const rows = await db
    .select({
      id: contentSources.id,
      title: contentSources.title,
      kind: contentSources.kind,
      capturedAtMs: contentSources.capturedAtMs,
      extractionStatus: contentSources.extractionStatus,
      auditSourceId: contentSourceAuditReferences.sourceId,
    })
    .from(contentSources)
    .innerJoin(projects, eq(projects.id, contentSources.projectId))
    .leftJoin(
      contentSourceAuditReferences,
      eq(contentSourceAuditReferences.sourceId, contentSources.id),
    )
    .where(
      and(
        eq(contentSources.projectId, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
        options.cursor ? gt(contentSources.id, options.cursor) : undefined,
      ),
    )
    .orderBy(asc(contentSources.id))
    .limit(limit + 1);
  return contentSourcePageSchema.parse({
    items: rows.slice(0, limit).map(({ auditSourceId, ...row }) => ({
      ...row,
      available:
        row.extractionStatus !== "erased" &&
        (row.kind !== "audit" || auditSourceId !== null),
    })),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  });
}

async function getCheckSet(
  organizationId: string,
  projectId: string,
  contentId: string,
  revisionId: string,
  checkSetId: string,
) {
  const authorized = sql`exists (select 1 from projects p where p.id = ${projectId} and p.organization_id = ${organizationId} and p.archived_at is null) and exists (select 1 from content_revisions r where r.id = ${revisionId} and r.project_id = ${projectId} and r.content_id = ${contentId} and r.redacted_at_ms is null)`;
  const [set] = await db
    .select()
    .from(contentCheckSets)
    .where(
      and(
        eq(contentCheckSets.id, checkSetId),
        eq(contentCheckSets.projectId, projectId),
        eq(contentCheckSets.contentId, contentId),
        eq(contentCheckSets.revisionId, revisionId),
        authorized,
      ),
    )
    .limit(1);
  if (!set) return null;
  const checks = await db
    .select({
      id: contentChecks.id,
      claimId: contentChecks.claimId,
      field: contentChecks.field,
      rule: contentChecks.rule,
      status: contentChecks.status,
      severity: contentChecks.severity,
      explanation: contentChecks.explanation,
    })
    .from(contentChecks)
    .where(and(eq(contentChecks.checkSetId, checkSetId), authorized))
    .orderBy(asc(contentChecks.id));
  return savedContentCheckSetSchema.parse({ ...set, checks });
}

async function getCurrentCheckSet(
  organizationId: string,
  projectId: string,
  contentId: string,
  revisionId: string,
) {
  const [head] = await db
    .select({ id: contentRevisionCheckHeads.checkSetId })
    .from(contentRevisionCheckHeads)
    .innerJoin(projects, eq(projects.id, contentRevisionCheckHeads.projectId))
    .where(
      and(
        eq(contentRevisionCheckHeads.projectId, projectId),
        eq(contentRevisionCheckHeads.contentId, contentId),
        eq(contentRevisionCheckHeads.revisionId, revisionId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return head
    ? getCheckSet(organizationId, projectId, contentId, revisionId, head.id)
    : null;
}

export const ContentEvidenceRepository = {
  getSource,
  captureSource,
  getAuditObservation,
  listSources,
  getCheckSet,
  getCurrentCheckSet,
} as const;
