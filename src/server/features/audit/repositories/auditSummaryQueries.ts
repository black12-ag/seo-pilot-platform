import { and, countDistinct, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditIssues, audits, user } from "@/db/schema";

/**
 * Distinct-page counts per issue type for one audit — link-level issues
 * write one row per occurrence, and consumers phrase this as "N pages".
 * Lives beside AuditRepository (same pattern as rank-tracking's
 * snapshotQueries) to keep the main repository under the file-size limit.
 */
export async function getIssueTypePageCountsForAudit(auditId: string) {
  return db
    .select({
      issueType: auditIssues.issueType,
      severity: auditIssues.severity,
      pages: countDistinct(auditIssues.pageUrl),
    })
    .from(auditIssues)
    .where(eq(auditIssues.auditId, auditId))
    .groupBy(auditIssues.issueType, auditIssues.severity);
}

// completedAt is ISO text in both dialects, so string comparison orders it.
export async function getAuditsCompletedSince(since: string) {
  return db
    .select({
      id: audits.id,
      projectId: audits.projectId,
      startUrl: audits.startUrl,
      pagesCrawled: audits.pagesCrawled,
      completedAt: audits.completedAt,
      userId: user.id,
      email: user.email,
    })
    .from(audits)
    .innerJoin(user, eq(user.id, audits.startedByUserId))
    .where(
      and(
        eq(audits.status, "completed"),
        eq(audits.isScheduled, false),
        gte(audits.completedAt, since),
        sql`not exists (select 1 from audit_schedule_attempts a where a.id = ${audits.id})`,
      ),
    );
}

export async function hasCompletedAuditBefore(userId: string, before: string) {
  const rows = await db
    .select({ id: audits.id })
    .from(audits)
    .where(
      and(
        eq(audits.startedByUserId, userId),
        eq(audits.status, "completed"),
        eq(audits.isScheduled, false),
        lt(audits.completedAt, before),
        sql`not exists (select 1 from audit_schedule_attempts a where a.id = ${audits.id})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
