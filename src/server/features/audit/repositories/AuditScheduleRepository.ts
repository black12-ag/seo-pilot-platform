import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  billingCustomerStatus,
  auditSchedules as schedules,
  auditScheduleAttempts as attempts,
} from "@/db/schema";
import {
  lockProject,
  lockAuthorityOrganization,
} from "@/server/features/site-authority/repositories/siteAuthorityProjectWrites";
import { deterministicAuditRowId, sha256Hex } from "@/server/lib/audit/ids";
import {
  auditScheduleEstimateInputSchema,
  type AuditScheduleInput,
} from "@/types/schemas/audit-schedule";
import type { AuditScheduleScope } from "../services/auditScheduleAccess";
import {
  scheduleScope,
  lockScheduleSponsor,
  assertScheduleWrite,
} from "./auditScheduleProjectWrites";

import {
  getAttempt,
  claimAttempt,
  renewLease,
  attachAudit,
  markRunning,
  deferAttempt,
  executionAllowed,
  revoke,
  markWorkflowObserved,
} from "./auditScheduleAttemptWrites";

type Schedule = typeof schedules.$inferSelect;
export function scheduleSettings(row: Schedule) {
  return auditScheduleEstimateInputSchema.parse({
    projectId: row.projectId,
    state: row.state,
    startUrl: row.startUrl,
    cadence: row.cadence,
    timeZone: row.timeZone,
    hour: row.hour,
    minute: row.minute,
    ...(row.weekday === null ? {} : { weekday: row.weekday }),
    maxPages: row.maxPages,
    renderJavaScript: row.renderJavaScript,
    lighthouseStrategy: row.lighthouseStrategy,
    maxCostMicrosPerRun: row.maxCostMicrosPerRun,
    maxCostMicrosPerUtcDay: row.maxCostMicrosPerUtcDay,
    maxPagesPerUtcDay: row.maxPagesPerUtcDay,
    maxRunsPerUtcDay: row.maxRunsPerUtcDay,
  });
}
async function get(scope: AuditScheduleScope, projectId: string) {
  const [row] = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.projectId, projectId),
        eq(schedules.organizationId, scope.organizationId),
        scheduleScope(scope, projectId),
      ),
    )
    .limit(1);
  return row ?? null;
}
async function save(
  scope: AuditScheduleScope,
  input: AuditScheduleInput,
  approved: {
    fingerprint: string;
    policyFingerprint: string;
    nextDueAtMs: number | null;
    nowMs: number;
    domain: string | null;
  },
) {
  const mutationToken = crypto.randomUUID();
  const {
    expectedVersion,
    estimateFingerprint: _fingerprint,
    ...settings
  } = input;
  const authority = sql`${scheduleScope(scope, input.projectId, true)} and exists (select 1 from projects p where p.id = ${input.projectId} and coalesce(p.domain,'') = coalesce(${approved.domain},''))`;
  const values = {
    ...settings,
    weekday: input.weekday ?? null,
    organizationId: scope.organizationId,
    sponsorUserId: scope.requireMembership ? scope.userId : null,
    domain: approved.domain,
    version: expectedVersion + 1,
    estimateFingerprint: approved.fingerprint,
    policyFingerprint: approved.policyFingerprint,
    nextDueAtMs: approved.nextDueAtMs,
    blockedReason: null,
    updatedAtMs: approved.nowMs,
    mutationToken,
  };
  const receipt = sql`exists (select 1 from audit_schedules s where s.project_id = ${input.projectId} and s.mutation_token = ${mutationToken})`;
  await runBatch((tx) => [
    lockAuthorityOrganization(tx, scope.organizationId),
    lockProject(tx, input.projectId, scope.organizationId),
    lockScheduleSponsor(tx, scope.userId, scope.organizationId),
    ...(expectedVersion === 0
      ? [
          tx
            .insert(schedules)
            .select(
              sql`select
      ${input.projectId}, ${scope.organizationId}, ${values.sponsorUserId}, ${approved.domain}, ${values.version}, ${input.state},
      ${input.startUrl}, ${input.cadence}, ${input.timeZone}, ${input.hour}, ${input.minute}, ${values.weekday},
      ${input.maxPages}, ${input.renderJavaScript}, ${input.lighthouseStrategy}, ${input.maxCostMicrosPerRun}, ${input.maxCostMicrosPerUtcDay},
      ${input.maxPagesPerUtcDay}, ${input.maxRunsPerUtcDay}, ${approved.fingerprint}, ${approved.policyFingerprint}, ${approved.nextDueAtMs},
      null, ${approved.nowMs}, ${mutationToken} where ${authority}`,
            )
            .onConflictDoNothing(),
        ]
      : [
          tx
            .update(schedules)
            .set(values)
            .where(
              and(
                eq(schedules.projectId, input.projectId),
                eq(schedules.organizationId, scope.organizationId),
                eq(schedules.version, expectedVersion),
                authority,
              ),
            ),
        ]),
    // Ordinary edits fence unstarted old intent; running work retains its frozen inputs.
    tx
      .update(attempts)
      .set({ executionRevokedAtMs: approved.nowMs, reason: "schedule_changed" })
      .where(
        and(
          eq(attempts.projectId, input.projectId),
          eq(attempts.organizationId, scope.organizationId),
          sql`${attempts.launchState} in ('pending','launching')`,
          receipt,
          authority,
        ),
      ),
    assertScheduleWrite(tx, input.projectId, receipt, authority),
  ]);
  const row = await get(scope, input.projectId);
  return row?.mutationToken === mutationToken ? row : null;
}
async function listDue(nowMs: number, limit = 50) {
  return db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.state, "enabled"),
        isNotNull(schedules.nextDueAtMs),
        lte(schedules.nextDueAtMs, nowMs),
        sql`exists (select 1 from projects p join member m on m.organization_id = p.organization_id
          where p.id = ${schedules.projectId} and p.organization_id = ${schedules.organizationId} and p.archived_at is null
          and coalesce(p.domain,'') = coalesce(${schedules.domain},'') and m.user_id = ${schedules.sponsorUserId}
          and (',' || replace(m.role,' ','') || ',') like '%,owner,%')`,
        sql`not exists (select 1 from audit_schedule_attempts a where a.project_id = ${schedules.projectId} and a.launch_state in ('pending','launching','running'))`,
      ),
    )
    .orderBy(asc(schedules.nextDueAtMs), asc(schedules.projectId))
    .limit(Math.min(50, limit));
}
async function admitSlot(
  schedule: Schedule,
  slot: {
    dueAtMs: number;
    nextDueAtMs: number;
    firstMissedAtMs: number;
    lastMissedAtMs: number;
    missedCount: number | null;
  },
  nowMs: number,
) {
  const id = await deterministicAuditRowId(
    "scheduled-audit",
    schedule.projectId,
    String(schedule.version),
    String(slot.dueAtMs),
  );
  const requestJson = JSON.stringify(scheduleSettings(schedule));
  const requestHash = await sha256Hex(requestJson);
  const authority = sql`exists (select 1 from projects p join member m on m.organization_id = p.organization_id
    where p.id = ${schedule.projectId} and p.organization_id = ${schedule.organizationId} and p.archived_at is null
    and coalesce(p.domain,'') = coalesce(${schedule.domain},'') and m.user_id = ${schedule.sponsorUserId}
    and (',' || replace(m.role,' ','') || ',') like '%,owner,%')`;
  const intent = sql`exists (select 1 from audit_schedules s where s.project_id = ${schedule.projectId} and s.organization_id = ${schedule.organizationId}
    and s.version = ${schedule.version} and s.state = 'enabled' and s.next_due_at_ms = ${schedule.nextDueAtMs})`;
  const receipt = sql`exists (select 1 from audit_schedule_attempts a where a.id = ${id} and a.project_id = ${schedule.projectId} and a.schedule_version = ${schedule.version})`;
  await runBatch((tx) => [
    lockAuthorityOrganization(tx, schedule.organizationId),
    lockProject(tx, schedule.projectId, schedule.organizationId),
    lockScheduleSponsor(tx, schedule.sponsorUserId, schedule.organizationId),
    tx
      .insert(attempts)
      .select(
        sql`select ${id}, ${schedule.projectId}, ${schedule.organizationId}, ${schedule.sponsorUserId}, ${schedule.domain},
      ${schedule.version}, ${slot.dueAtMs}, ${slot.nextDueAtMs}, ${requestJson}, ${requestHash}, ${schedule.policyFingerprint}, null,
      'pending', 'unassessed', 'settled', null, null, null, 0, null, null, ${nowMs}, null, null, null, 0,
      ${slot.firstMissedAtMs}, ${slot.lastMissedAtMs}, ${slot.missedCount}, ${schedule.organizationId}, false, null, null, null
      where ${authority} and ${intent} and not exists (select 1 from audit_schedule_attempts a where a.project_id = ${schedule.projectId} and a.launch_state in ('pending','launching','running'))`,
      )
      .onConflictDoNothing(),
    tx
      .update(schedules)
      .set({ nextDueAtMs: slot.nextDueAtMs })
      .where(
        and(
          eq(schedules.projectId, schedule.projectId),
          eq(schedules.organizationId, schedule.organizationId),
          eq(schedules.version, schedule.version),
          eq(schedules.state, "enabled"),
          sql`${schedules.nextDueAtMs} = ${schedule.nextDueAtMs}`,
          authority,
          receipt,
        ),
      ),
    assertScheduleWrite(tx, schedule.projectId, receipt, authority),
  ]);
  return getAttempt(id);
}
async function listRecoverable(nowMs: number, limit = 50) {
  // No archived-project filter: revoked/archived attempts still owe recovery and settlement.
  return db
    .select()
    .from(attempts)
    .where(
      sql`${attempts.launchState} in ('pending','launching','running') and (${attempts.retryAtMs} is null or ${attempts.retryAtMs} <= ${nowMs}) and (${attempts.leaseUntilMs} is null or ${attempts.leaseUntilMs} <= ${nowMs})`,
    )
    .orderBy(
      asc(sql`coalesce(${attempts.retryAtMs}, ${attempts.createdAtMs})`),
      asc(attempts.id),
    )
    .limit(Math.min(50, limit));
}
async function listAttempts(
  scope: AuditScheduleScope,
  projectId: string,
  limit: number,
  cursor?: string,
) {
  return db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.projectId, projectId),
        eq(attempts.organizationId, scope.organizationId),
        scheduleScope(scope, projectId),
        cursor
          ? sql`(${attempts.createdAtMs}, ${attempts.id}) < (select a.created_at_ms, a.id from audit_schedule_attempts a where a.id = ${cursor} and a.project_id = ${projectId} and a.organization_id = ${scope.organizationId})`
          : undefined,
      ),
    )
    .orderBy(desc(attempts.createdAtMs), desc(attempts.id))
    .limit(limit + 1);
}
async function sponsorActive(row: Schedule) {
  const [active] = await db
    .select({ id: schedules.projectId })
    .from(schedules)
    .where(
      and(
        eq(schedules.projectId, row.projectId),
        sql`exists (select 1 from member m where m.organization_id = ${row.organizationId} and m.user_id = ${row.sponsorUserId} and (',' || replace(m.role,' ','') || ',') like '%,owner,%')`,
      ),
    )
    .limit(1);
  return !!active;
}
async function getBillingStatus(organizationId: string) {
  const [row] = await db
    .select({
      isPaying: billingCustomerStatus.isPaying,
      paidPlanStatus: billingCustomerStatus.paidPlanStatus,
    })
    .from(billingCustomerStatus)
    .where(eq(billingCustomerStatus.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}
export const AuditScheduleRepository = {
  getBillingStatus,
  get,
  save,
  sponsorActive,
  listDue,
  admitSlot,
  getAttempt,
  listRecoverable,
  listAttempts,
  claimAttempt,
  renewLease,
  attachAudit,
  markRunning,
  deferAttempt,
  executionAllowed,
  revoke,
  markWorkflowObserved,
};
