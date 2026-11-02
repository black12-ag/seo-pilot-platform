import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { auditScheduleAttempts as attempts } from "@/db/schema";
import {
  lockProject,
  lockAuthorityOrganization,
} from "@/server/features/site-authority/repositories/siteAuthorityProjectWrites";
import {
  assertScheduleWrite,
  currentAttemptAuthority,
  lockScheduleSponsor,
} from "./auditScheduleProjectWrites";

export async function getAttempt(attemptId: string) {
  const [row] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .limit(1);
  return row ?? null;
}
export async function claimAttempt(
  attemptId: string,
  nowMs: number,
  leaseMs = 120_000,
) {
  const leaseToken = crypto.randomUUID();
  const [row] = await db
    .update(attempts)
    .set({ leaseToken, leaseUntilMs: nowMs + leaseMs })
    .where(
      and(
        eq(attempts.id, attemptId),
        sql`${attempts.launchState} in ('pending','launching','running') and (${attempts.leaseUntilMs} is null or ${attempts.leaseUntilMs} <= ${nowMs}) and (${attempts.retryAtMs} is null or ${attempts.retryAtMs} <= ${nowMs})`,
      ),
    )
    .returning();
  return row ?? null;
}
export async function renewLease(
  attemptId: string,
  token: string,
  nowMs: number,
) {
  const rows = await db
    .update(attempts)
    .set({ leaseUntilMs: nowMs + 120_000 })
    .where(
      and(
        eq(attempts.id, attemptId),
        eq(attempts.leaseToken, token),
        sql`${attempts.leaseUntilMs} > ${nowMs} and ${attempts.launchState} in ('pending','launching','running')`,
      ),
    )
    .returning({ id: attempts.id });
  return rows.length === 1;
}
async function launchTransition(
  attemptId: string,
  token: string,
  nowMs: number,
  running: boolean,
) {
  const attempt = await getAttempt(attemptId);
  if (!attempt) return false;
  const completionToken = crypto.randomUUID();
  const authority = currentAttemptAuthority(
    attempt,
    attempt.launchState === "running",
  );
  const receipt = sql`exists (select 1 from audit_schedule_attempts a where a.id = ${attemptId} and a.completion_token = ${completionToken})`;
  await runBatch((tx) => [
    lockAuthorityOrganization(tx, attempt.organizationId),
    lockProject(tx, attempt.projectId, attempt.organizationId),
    lockScheduleSponsor(tx, attempt.sponsorUserId, attempt.organizationId),
    tx
      .update(attempts)
      .set(
        running
          ? {
              launchState: "running",
              startedAtMs: sql`coalesce(${attempts.startedAtMs}, ${nowMs})`,
              launchCount: sql`${attempts.launchCount}+1`,
              completionToken,
            }
          : {
              auditId: attemptId,
              launchState: sql`case when ${attempts.launchState} = 'running' then 'running' else 'launching' end`,
              completionToken,
            },
      )
      .where(
        and(
          eq(attempts.id, attemptId),
          eq(attempts.projectId, attempt.projectId),
          eq(attempts.organizationId, attempt.organizationId),
          eq(attempts.leaseToken, token),
          sql`${attempts.leaseUntilMs} > ${nowMs} and ${attempts.executionRevokedAtMs} is null and ${attempts.expiresAtMs} > ${nowMs} and ${attempts.billingState} = 'reserved' and ${attempts.launchState} in ('pending','launching','running')`,
          authority,
          running
            ? sql`${attempts.launchCount} < 3 and (${attempts.startedAtMs} is null or ${attempts.startedAtMs} + 900000 > ${nowMs}) and ${attempts.workflowObservedAtMs} is null`
            : undefined,
          sql`exists (select 1 from audits a where a.id = ${attemptId} and a.project_id = ${attempt.projectId} and a.workflow_instance_id = ${attemptId} and a.status = 'running' and a.evidence_seal_token is null)`,
        ),
      ),
    assertScheduleWrite(tx, attempt.projectId, receipt, authority),
  ]);
  return (await getAttempt(attemptId))?.completionToken === completionToken;
}
export const attachAudit = (attemptId: string, token: string, nowMs: number) =>
  launchTransition(attemptId, token, nowMs, false);
export const markRunning = (attemptId: string, token: string, nowMs: number) =>
  launchTransition(attemptId, token, nowMs, true);
export async function deferAttempt(
  attemptId: string,
  token: string,
  reason: string,
  retryAtMs: number,
  nowMs: number,
) {
  const rows = await db
    .update(attempts)
    .set({ reason, retryAtMs, leaseToken: null, leaseUntilMs: null })
    .where(
      and(
        eq(attempts.id, attemptId),
        eq(attempts.leaseToken, token),
        sql`${attempts.leaseUntilMs} > ${nowMs} and ${attempts.launchState} in ('pending','launching','running')`,
      ),
    )
    .returning({ id: attempts.id });
  return rows.length === 1;
}
export async function executionAllowed(attemptId: string, nowMs: number) {
  const attempt = await getAttempt(attemptId);
  if (
    !attempt ||
    attempt.executionRevokedAtMs !== null ||
    attempt.launchState !== "running"
  )
    return false;
  const [row] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.id, attemptId),
        sql`${attempts.executionRevokedAtMs} is null and ${attempts.launchState} = 'running' and ${attempts.billingState} = 'reserved'`,
        currentAttemptAuthority(attempt, true),
        sql`exists (select 1 from audits a where a.id = ${attemptId} and a.project_id = ${attempt.projectId} and a.workflow_instance_id = ${attemptId} and a.status = 'running' and a.evidence_seal_token is null)`,
        sql`(${attempts.startedAtMs} is null or ${attempts.startedAtMs} + ${22 * 60 * 60 * 1000} > ${nowMs})`,
      ),
    )
    .limit(1);
  return !!row;
}
export async function revoke(
  attemptId: string,
  reason: string,
  nowMs: number,
  token?: string,
) {
  const rows = await db
    .update(attempts)
    .set({ executionRevokedAtMs: nowMs, reason })
    .where(
      and(
        eq(attempts.id, attemptId),
        token !== undefined
          ? sql`${attempts.leaseToken} = ${token} and ${attempts.leaseUntilMs} > ${nowMs}`
          : undefined,
        sql`${attempts.launchState} in ('pending','launching','running')`,
      ),
    )
    .returning({ id: attempts.id });
  return rows.length === 1;
}

export async function markWorkflowObserved(
  attemptId: string,
  token: string,
  nowMs: number,
) {
  const rows = await db
    .update(attempts)
    .set({
      workflowObservedAtMs: sql`coalesce(${attempts.workflowObservedAtMs}, ${nowMs})`,
    })
    .where(
      and(
        eq(attempts.id, attemptId),
        eq(attempts.leaseToken, token),
        sql`${attempts.leaseUntilMs} > ${nowMs}`,
      ),
    )
    .returning({ id: attempts.id });
  return rows.length === 1;
}
