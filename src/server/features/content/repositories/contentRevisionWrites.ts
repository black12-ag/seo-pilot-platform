import { and, eq, inArray, sql } from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  contentItems,
  contentMutations,
  contentRevisions,
  contentRevisionParents,
  contentRevisionSources,
  contentClaims,
  contentClaimEvidence,
  contentCheckSets,
  contentChecks,
  contentRevisionCheckHeads,
  member,
  contentSources,
  audits,
  auditPages,
  auditIssues,
} from "@/db/schema";
import { lockProject } from "@/server/features/site-authority/repositories/siteAuthorityProjectWrites";
import type {
  ContentMutationReceipt,
  ContentWriteScope,
  PreparedRevisionWrite,
  PreparedArchiveWrite,
} from "@/types/schemas/content";
export {
  preparedRevisionWriteSchema,
  preparedSourceWriteSchema,
} from "@/types/schemas/content";
export type {
  ContentMutationReceipt,
  ContentWriteScope,
  PreparedRevisionWrite,
  PreparedSourceWrite,
  PreparedReviewRequestWrite,
  PreparedReviewEventWrite,
} from "@/types/schemas/content";

export function contentWriteGuard(scope: ContentWriteScope, projectId: string) {
  const { actor, membershipId } = scope;
  return sql`exists (select 1 from projects p where p.id = ${projectId}
    and p.organization_id = ${actor.organizationId} and p.archived_at is null
    ${membershipId === null ? sql`` : sql`and exists (select 1 from member m where m.id = ${membershipId} and m.organization_id = p.organization_id and m.user_id = ${actor.userId} and m.role = ${actor.role})`})`;
}

export function lockContentMembership(
  tx: Parameters<Parameters<typeof runBatch>[0]>[0],
  scope: ContentWriteScope,
  projectId: string,
) {
  return scope.membershipId === null
    ? []
    : [
        tx
          .update(member)
          .set({ role: sql`${member.role}` })
          .where(
            and(
              eq(member.id, scope.membershipId),
              eq(member.organizationId, scope.actor.organizationId),
              eq(member.userId, scope.actor.userId),
              eq(member.role, scope.actor.role),
              contentWriteGuard(scope, projectId),
            ),
          ),
      ];
}

