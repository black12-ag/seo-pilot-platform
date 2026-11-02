import { AuditScheduleRepository } from "../repositories/AuditScheduleRepository";
import { sealAuditEvidence } from "./auditEvidenceManifest";
import { observeScheduledWorkflow } from "./scheduledAuditLaunch";
/**
 * Reconciles audits stuck in "running" with the actual state of their
 * Cloudflare Workflow instance.
 *
 * A workflow killed by the platform (OOM, CPU limit, deploy reset) never
 * reaches its own mark-failed step, and an instance can expire from Workflows
 * retention entirely. Two callers close that gap:
 *   - AuditService.getStatus (lazy: whenever the UI polls a running audit)
 *   - the scheduled watchdog (reconcileStaleAudits, every cron tick) — so
 *     zombie rows die even if nobody ever reopens the page, and the instance
 *     error is copied into the row before Workflows retention deletes it.
 */
import { env } from "cloudflare:workers";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { audits, projects } from "@/db/schema";
import { getDatabaseProvider } from "@/db/provider";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { type AuditErrorInfo } from "@/server/lib/audit/audit-errors";
import { captureServerEvent } from "@/server/lib/posthog";

/**
 * Don't declare an instance "lost" until the audit is comfortably older than
 * any legitimate create/start delay: startAudit inserts the row before
 * creating the workflow, so a brand-new audit can briefly have no instance.
 */
const INSTANCE_LOST_GRACE_MS = 10 * 60 * 1000;

/** Audits still "running" after this long get reconciled by the watchdog. */
const STALE_RUNNING_AFTER_MS = 15 * 60 * 1000;

const WATCHDOG_BATCH_LIMIT = 100;

type RunningAudit = {
  id: string;
  workflowInstanceId: string | null;
  startedAt: string;
  currentPhase: string | null;
};

/**
 * If the audit's workflow instance is dead (errored/terminated) or gone,
 * flip the row to failed with a classified error. Returns the error info
 * when the row was flipped, null when the audit is genuinely still running.
 */
export async function reconcileRunningAudit(
  audit: RunningAudit,
): Promise<AuditErrorInfo | null> {
  if (!audit.workflowInstanceId) return null;
  // Recurrence recovery owns its launch leases, intent and internal reservation.
  if (await AuditScheduleRepository.getAttempt(audit.id)) return null;

  const observation = await observeScheduledWorkflow(
    env.SITE_AUDIT_WORKFLOW,
    audit.workflowInstanceId,
  );
  if (observation.state === "active" || observation.state === "unknown")
    return null;
  if (
    observation.state === "missing" &&
    !isOlderThan(audit.startedAt, INSTANCE_LOST_GRACE_MS)
  )
    return null;
  const errorInfo: AuditErrorInfo = {
    errorCode: observation.state === "missing" ? "instance_lost" : "unknown",
    errorDetail:
      observation.state === "missing"
        ? "Workflow instance not found"
        : `Workflow instance ${observation.status}`,
  };
  const current = await AuditRepository.getAuditForWorkflow(
    audit.id,
    audit.workflowInstanceId,
  );
  if (!current || current.status !== "running") return null;
  if (current.requestedConfig) {
    const sealed = await sealAuditEvidence({
      auditId: audit.id,
      projectId: current.projectId,
      workflowInstanceId: audit.workflowInstanceId,
      status: "failed",
      ...errorInfo,
    });
    if (!sealed) return null;
  } else {
    const failed = await AuditRepository.failAudit(
      audit.id,
      audit.workflowInstanceId,
      { ...errorInfo, failedPhase: audit.currentPhase },
    );
    if (!failed) return null;
  }
  return errorInfo;
}

/** Cron watchdog: sweep stale running audits and reconcile each. */
export async function reconcileStaleAudits() {
  const cutoff = new Date(Date.now() - STALE_RUNNING_AFTER_MS);
  const stale = await getStaleRunningAudits(cutoff, WATCHDOG_BATCH_LIMIT);

  for (const audit of stale) {
    try {
      const errorInfo = await reconcileRunningAudit(audit);
      if (!errorInfo) continue;

      console.log(
        `Audit watchdog: marked ${audit.id} failed (${errorInfo.errorCode}, phase=${audit.currentPhase})`,
      );
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, audit.projectId),
      });
      if (!project) continue;
      await captureServerEvent({
        distinctId: audit.startedByUserId,
        event: "site_audit:complete",
        organizationId: project.organizationId,
        properties: {
          project_id: audit.projectId,
          status: "failed",
          reconciled_by: "watchdog",
          error_code: errorInfo.errorCode,
          pages_crawled: audit.pagesCrawled,
          pages_total: audit.pagesTotal,
        },
      });
    } catch (error) {
      // One unreconcilable audit must not stop the sweep.
      console.error(`Audit watchdog: failed to reconcile ${audit.id}:`, error);
    }
  }
}

/**
 * Running audits started before the cutoff — watchdog candidates. Timestamps
 * are stored as text, so this compares lexicographically: PG rows use ISO
 * with a "T", D1-default rows use "YYYY-MM-DD HH:MM:SS" (space < "T", so a
 * same-day ISO cutoff would misorder against D1 rows without the reformat).
 */
async function getStaleRunningAudits(cutoff: Date, limit: number) {
  const iso = cutoff.toISOString();
  const startedBefore =
    getDatabaseProvider() === "postgres"
      ? iso
      : iso.replace("T", " ").slice(0, 19);
  // Oldest first: genuinely dead audits age past the cutoff and stay there,
  // while long-but-live crawls are the newest of the stale set — without a
  // deterministic order they could occupy the whole batch every sweep and
  // starve real zombies.
  return db.query.audits.findMany({
    where: and(
      eq(audits.status, "running"),
      lt(audits.startedAt, startedBefore),
    ),
    orderBy: audits.startedAt,
    columns: {
      id: true,
      workflowInstanceId: true,
      projectId: true,
      startedByUserId: true,
      startedAt: true,
      currentPhase: true,
      pagesCrawled: true,
      pagesTotal: true,
    },
    limit,
  });
}

function isOlderThan(startedAt: string, ageMs: number): boolean {
  // D1-default timestamps ("YYYY-MM-DD HH:MM:SS") lack the T/Z; normalize so
  // Date.parse reads them as UTC, matching the PG ISO format.
  const parsed = Date.parse(
    startedAt.includes("T") ? startedAt : `${startedAt.replace(" ", "T")}Z`,
  );
  if (Number.isNaN(parsed)) return true;
  return parsed < Date.now() - ageMs;
}
