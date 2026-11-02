import { and, count, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import { alias, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import type { drizzle } from "drizzle-orm/postgres-js";
import { GA4_OAUTH_PROVIDER_ID } from "../../src/shared/ga4";
import { GSC_OAUTH_PROVIDER_ID } from "../../src/shared/gsc";
import { LocalScanStatus } from "../../src/shared/local-seo";
import * as schema from "../../src/db/pg/schema";

export type Db = ReturnType<typeof drizzle>;
export type UserRow = { id: string; email: string; name: string };

export async function buildInventory(db: Db, user: UserRow) {
  const allMembers = alias(schema.member, "all_members");
  const organizations = await db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      memberCount: count(allMembers.id),
    })
    .from(schema.member)
    .innerJoin(
      schema.organization,
      eq(schema.organization.id, schema.member.organizationId),
    )
    .innerJoin(
      allMembers,
      eq(allMembers.organizationId, schema.organization.id),
    )
    .where(eq(schema.member.userId, user.id))
    .groupBy(schema.organization.id, schema.organization.name)
    .orderBy(schema.organization.id);
  const shared = organizations.filter(
    (organization) => organization.memberCount !== 1,
  );
  if (shared.length > 0) {
    throw new Error(
      `Refusing to erase shared organization(s): ${shared
        .map(
          (organization) =>
            `${organization.id} (${organization.memberCount} members)`,
        )
        .join(
          ", ",
        )}. Transfer/remove the user and handle shared records explicitly first.`,
    );
  }
  const organizationIds = organizations.map((organization) => organization.id);

  // drizzle's inArray throws on empty arrays, so project-scoped queries are
  // skipped outright when the user has no organizations or projects.
  const projects =
    organizationIds.length === 0
      ? []
      : await db
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(inArray(schema.projects.organizationId, organizationIds))
          .orderBy(schema.projects.id);
  const projectIds = projects.map((row) => row.id);

  const samSessions = await db
    .select({ id: schema.samSessions.id })
    .from(schema.samSessions)
    .where(eq(schema.samSessions.userId, user.id))
    .orderBy(schema.samSessions.id);

  // Scratchpad DOs self-destroy at finalize and via a 7-day alarm, and the
  // audit-progress KV key has a 30-minute TTL, so older audits have no
  // Cloudflare state left to erase. 30 days gives 4x margin over the alarm
  // and keeps the Worker call within KV's per-invocation operation limit.
  // startedAt is a text column of ISO strings, so compare lexicographically.
  const auditCutoff = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const audits =
    projectIds.length === 0
      ? []
      : await db
          .select({ id: schema.audits.id })
          .from(schema.audits)
          .where(
            and(
              inArray(schema.audits.projectId, projectIds),
              or(
                gt(schema.audits.startedAt, auditCutoff),
                eq(schema.audits.status, "running"),
              ),
            ),
          )
          .orderBy(schema.audits.id);

  const r2Rows =
    projectIds.length === 0
      ? []
      : await db
          .selectDistinct({ r2Key: schema.auditLighthouseResults.r2Key })
          .from(schema.auditLighthouseResults)
          .innerJoin(
            schema.audits,
            eq(schema.audits.id, schema.auditLighthouseResults.auditId),
          )
          .where(
            and(
              inArray(schema.audits.projectId, projectIds),
              isNotNull(schema.auditLighthouseResults.r2Key),
            ),
          )
          .orderBy(schema.auditLighthouseResults.r2Key);
  const r2Keys = r2Rows.flatMap((row) => (row.r2Key ? [row.r2Key] : []));

  const googleAccountRows = await db
    .selectDistinct({
      providerId: schema.account.providerId,
      accountId: schema.account.accountId,
    })
    .from(schema.account)
    .where(
      and(
        eq(schema.account.userId, user.id),
        inArray(schema.account.providerId, [
          GSC_OAUTH_PROVIDER_ID,
          GA4_OAUTH_PROVIDER_ID,
        ]),
      ),
    )
    .orderBy(schema.account.providerId, schema.account.accountId);
  // The where clause already restricts providerId to the two Google
  // providers; the predicate narrows the column's string type to match the
  // erasure payload's enum.
  const isGoogleProviderId = (
    value: string,
  ): value is typeof GSC_OAUTH_PROVIDER_ID | typeof GA4_OAUTH_PROVIDER_ID =>
    value === GSC_OAUTH_PROVIDER_ID || value === GA4_OAUTH_PROVIDER_ID;
  const googleAccounts = googleAccountRows.flatMap((row) =>
    isGoogleProviderId(row.providerId)
      ? [{ providerId: row.providerId, accountId: row.accountId }]
      : [],
  );

  const activeAuditWorkflows =
    projectIds.length === 0
      ? []
      : await db
          .select({
            id: sql<string>`coalesce(${schema.audits.workflowInstanceId}, ${schema.audits.id})`,
          })
          .from(schema.audits)
          .where(
            and(
              inArray(schema.audits.projectId, projectIds),
              eq(schema.audits.status, "running"),
            ),
          )
          .orderBy(schema.audits.id);
  const activeRankWorkflows =
    projectIds.length === 0
      ? []
      : await db
          .select({ id: schema.rankCheckRuns.id })
          .from(schema.rankCheckRuns)
          .where(
            and(
              inArray(schema.rankCheckRuns.projectId, projectIds),
              inArray(schema.rankCheckRuns.status, ["pending", "running"]),
            ),
          )
          .orderBy(schema.rankCheckRuns.id);

  const activeAiVisibilityWorkflows =
    projectIds.length === 0
      ? []
      : await db
          .select({ id: schema.aiRuns.id })
          .from(schema.aiRuns)
          .where(
            and(
              inArray(schema.aiRuns.projectId, projectIds),
              inArray(schema.aiRuns.status, ["queued", "running"]),
            ),
          )
          .orderBy(schema.aiRuns.id);

  const activeLocalRankWorkflows =
    projectIds.length === 0
      ? []
      : await db
          .select({ id: schema.localRankChecks.id })
          .from(schema.localRankChecks)
          .where(
            and(
              inArray(schema.localRankChecks.projectId, projectIds),
              inArray(schema.localRankChecks.status, [
                LocalScanStatus.Queued,
                LocalScanStatus.Running,
              ]),
            ),
          )
          .orderBy(schema.localRankChecks.id);
  // Any table with a `project_id`: the counts differ only in which table.
  const projectCount = async (table: PgTable & { projectId: PgColumn }) =>
    projectIds.length === 0
      ? 0
      : db.$count(table, inArray(table.projectId, projectIds));
  const databaseCounts = {
    sessions: await db.$count(
      schema.session,
      eq(schema.session.userId, user.id),
    ),
    accounts: await db.$count(
      schema.account,
      eq(schema.account.userId, user.id),
    ),
    onboarding_answers: await db.$count(
      schema.userOnboardingAnswers,
      eq(schema.userOnboardingAnswers.userId, user.id),
    ),
    projects: projectIds.length,
    saved_keywords: await projectCount(schema.savedKeywords),
    audits: await projectCount(schema.audits),
    rank_snapshots:
      projectIds.length === 0
        ? 0
        : await db
            .select({ value: count() })
            .from(schema.rankSnapshots)
            .innerJoin(
              schema.rankCheckRuns,
              eq(schema.rankCheckRuns.id, schema.rankSnapshots.runId),
            )
            .where(inArray(schema.rankCheckRuns.projectId, projectIds))
            .then((rows) => rows[0]?.value ?? 0),
    sam_sessions: samSessions.length,
    attributed_audits: await db.$count(
      schema.audits,
      eq(schema.audits.startedByUserId, user.id),
    ),
    reports: await projectCount(schema.reports),
    attributed_reports: await db.$count(
      schema.reports,
      eq(schema.reports.createdByUserId, user.id),
    ),
    report_templates: await projectCount(schema.reportTemplates),
    content_items: await projectCount(schema.contentItems),
    content_sources: await projectCount(schema.contentSources),
    attributed_content_sources: await db.$count(
      schema.contentSources,
      eq(schema.contentSources.createdByUserId, user.id),
    ),
    attributed_content_revisions: await db.$count(
      schema.contentRevisions,
      eq(schema.contentRevisions.authorUserId, user.id),
    ),
    affected_content_revisions: await db.$count(
      schema.contentRevisions,
      sql`${schema.contentRevisions.authorUserId} = ${user.id} or exists (select 1 from content_revision_sources rs join content_sources s on s.id = rs.source_id and s.project_id = rs.project_id where rs.revision_id = ${schema.contentRevisions.id} and s.created_by_user_id = ${user.id})`,
    ),
    attributed_content_reviews: await db.$count(
      schema.contentReviewEvents,
      eq(schema.contentReviewEvents.reviewerUserId, user.id),
    ),
    attributed_report_templates: await db.$count(
      schema.reportTemplates,
      eq(schema.reportTemplates.createdByUserId, user.id),
    ),
    shared_reports: await db.$count(
      schema.reports,
      and(
        eq(schema.reports.createdByUserId, user.id),
        isNotNull(schema.reports.shareToken),
      ),
    ),
    gsc_connections: await db.$count(
      schema.gscConnections,
      eq(schema.gscConnections.connectedByUserId, user.id),
    ),
    ga4_connections: await db.$count(
      schema.ga4Connections,
      eq(schema.ga4Connections.connectedByUserId, user.id),
    ),
    api_keys: await db.$count(
      schema.apikey,
      eq(schema.apikey.referenceId, user.id),
    ),
  };

  return {
    organizations,
    aiVisibilityProjectIds: projectIds,
    activeAiVisibilityWorkflowIds: activeAiVisibilityWorkflows.map(
      (row) => row.id,
    ),
    samSessionIds: samSessions.map((row) => row.id),
    auditIds: audits.map((row) => row.id),
    r2Keys,
    googleAccounts,
    activeAuditWorkflowIds: activeAuditWorkflows.map((row) => row.id),
    activeRankWorkflowIds: activeRankWorkflows.map((row) => row.id),
    activeLocalRankWorkflowIds: activeLocalRankWorkflows.map((row) => row.id),
    databaseCounts,
  };
}