async function writeRevision(
  scope: ContentWriteScope,
  input: PreparedRevisionWrite,
  creating: boolean,
): Promise<ContentMutationReceipt> {
  const r = input.revision;
  const ids = sort(r.sourceIds, (a, b) => a.localeCompare(b));
  const pinnedIds = sort(
    input.sourceHashes.map((source) => source.sourceId),
    (a, b) => a.localeCompare(b),
  );
  if (
    new Set(ids).size !== ids.length ||
    JSON.stringify(ids) !== JSON.stringify(pinnedIds)
  )
    return { ok: false, code: "conflict" };
  if (
    r.version !== input.expectedHeadVersion + 1 ||
    r.contextVersion !== input.expectedContextVersion ||
    (creating
      ? input.expectedHeadVersion !== 0 || r.parentRevisionId !== null
      : r.parentRevisionId === null)
  )
    return { ok: false, code: "revision_conflict" };
  const receiptId = crypto.randomUUID();
  const kind = creating ? "create" : "save";
  const guard = contentWriteGuard(scope, r.projectId);
  const context = sql`coalesce((select context_version from content_project_state where project_id = ${r.projectId}), 0) = ${input.expectedContextVersion}`;
  const sources =
    input.sourceHashes.length === 0
      ? sql`true`
      : sql.join(
          input.sourceHashes.map(
            (source) =>
              sql`exists (select 1 from content_sources s where s.id = ${source.sourceId} and s.project_id = ${r.projectId} and s.text_hash = ${source.textHash} and s.extraction_status <> 'erased' and (s.kind <> 'web' or (s.extraction_status in ('usable', 'partial') and exists (select 1 from content_source_url_captures u where u.source_id = s.id and u.project_id = s.project_id))) and (s.kind <> 'audit' or exists (select 1 from content_source_audit_references ar where ar.source_id = s.id and ar.project_id = s.project_id)))`,
          ),
          sql` and `,
        );
  const head = sql`exists (select 1 from content_items i where i.id = ${r.contentId} and i.project_id = ${r.projectId} and i.archived_at_ms is null and i.head_version = ${input.expectedHeadVersion})`;
  const parent = creating
    ? sql`not exists (select 1 from content_items i where i.id = ${r.contentId})`
    : sql`${head} and exists (select 1 from content_revisions old where old.id = ${r.parentRevisionId} and old.project_id = ${r.projectId} and old.content_id = ${r.contentId} and old.version = ${input.expectedHeadVersion} and old.redacted_at_ms is null)`;
  const admitted = sql`exists (select 1 from content_mutations m where m.id = ${receiptId} and m.project_id = ${r.projectId} and m.request_hash = ${input.requestHash} and m.completed = 0)`;
  const current = sql`${guard} and ${context} and ${sources} and ${admitted} and ${head}`;
  const author = scope.membershipId === null ? null : scope.actor.userId;
  const evidenceCount = r.claims.reduce(
    (n, claim) => n + claim.evidence.length,
    0,
  );
  await runBatch((tx) => [
    lockProject(tx, r.projectId, scope.actor.organizationId),
    ...lockContentMembership(tx, scope, r.projectId),
    ...(ids.length === 0
      ? []
      : [
          tx
            .update(contentSources)
            .set({ title: sql`${contentSources.title}` })
            .where(
              and(
                eq(contentSources.projectId, r.projectId),
                inArray(contentSources.id, ids),
                guard,
              ),
            ),
          tx
            .update(audits)
            .set({ startUrl: sql`${audits.startUrl}` })
            .where(
              sql`${audits.id} in (select ar.audit_id from content_source_audit_references ar where ar.project_id = ${r.projectId} and ar.source_id in (${sql.join(
                ids.map((sourceId) => sql`${sourceId}`),
                sql`, `,
              )})) and ${guard}`,
            ),
          tx
            .update(auditPages)
            .set({ url: sql`${auditPages.url}` })
            .where(
              sql`${auditPages.id} in (select ar.page_id from content_source_audit_references ar where ar.project_id = ${r.projectId} and ar.source_id in (${sql.join(
                ids.map((sourceId) => sql`${sourceId}`),
                sql`, `,
              )})) and ${guard}`,
            ),
          tx
            .update(auditIssues)
            .set({ pageUrl: sql`${auditIssues.pageUrl}` })
            .where(
              sql`${auditIssues.id} in (select ar.issue_id from content_source_audit_references ar where ar.project_id = ${r.projectId} and ar.source_id in (${sql.join(
                ids.map((sourceId) => sql`${sourceId}`),
                sql`, `,
              )})) and ${guard}`,
            ),
        ]),
    tx
      .insert(contentMutations)
      .select(
        sql`select ${receiptId}, ${r.projectId}, ${input.mutationId}, ${input.requestHash}, ${kind}, ${r.id}, 0, ${r.createdAtMs} where ${guard} and ${context} and ${sources} and ${parent}`,
      )
      .onConflictDoNothing(),
    ...(creating
      ? [
          tx
            .insert(contentItems)
            .select(
              sql`select ${r.contentId}, ${r.projectId}, 0, null, ${author}, ${r.createdAtMs}, ${r.createdAtMs}, 0 where ${guard} and ${context} and ${sources} and ${admitted}`,
            ),
        ]
      : []),
    tx
      .insert(contentRevisions)
      .select(
        sql`select ${r.id}, ${r.projectId}, ${r.contentId}, ${r.version}, ${receiptId}, ${JSON.stringify(r.brief)}, ${r.markdown}, ${JSON.stringify(r.metadata)}, ${r.contextJson}, ${r.contextVersion}, ${r.contextHash}, ${r.sourceSetHash}, ${r.contentHash}, ${JSON.stringify(r.openQuestions)}, ${JSON.stringify(r.omissions)}, ${author}, ${scope.actor.surface}, ${r.createdAtMs}, null where ${current}`,
      ),
    ...(r.parentRevisionId
      ? [
          tx
            .insert(contentRevisionParents)
            .select(
              sql`select ${r.projectId}, ${r.contentId}, ${r.id}, ${r.parentRevisionId} where ${current} and exists (select 1 from content_revisions v where v.id = ${r.id} and v.mutation_receipt_id = ${receiptId})`,
            ),
        ]
      : []),
    ...r.sourceIds.map((sourceId) =>
      tx
        .insert(contentRevisionSources)
        .select(
          sql`select ${crypto.randomUUID()}, ${r.projectId}, ${r.contentId}, ${r.id}, ${sourceId}, 'reference' where ${current} and exists (select 1 from content_sources s where s.id = ${sourceId} and s.project_id = ${r.projectId}) and exists (select 1 from content_revisions v where v.id = ${r.id} and v.mutation_receipt_id = ${receiptId})`,
        ),
    ),
    ...r.claims.map((claim) =>
      tx
        .insert(contentClaims)
        .select(
          sql`select ${claim.id}, ${r.projectId}, ${r.contentId}, ${r.id}, ${claim.target.kind}, ${claim.target.kind === "metadata" ? claim.target.field : null}, ${claim.target.kind === "markdown" ? claim.target.start : null}, ${claim.target.kind === "markdown" ? claim.target.end : null}, ${claim.text}, ${claim.textHash}, ${claim.kind}, ${claim.factual ? 1 : 0} where ${current} and exists (select 1 from content_revisions v where v.id = ${r.id} and v.mutation_receipt_id = ${receiptId})`,
        ),
    ),
    ...r.claims.flatMap((claim) =>
      claim.evidence.map((e) =>
        tx
          .insert(contentClaimEvidence)
          .select(
            sql`select ${e.id}, ${r.projectId}, ${r.contentId}, ${r.id}, ${claim.id}, ${e.sourceId}, ${e.start}, ${e.end}, ${e.excerpt}, ${e.excerptHash}, ${e.passageId}, ${e.relation} where ${current} and exists (select 1 from content_claims c where c.id = ${claim.id} and c.revision_id = ${r.id}) and exists (select 1 from content_revision_sources s where s.project_id = ${r.projectId} and s.content_id = ${r.contentId} and s.revision_id = ${r.id} and s.source_id = ${e.sourceId})`,
          ),
      ),
    ),
    tx
      .insert(contentCheckSets)
      .select(
        sql`select ${input.checkSet.id}, ${r.projectId}, ${r.contentId}, ${r.id}, ${input.checkSet.hash}, ${r.contentHash}, ${r.contextHash}, ${r.sourceSetHash}, ${input.checkSet.ruleVersion}, ${input.checkSet.createdAtMs} where ${current} and exists (select 1 from content_revisions v where v.id = ${r.id} and v.mutation_receipt_id = ${receiptId})`,
      ),
    tx
      .insert(contentRevisionCheckHeads)
      .select(
        sql`select ${r.id}, ${r.projectId}, ${r.contentId}, ${input.checkSet.id} where ${current} and exists (select 1 from content_check_sets s where s.id = ${input.checkSet.id} and s.revision_id = ${r.id})`,
      ),
    ...input.checkSet.checks.map((c) =>
      tx
        .insert(contentChecks)
        .select(
          sql`select ${c.id}, ${r.projectId}, ${r.contentId}, ${r.id}, ${input.checkSet.id}, ${c.claimId}, ${c.field}, ${c.rule}, ${c.status}, ${c.severity}, ${c.explanation} where ${current} and exists (select 1 from content_check_sets s where s.id = ${input.checkSet.id} and s.revision_id = ${r.id})`,
        ),
    ),
    tx
      .update(contentItems)
      .set({ headVersion: r.version, updatedAtMs: r.createdAtMs })
      .where(
        and(
          eq(contentItems.id, r.contentId),
          eq(contentItems.projectId, r.projectId),
          eq(contentItems.headVersion, input.expectedHeadVersion),
          guard,
          context,
          sources,
          admitted,
        ),
      ),
    tx
      .update(contentMutations)
      .set({
        completed: sql`case when ${guard} and ${context} and ${sources} and exists (select 1 from content_items i join content_revisions v on v.content_id = i.id and v.project_id = i.project_id where i.id = ${r.contentId} and i.project_id = ${r.projectId} and i.head_version = ${r.version} and v.id = ${r.id} and v.mutation_receipt_id = ${receiptId}) and (select count(*) from content_revision_sources s where s.revision_id = ${r.id}) = ${r.sourceIds.length} and (select count(*) from content_claims c where c.revision_id = ${r.id}) = ${r.claims.length} and (select count(*) from content_claim_evidence e where e.revision_id = ${r.id}) = ${evidenceCount} and exists (select 1 from content_revision_check_heads h where h.revision_id = ${r.id} and h.check_set_id = ${input.checkSet.id}) and (select count(*) from content_checks c where c.check_set_id = ${input.checkSet.id}) = ${input.checkSet.checks.length} ${r.parentRevisionId ? sql`and exists (select 1 from content_revision_parents p where p.revision_id = ${r.id} and p.parent_revision_id = ${r.parentRevisionId})` : sql``} then 1 else null end`,
      })
      .where(eq(contentMutations.id, receiptId)),
  ]);
  const [receipt] = await db
    .select()
    .from(contentMutations)
    .where(
      and(
        eq(contentMutations.projectId, r.projectId),
        eq(contentMutations.mutationId, input.mutationId),
        guard,
      ),
    )
    .limit(1);
  if (
    !receipt ||
    receipt.requestHash !== input.requestHash ||
    receipt.kind !== kind ||
    receipt.completed !== 1
  )
    return { ok: false, code: receipt ? "conflict" : "revision_conflict" };
  return {
    ok: true,
    resultId: receipt.resultId,
    replayed: receipt.id !== receiptId,
  };
}

