import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  audits,
  projects,
  auditRunEvidence as evidence,
  auditScheduleAttempts as attempts,
} from "@/db/schema";
import {
  lockProject,
  lockAuthorityOrganization,
} from "@/server/features/site-authority/repositories/siteAuthorityProjectWrites";
import {
  auditEvidenceManifestSchema,
  type AuditEvidenceManifest,
} from "@/types/schemas/audit-evidence";
import { getAttempt } from "./auditScheduleAttemptWrites";
import { finishAttemptWrites } from "./AuditBudgetRepository";

async function getForProject(
  projectId: string,
  organizationId: string,
  auditId: string,
) {
  const [row] = await db
    .select({ evidence })
    .from(evidence)
    .innerJoin(projects, eq(evidence.projectId, projects.id))
    .where(
      and(
        eq(evidence.projectId, projectId),
        eq(evidence.auditId, auditId),
        eq(projects.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row?.evidence ?? null;
}
/** Workflow identity is already authenticated by the internal runtime. */
async function getForWorkflow(
  auditId: string,
  projectId: string,
  workflowInstanceId: string,
) {
  const [row] = await db
    .select({ evidence })
    .from(evidence)
    .innerJoin(audits, eq(audits.id, evidence.auditId))
    .where(
      and(
        eq(evidence.auditId, auditId),
        eq(evidence.projectId, projectId),
        eq(audits.projectId, projectId),
        eq(audits.workflowInstanceId, workflowInstanceId),
      ),
    )
    .limit(1);
  return row?.evidence ?? null;
}
async function getDeletedAttempt(
  projectId: string,
  organizationId: string,
  auditId: string,
) {
  const [row] = await db
    .select({ attempt: attempts })
    .from(attempts)
    .innerJoin(projects, eq(attempts.projectId, projects.id))
    .where(
      and(
        eq(attempts.id, auditId),
        eq(attempts.projectId, projectId),
        eq(attempts.organizationId, organizationId),
        eq(projects.organizationId, organizationId),
        eq(attempts.resultDeleted, true),
      ),
    )
    .limit(1);
  return row?.attempt ?? null;
}
async function beginSeal(input: {
  auditId: string;
  projectId: string;
  workflowInstanceId: string;
  nowMs: number;
}) {
  const token = crypto.randomUUID();
  // This UPDATE takes the same audit-row lock as every page/issue mutation.
  await db
    .update(audits)
    .set({ evidenceSealToken: token, evidenceSealStartedAtMs: input.nowMs })
    .where(
      and(
        eq(audits.id, input.auditId),
        eq(audits.projectId, input.projectId),
        eq(audits.workflowInstanceId, input.workflowInstanceId),
        sql`${audits.evidenceSealToken} is null`,
      ),
    );
  const [row] = await db
    .select({
      token: audits.evidenceSealToken,
      finalizedAtMs: audits.evidenceSealStartedAtMs,
    })
    .from(audits)
    .where(
      and(
        eq(audits.id, input.auditId),
        eq(audits.projectId, input.projectId),
        eq(audits.workflowInstanceId, input.workflowInstanceId),
      ),
    )
    .limit(1);
  return row?.token && row.finalizedAtMs !== null
    ? { token: row.token, finalizedAtMs: row.finalizedAtMs }
    : null;
}
async function seal(input: {
  auditId: string;
  projectId: string;
  sealToken: string;
  manifest: AuditEvidenceManifest;
  status: "completed" | "failed";
  errorCode?: string;
  errorDetail?: string;
}) {
  const manifest = auditEvidenceManifestSchema.parse(input.manifest);
  if (
    manifest.terminalStatus !== input.status ||
    manifest.auditId !== input.auditId ||
    manifest.projectId !== input.projectId
  )
    return false;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project) return false;
  const attempt = await getAttempt(input.auditId);
  if (
    attempt &&
    (attempt.projectId !== input.projectId ||
      attempt.organizationId !== project.organizationId)
  )
    return false;
  const manifestJson = JSON.stringify(manifest);
  const completionToken = crypto.randomUUID();
  const auditGuard = sql`exists (select 1 from audits a where a.id = ${input.auditId} and a.project_id = ${input.projectId} and a.evidence_seal_token = ${input.sealToken} and a.evidence_seal_started_at_ms = ${manifest.finalizedAtMs})`;
  const sealReceipt = sql`exists (select 1 from audit_run_evidence e where e.audit_id = ${input.auditId} and e.project_id = ${input.projectId} and e.seal_token = ${input.sealToken} and e.artifact_sha256 = ${manifest.artifact.sha256})`;
  await runBatch((tx) => [
    lockAuthorityOrganization(tx, project.organizationId),
    lockProject(tx, project.id, project.organizationId),
    tx
      .update(audits)
      .set({ startUrl: sql`${audits.startUrl}` })
      .where(
        and(
          eq(audits.id, input.auditId),
          eq(audits.projectId, input.projectId),
        ),
      ),
    tx
      .insert(evidence)
      .select(
        sql`select ${input.auditId}, ${input.projectId}, ${manifestJson}, ${manifest.artifact.key}, ${manifest.artifact.sha256}, ${manifest.coverage.state}, ${manifest.observedStartAtMs}, ${manifest.observedEndAtMs}, ${manifest.finalizedAtMs}, ${input.sealToken} where ${auditGuard}`,
      )
      .onConflictDoNothing(),
    tx
      .update(audits)
      .set({
        status: input.status,
        currentPhase: input.status === "completed" ? "completed" : "failed",
        completedAt: new Date(manifest.finalizedAtMs).toISOString(),
        errorCode: input.errorCode ?? null,
        errorDetail: input.errorDetail?.slice(0, 1000) ?? null,
      })
      .where(
        and(
          eq(audits.id, input.auditId),
          eq(audits.projectId, input.projectId),
          auditGuard,
          sealReceipt,
        ),
      ),
    ...(attempt
      ? [
          ...finishAttemptWrites(
            tx,
            attempt,
            {
              state: input.status,
              reason: manifest.coverage.stopReasons.join(",") || null,
              consumedPages: manifest.coverage.attempted,
              accountingComplete: input.status === "completed",
              nowMs: manifest.finalizedAtMs,
            },
            sql`${auditGuard} and ${sealReceipt}`,
            completionToken,
          ),
          tx
            .update(attempts)
            .set({ coverageState: manifest.coverage.state })
            .where(
              and(
                eq(attempts.id, attempt.id),
                eq(attempts.completionToken, completionToken),
                sealReceipt,
              ),
            ),
        ]
      : []),
    ...(attempt
      ? [
          tx
            .update(audits)
            .set({ projectId: sql`null` })
            .where(
              and(
                eq(audits.id, input.auditId),
                auditGuard,
                sealReceipt,
                sql`exists (select 1 from audit_schedule_attempts a where a.id = ${attempt.id} and (a.launch_state in ('pending','launching','running') or a.billing_state <> 'settled'))`,
              ),
            ),
        ]
      : []),
  ]);
  const row = await getForProject(
    input.projectId,
    project.organizationId,
    input.auditId,
  );
  return (
    row?.artifactSha256 === manifest.artifact.sha256 &&
    row.sealToken === input.sealToken
  );
}
export const AuditEvidenceRepository = {
  getForProject,
  getForWorkflow,
  getDeletedAttempt,
  beginSeal,
  seal,
};

/** Called within the existing audit deletion transaction, before removing its FK. */
export function markResultDeletedWrites(
  tx: Parameters<Parameters<typeof runBatch>[0]>[0],
  auditId: string,
  projectId: string,
) {
  return [
    tx
      .update(attempts)
      .set({
        resultDeleted: true,
        executionRevokedAtMs: Date.now(),
        reason: "result_deleted",
      })
      .where(
        and(
          eq(attempts.id, auditId),
          eq(attempts.projectId, projectId),
          sql`(${attempts.auditId} is null or ${attempts.auditId} = ${auditId}) and exists (select 1 from audits a where a.id = ${auditId} and a.project_id = ${projectId})`,
        ),
      ),
  ];
}
