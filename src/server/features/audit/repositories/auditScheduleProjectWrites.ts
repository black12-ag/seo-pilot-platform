import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  projects,
  member,
  auditSchedules as schedules,
  auditScheduleAttempts as attempts,
} from "@/db/schema";
import type { runBatch } from "@/db/runBatch";
import type { AuditScheduleScope } from "../services/auditScheduleAccess";

type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];
export function scheduleScope(
  scope: AuditScheduleScope,
  projectId: string,
  manage = false,
): SQL {
  return sql`exists (select 1 from projects p where p.id = ${projectId} and p.organization_id = ${scope.organizationId}
    ${manage ? sql`and p.archived_at is null` : sql``}
    ${scope.requireMembership ? sql`and exists (select 1 from member m where m.organization_id = p.organization_id and m.user_id = ${scope.userId} ${manage ? sql`and (',' || replace(m.role, ' ', '') || ',') like '%,owner,%'` : sql``})` : manage ? sql`and ${scope.role === "owner" ? 1 : 0} = 1` : sql``})`;
}
export function lockScheduleSponsor(
  tx: Tx,
  userId: string | null,
  organizationId: string,
) {
  return tx
    .update(member)
    .set({ role: sql`${member.role}` })
    .where(
      and(
        eq(member.organizationId, organizationId),
        sql`${member.userId} = ${userId}`,
      ),
    );
}
export function currentAttemptAuthority(
  attempt: typeof attempts.$inferSelect,
  running = false,
): SQL {
  return sql`exists (select 1 from projects p where p.id = ${attempt.projectId} and p.organization_id = ${attempt.organizationId}
    and p.archived_at is null and coalesce(p.domain,'') = coalesce(${attempt.domain},'')
    and exists (select 1 from member m where m.organization_id = p.organization_id and m.user_id = ${attempt.sponsorUserId}
      and (',' || replace(m.role,' ','') || ',') like '%,owner,%'))
    ${running ? sql`` : sql`and exists (select 1 from audit_schedules s where s.project_id = ${attempt.projectId} and s.organization_id = ${attempt.organizationId} and s.version = ${attempt.scheduleVersion} and s.state = 'enabled')`}`;
}
/** Lifecycle caller already holds its established project lock. */
export function invalidateAuditSchedule(
  tx: Tx,
  projectId: string,
  organizationId: string,
  input: { reason: string; nowMs: number; condition?: SQL },
) {
  const owns = sql`exists (select 1 from projects p where p.id = ${projectId} and p.organization_id = ${organizationId} and ${input.condition ?? sql`true`})`;
  return [
    tx
      .update(schedules)
      .set({
        version: sql`${schedules.version}+1`,
        state: "paused",
        nextDueAtMs: null,
        blockedReason: input.reason,
        updatedAtMs: input.nowMs,
      })
      .where(
        and(
          eq(schedules.projectId, projectId),
          eq(schedules.organizationId, organizationId),
          owns,
        ),
      ),
    tx
      .update(attempts)
      .set({ executionRevokedAtMs: input.nowMs, reason: input.reason })
      .where(
        and(
          eq(attempts.projectId, projectId),
          eq(attempts.organizationId, organizationId),
          sql`${attempts.launchState} in ('pending','launching','running')`,
          owns,
        ),
      ),
  ];
}
/** Abort the transaction if authority changed after its conditional receipt. */
export function assertScheduleWrite(
  tx: Tx,
  projectId: string,
  receipt: SQL,
  authority: SQL,
) {
  return tx
    .update(projects)
    .set({ name: sql`null` })
    .where(and(eq(projects.id, projectId), receipt, sql`not (${authority})`));
}