export const createRevision = (
  scope: ContentWriteScope,
  input: PreparedRevisionWrite,
) => writeRevision(scope, input, true);
export const saveRevision = (
  scope: ContentWriteScope,
  input: PreparedRevisionWrite,
) => writeRevision(scope, input, false);

export async function archive(
  scope: ContentWriteScope,
  write: PreparedArchiveWrite,
): Promise<ContentMutationReceipt> {
  const { input, requestHash } = write;
  const receiptId = crypto.randomUUID();
  const now = Date.now();
  const guard = contentWriteGuard(scope, input.projectId);
  const head = sql`exists (select 1 from content_items i where i.project_id = ${input.projectId} and i.id = ${input.contentId} and i.archived_at_ms is null and i.head_version = ${input.expectedHeadVersion})`;
  const admitted = sql`exists (select 1 from content_mutations m where m.id = ${receiptId} and m.project_id = ${input.projectId} and m.request_hash = ${requestHash} and m.completed = 0)`;
  await runBatch((tx) => [
    lockProject(tx, input.projectId, scope.actor.organizationId),
    ...lockContentMembership(tx, scope, input.projectId),
    tx
      .insert(contentMutations)
      .select(
        sql`select ${receiptId}, ${input.projectId}, ${input.mutationId}, ${requestHash}, 'archive', ${input.contentId}, 0, ${now} where ${guard} and ${head}`,
      )
      .onConflictDoNothing(),
    tx
      .update(contentItems)
      .set({ archivedAtMs: now, updatedAtMs: now })
      .where(
        and(
          eq(contentItems.id, input.contentId),
          eq(contentItems.projectId, input.projectId),
          eq(contentItems.headVersion, input.expectedHeadVersion),
          guard,
          admitted,
          head,
        ),
      ),
    tx
      .update(contentMutations)
      .set({
        completed: sql`case when ${guard} and exists (select 1 from content_items i where i.id = ${input.contentId} and i.project_id = ${input.projectId} and i.head_version = ${input.expectedHeadVersion} and i.archived_at_ms = ${now}) then 1 else null end`,
      })
      .where(eq(contentMutations.id, receiptId)),
  ]);
  const [receipt] = await db
    .select()
    .from(contentMutations)
    .where(
      and(
        eq(contentMutations.projectId, input.projectId),
        eq(contentMutations.mutationId, input.mutationId),
        guard,
      ),
    )
    .limit(1);
  if (
    !receipt ||
    receipt.requestHash !== requestHash ||
    receipt.kind !== "archive" ||
    receipt.completed !== 1
  )
    return { ok: false, code: receipt ? "conflict" : "revision_conflict" };
  return {
    ok: true,
    resultId: receipt.resultId,
    replayed: receipt.id !== receiptId,
  };
}
