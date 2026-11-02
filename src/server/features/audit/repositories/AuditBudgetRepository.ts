import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  auditScheduleAttempts as attempts,
  auditScheduleDailyUsage as usage,
  auditEvents as events,
} from "@/db/schema";
import {
  lockProject,
  lockAuthorityOrganization,
} from "@/server/features/site-authority/repositories/siteAuthorityProjectWrites";
import { sha256Hex } from "@/server/lib/audit/ids";
import { auditScheduleEstimateInputSchema } from "@/types/schemas/audit-schedule";
import type { AuditRecurringPolicy } from "../services/auditSchedulePolicy";
import { getAttempt } from "./auditScheduleAttemptWrites";
import {
  assertScheduleWrite,
  currentAttemptAuthority,
  lockScheduleSponsor,
} from "./auditScheduleProjectWrites";

type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];
type AttemptFinish = {
  token?: string;
  state: "completed" | "failed" | "skipped" | "cancelled";
  reason: string | null;
  consumedPages: number;
  accountingComplete?: boolean;
  nowMs: number;
};
async function reserve(
  attemptId: string,
  token: string,
  policy: AuditRecurringPolicy,
  nowMs: number,
) {
  const attempt = await getAttempt(attemptId);
  if (!attempt) return false;
  const settings = auditScheduleEstimateInputSchema.parse(
    JSON.parse(attempt.requestJson),
  );
  if (
    settings.renderJavaScript ||
    settings.lighthouseStrategy !== "none" ||
    settings.maxCostMicrosPerRun !== 0 ||
    settings.maxCostMicrosPerUtcDay !== 0
  )
    return false;
  if (attempt.policyFingerprint !== (await sha256Hex(JSON.stringify(policy))))
    return false;
  if (attempt.reservedDay !== null)
    return (
      attempt.billingState === "reserved" &&
      attempt.leaseToken === token &&
      (attempt.leaseUntilMs ?? 0) > nowMs
    );
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const reservationToken = crypto.randomUUID();
  const authority = currentAttemptAuthority(attempt);
  const receipt = sql`exists (select 1 from audit_schedule_attempts a where a.id = ${attemptId} and a.reservation_token = ${reservationToken})`;
  const dayScope = and(
    eq(usage.organizationId, attempt.organizationId),
    eq(usage.utcDay, day),
  );
  await runBatch((tx) => [
    lockAuthorityOrganization(tx, attempt.organizationId),
    lockProject(tx, attempt.projectId, attempt.organizationId),
    lockScheduleSponsor(tx, attempt.sponsorUserId, attempt.organizationId),
    tx
      .insert(usage)
      .values({ organizationId: attempt.organizationId, utcDay: day })
      .onConflictDoNothing(),
    tx
      .update(attempts)
      .set({
        reservedDay: day,
        reservedPages: settings.maxPages,
        reservationToken,
        billingState: "reserved",
      })
      .where(
        and(
          eq(attempts.id, attemptId),
          eq(attempts.projectId, attempt.projectId),
          eq(attempts.organizationId, attempt.organizationId),
          eq(attempts.leaseToken, token),
          sql`${attempts.leaseUntilMs} > ${nowMs} and ${attempts.executionRevokedAtMs} is null and ${attempts.reservedDay} is null and ${attempts.expiresAtMs} > ${nowMs} and ${attempts.launchState} in ('pending','launching')`,
          authority,
          sql`not exists (select 1 from audits a where a.project_id = ${attempt.projectId} and a.status = 'running' and a.id <> ${attemptId})`,
          sql`(select count(*) from audit_schedule_attempts a where a.organization_id = ${attempt.organizationId} and a.billing_state in ('reserved','unknown','release_pending')) < ${policy.maxConcurrentRuns}`,
          sql`exists (select 1 from audit_schedule_daily_usage u where u.organization_id = ${attempt.organizationId} and u.utc_day = ${day}
          and u.reserved_runs + u.consumed_runs < ${Math.min(policy.maxRunsPerUtcDay, settings.maxRunsPerUtcDay)}
          and u.reserved_pages + u.consumed_pages + ${settings.maxPages} <= ${Math.min(policy.maxPagesPerUtcDay, settings.maxPagesPerUtcDay)})`,
        ),
      ),
    tx
      .update(usage)
      .set({
        reservedRuns: sql`${usage.reservedRuns}+1`,
        reservedPages: sql`${usage.reservedPages}+${settings.maxPages}`,
      })
      .where(and(dayScope, receipt)),
    assertScheduleWrite(tx, attempt.projectId, receipt, authority),
  ]);
  return (await getAttempt(attemptId))?.reservationToken === reservationToken;
}
/** Caller holds organization then project locks; receipt binds every settlement write. */
export function finishAttemptWrites(
  tx: Tx,
  attempt: typeof attempts.$inferSelect,
  input: AttemptFinish,
  guard: SQL,
  completionToken: string,
) {
  const receipt = sql`exists (select 1 from audit_schedule_attempts a where a.id = ${attempt.id} and a.project_id = ${attempt.projectId} and a.organization_id = ${attempt.organizationId} and a.completion_token = ${completionToken})`;
  if (!Number.isSafeInteger(input.consumedPages) || input.consumedPages < 0)
    throw new Error("Invalid observed page count");
  // A process can die after fetch but before row persistence. Once launch began,
  // charge the reserved upper bound; persisted rows are only a lower bound.
  const consumedPages =
    attempt.startedAtMs !== null && !input.accountingComplete
      ? Math.max(attempt.reservedPages, input.consumedPages)
      : input.consumedPages;
  const snapshot = sql`${attempts.billingState} = ${attempt.billingState} and coalesce(${attempts.reservedDay},'') = coalesce(${attempt.reservedDay},'')
    and ${attempts.reservedPages} = ${attempt.reservedPages} and coalesce(${attempts.reservationToken},'') = coalesce(${attempt.reservationToken},'')
    and coalesce(${attempts.startedAtMs},0) = ${attempt.startedAtMs ?? 0} and ${attempts.launchCount} = ${attempt.launchCount}`;
  const eventType =
    input.state === "completed"
      ? "audit_completed"
      : input.state === "failed"
        ? "audit_failed"
        : "attempt_skipped";
  return [
    tx
      .update(attempts)
      .set({
        launchState: input.state,
        reason: input.reason,
        finishedAtMs: input.nowMs,
        retryAtMs: null,
        leaseToken: null,
        leaseUntilMs: null,
        executionRevokedAtMs: input.nowMs,
        completionToken,
        billingState: "settled",
      })
      .where(
        and(
          eq(attempts.id, attempt.id),
          eq(attempts.projectId, attempt.projectId),
          eq(attempts.organizationId, attempt.organizationId),
          sql`${attempts.launchState} in ('pending','launching','running')`,
          snapshot,
          guard,
        ),
      ),
    ...(attempt.billingState === "reserved" && attempt.reservedDay !== null
      ? [
          tx
            .update(usage)
            .set({
              reservedRuns: sql`${usage.reservedRuns}-1`,
              reservedPages: sql`${usage.reservedPages}-${attempt.reservedPages}`,
              consumedRuns: sql`${usage.consumedRuns}+${attempt.startedAtMs === null && consumedPages === 0 ? 0 : 1}`,
              consumedPages: sql`${usage.consumedPages}+${consumedPages}`,
            })
            .where(
              and(
                eq(usage.organizationId, attempt.organizationId),
                eq(usage.utcDay, attempt.reservedDay),
                receipt,
              ),
            ),
        ]
      : []),
    tx
      .insert(events)
      .select(
        sql`select ${attempt.id + ":" + eventType}, ${attempt.id}, ${attempt.projectId}, ${eventType}, ${JSON.stringify({ state: input.state, reason: input.reason, consumedPages, observedPagesLowerBound: input.consumedPages, accountingMode: attempt.startedAtMs !== null && !input.accountingComplete ? "reserved_upper_bound" : "observed", pageUsageKnown: attempt.startedAtMs === null || input.accountingComplete === true, pageOverrun: input.consumedPages > attempt.reservedPages })}, ${input.nowMs} where ${receipt}`,
      )
      .onConflictDoNothing(),
  ];
}
async function finish(attemptId: string, input: AttemptFinish) {
  const attempt = await getAttempt(attemptId);
  if (!attempt) return false;
  const completionToken = crypto.randomUUID();
  const guard = input.token
    ? sql`${attempts.leaseToken} = ${input.token} and ${attempts.leaseUntilMs} > ${input.nowMs}`
    : sql`${attempts.leaseToken} is null or ${attempts.leaseUntilMs} <= ${input.nowMs}`;
  await runBatch((tx) => [
    lockAuthorityOrganization(tx, attempt.organizationId),
    lockProject(tx, attempt.projectId, attempt.organizationId),
    ...finishAttemptWrites(tx, attempt, input, guard, completionToken),
  ]);
  return (await getAttempt(attemptId))?.completionToken === completionToken;
}
async function getUsage(organizationId: string, utcDay: string) {
  const [row] = await db
    .select()
    .from(usage)
    .where(
      and(eq(usage.organizationId, organizationId), eq(usage.utcDay, utcDay)),
    )
    .limit(1);
  return row ?? null;
}
async function outstandingUsage(organizationId: string) {
  const [row] = await db
    .select({
      outstandingRuns: sql<number>`cast(count(*) as integer)`,
      unknownRuns: sql<number>`cast(coalesce(sum(case when ${attempts.billingState} in ('unknown','release_pending') then 1 else 0 end),0) as integer)`,
    })
    .from(attempts)
    .where(
      and(
        eq(attempts.organizationId, organizationId),
        sql`${attempts.billingState} in ('reserved','unknown','release_pending')`,
      ),
    );
  return row ?? { outstandingRuns: 0, unknownRuns: 0 };
}
export const AuditBudgetRepository = {
  reserve,
  finish,
  getUsage,
  outstandingUsage,
};
