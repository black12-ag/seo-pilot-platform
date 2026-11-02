import { env } from "cloudflare:workers";
import { AuditScheduleRepository } from "../repositories/AuditScheduleRepository";
import { AuditBudgetRepository } from "../repositories/AuditBudgetRepository";
import { AuditRepository } from "../repositories/AuditRepository";
import { AuditService } from "./AuditService";
import {
  observeScheduledWorkflow,
  type ScheduledWorkflowObservation,
} from "./scheduledAuditLaunch";
import { sealAuditEvidence } from "./auditEvidenceManifest";
import { AppError } from "@/server/lib/errors";

type RecoveryOutcome = "running" | "terminal" | "deferred" | "unclaimed";

/** Reclaims durable intent; absence is never inferred from lease expiration. */
export async function recoverScheduledAudit(
  attemptId: string,
): Promise<RecoveryOutcome> {
  const nowMs = Date.now();
  const attempt = await AuditScheduleRepository.claimAttempt(attemptId, nowMs);
  if (!attempt?.leaseToken) return "unclaimed";
  const token = attempt.leaseToken;
  const defer = async (reason: string) => {
    const committed = await AuditScheduleRepository.deferAttempt(
      attemptId,
      token,
      reason,
      Date.now() + 5 * 60_000,
      Date.now(),
    );
    return committed ? ("deferred" as const) : ("unclaimed" as const);
  };
  const finish = async (reason: string) => {
    const audit = await AuditRepository.getAuditForProject(
      attemptId,
      attempt.projectId,
    );
    const committed = audit
      ? await sealAuditEvidence({
          auditId: attemptId,
          projectId: attempt.projectId,
          workflowInstanceId: attemptId,
          status: "failed",
          errorCode: reason,
          errorDetail: reason,
        })
      : await AuditBudgetRepository.finish(attemptId, {
          token,
          state: "skipped",
          reason,
          consumedPages: 0,
          nowMs: Date.now(),
        });
    return committed
      ? ("terminal" as const)
      : defer("terminal_receipt_pending");
  };
  let observation = await observeScheduledWorkflow(
    env.SITE_AUDIT_WORKFLOW,
    attemptId,
  );
  const processObservation = async (
    observed: ScheduledWorkflowObservation,
  ): Promise<RecoveryOutcome | null> => {
    if (observed.state === "unknown") return defer("workflow_status_unknown");
    if (observed.state === "active" || observed.state === "terminal") {
      if (
        !(await AuditScheduleRepository.markWorkflowObserved(
          attemptId,
          token,
          Date.now(),
        ))
      )
        return "unclaimed";
      if (observed.state === "terminal")
        return finish(`workflow_${observed.status}`);
      if (
        await AuditScheduleRepository.executionAllowed(attemptId, Date.now())
      ) {
        return (await defer("workflow_running")) === "unclaimed"
          ? "unclaimed"
          : "running";
      }
      if (
        !(await AuditScheduleRepository.revoke(
          attemptId,
          "execution_revoked",
          Date.now(),
          token,
        ))
      )
        return "unclaimed";
      try {
        await (await env.SITE_AUDIT_WORKFLOW.get(attemptId)).terminate();
      } catch {
        return defer("termination_unknown");
      }
      observation = await observeScheduledWorkflow(
        env.SITE_AUDIT_WORKFLOW,
        attemptId,
      );
      if (observation.state === "active" || observation.state === "unknown")
        return defer("termination_pending");
      return finish("execution_revoked");
    }
    return null;
  };
  const observedResult = await processObservation(observation);
  if (observedResult) return observedResult;
  // Explicit one-day engine retention protects retries only inside this short window.
  const replayExpired =
    attempt.startedAtMs !== null && nowMs >= attempt.startedAtMs + 15 * 60_000;
  if (
    attempt.workflowObservedAtMs !== null ||
    replayExpired ||
    attempt.launchCount >= 3 ||
    nowMs >= attempt.expiresAtMs ||
    attempt.executionRevokedAtMs !== null
  ) {
    if (
      !(await AuditScheduleRepository.revoke(
        attemptId,
        "launch_expired_or_revoked",
        Date.now(),
        token,
      ))
    )
      return "unclaimed";
    return finish("launch_expired_or_revoked");
  }
  try {
    const result = await AuditService.startAudit({
      scheduledAttemptId: attemptId,
      leaseToken: token,
    });
    if ("observation" in result && result.observation)
      return (
        (await processObservation(result.observation)) ??
        defer("create_not_confirmed")
      );
    return defer("create_not_confirmed");
  } catch (error) {
    if (
      error instanceof AppError &&
      [
        "FORBIDDEN",
        "AUDIT_PAGE_LIMIT_EXCEEDED",
        "AUDIT_CAPACITY_REACHED",
      ].includes(error.code)
    ) {
      const reason = [
        "budget_reapproval",
        "owner_required",
        "project_changed",
        "paid_recurrence_unavailable",
        "unsupported_background_authority",
      ].includes(error.message)
        ? error.message
        : error.code;
      if (
        !(await AuditScheduleRepository.revoke(
          attemptId,
          reason,
          Date.now(),
          token,
        ))
      )
        return "unclaimed";
      const current = await observeScheduledWorkflow(
        env.SITE_AUDIT_WORKFLOW,
        attemptId,
      );
      if (current.state === "missing") return finish(reason);
      return (
        (await processObservation(current)) ?? defer("launch_recovery_pending")
      );
    }
    return defer(
      error instanceof AppError ? error.message : "launch_recovery_pending",
    );
  }
}

/** Authorized deletion first fences durable intent and proves execution stopped. */
export async function stopScheduledAuditForDeletion(
  attemptId: string,
  projectId: string,
) {
  await AuditScheduleRepository.revoke(attemptId, "result_deleted", Date.now());
  let observation = await observeScheduledWorkflow(
    env.SITE_AUDIT_WORKFLOW,
    attemptId,
  );
  if (observation.state === "active") {
    try {
      await (await env.SITE_AUDIT_WORKFLOW.get(attemptId)).terminate();
    } catch {
      throw new AppError("CONFLICT", "Workflow termination is not confirmed.");
    }
    observation = await observeScheduledWorkflow(
      env.SITE_AUDIT_WORKFLOW,
      attemptId,
    );
  }
  if (observation.state === "active" || observation.state === "unknown")
    throw new AppError("CONFLICT", "Workflow state is not confirmed.");
  if (
    !(await sealAuditEvidence({
      auditId: attemptId,
      projectId,
      workflowInstanceId: attemptId,
      status: "failed",
      errorCode: "result_deleted",
      errorDetail: "Result deleted by an authorized project member.",
    }))
  )
    throw new AppError("CONFLICT", "Evidence settlement is not confirmed.");
}
