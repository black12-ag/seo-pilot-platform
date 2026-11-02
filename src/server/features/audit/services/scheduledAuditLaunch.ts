import { env } from "cloudflare:workers";
import { AuditScheduleRepository } from "../repositories/AuditScheduleRepository";
import { AuditBudgetRepository } from "../repositories/AuditBudgetRepository";
import { AuditRepository } from "../repositories/AuditRepository";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { CrawlerCredentialService } from "./CrawlerCredentialService";
import { auditScheduleAccess } from "./auditScheduleAccess";
import { auditSchedulePolicy } from "./auditSchedulePolicy";
import { auditScheduleEstimateInputSchema } from "@/types/schemas/audit-schedule";
import { usesBetterAuthServer } from "@/server/lib/runtime-env";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { AUDIT_LIMITS, type AuditLimitTier } from "./audit-capacity";
import type { AuditConfig } from "@/server/lib/audit/types";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AppError } from "@/server/lib/errors";
/** Scheduled IDs are consumed forever, including fast terminal workflows. */
export type ScheduledWorkflowObservation =
  | { state: "active"; status: string }
  | { state: "terminal"; status: "complete" | "errored" | "terminated" }
  | { state: "missing" }
  | { state: "unknown" };

export async function observeScheduledWorkflow<P>(
  workflow: Workflow<P>,
  id: string,
): Promise<ScheduledWorkflowObservation> {
  try {
    const instance = await workflow.get(id);
    const { status } = await instance.status();
    if (
      ["queued", "running", "waiting", "waitingForPause", "paused"].includes(
        status,
      )
    ) {
      return { state: "active", status };
    }
    if (
      status === "complete" ||
      status === "errored" ||
      status === "terminated"
    ) {
      return { state: "terminal", status };
    }
    return { state: "unknown" };
  } catch (error) {
    // Only the engine's explicit absence signal authorizes create. A status
    // transport failure (even a 404 from a proxy) is not evidence of absence.
    const message = error instanceof Error ? error.message : "";
    return message === "WORKFLOW_ERROR: instance does not exist" ||
      /^(?:instance[._ ]not[._ ]found|workflow instance not found)\b/i.test(
        message,
      )
      ? { state: "missing" }
      : { state: "unknown" };
  }
}

export async function createScheduledWorkflow<P>(
  workflow: Workflow<P>,
  options: WorkflowInstanceCreateOptions<P> & { id: string },
): Promise<ScheduledWorkflowObservation> {
  try {
    await workflow.create(options);
  } catch {
    // A lost create reply or same-ID conflict may already have completed.
  }
  return observeScheduledWorkflow(workflow, options.id);
}

/** Internal only: identity, request and stable IDs are loaded from durable intent. */
export async function launchScheduledAudit(
  attemptId: string,
  leaseToken: string,
  resolveAuditLimitTier: (
    customer: BillingCustomerContext,
  ) => Promise<AuditLimitTier>,
) {
  const attempt = await AuditScheduleRepository.getAttempt(attemptId);
  if (
    !attempt ||
    attempt.leaseToken !== leaseToken ||
    (attempt.leaseUntilMs ?? 0) <= Date.now()
  )
    throw new AppError("CONFLICT", "launch_lease_lost");
  const request = auditScheduleEstimateInputSchema.parse(
    JSON.parse(attempt.requestJson),
  );
  if (request.renderJavaScript || request.lighthouseStrategy !== "none")
    throw new AppError("FORBIDDEN", "paid_recurrence_unavailable");
  if (!(await usesBetterAuthServer()))
    throw new AppError("FORBIDDEN", "unsupported_background_authority");
  if (!attempt.sponsorUserId) throw new AppError("FORBIDDEN", "owner_required");
  const { project } = await auditScheduleAccess(
    {
      userId: attempt.sponsorUserId,
      organizationId: attempt.organizationId,
      role: "owner",
    },
    attempt.projectId,
    true,
  );
  if (
    project.archivedAt ||
    project.domain !== attempt.domain ||
    attempt.executionRevokedAtMs !== null
  )
    throw new AppError("FORBIDDEN", "project_changed");
  const user = await AuthRepository.getHostedUser(attempt.sponsorUserId);
  if (!user) throw new AppError("FORBIDDEN", "owner_required");
  const billingCustomer = {
    userId: user.id,
    userEmail: user.email,
    organizationId: attempt.organizationId,
    projectId: attempt.projectId,
  };
  const tier = await resolveAuditLimitTier(billingCustomer);
  const limits = AUDIT_LIMITS[tier];
  if (request.maxPages > limits.maxPagesPerAudit)
    throw new AppError("AUDIT_PAGE_LIMIT_EXCEEDED");
  const { policy, fingerprint } = await auditSchedulePolicy();
  if (!policy || fingerprint !== attempt.policyFingerprint)
    throw new AppError("FORBIDDEN", "budget_reapproval");
  if (
    !(await AuditBudgetRepository.reserve(
      attemptId,
      leaseToken,
      policy,
      Date.now(),
    ))
  )
    throw new AppError("CONFLICT", "capacity");
  const startUrl = await normalizeAndValidateStartUrl(request.startUrl);
  const credential = await CrawlerCredentialService.resolveCrawlerAccess(
    attempt.organizationId,
    attempt.projectId,
    new URL(startUrl).hostname,
  );
  const config: AuditConfig = {
    maxPages: request.maxPages,
    lighthouseStrategy: "none",
    renderJavaScript: false,
    crawlerCredentialId: credential?.id,
  };
  await AuditRepository.createAudit({
    isScheduled: true,
    id: attemptId,
    projectId: attempt.projectId,
    startedByUserId: user.id,
    startUrl,
    workflowInstanceId: attemptId,
    config,
    pagesTotal: request.maxPages,
    lighthouseTotal: 0,
  });
  if (
    attempt.launchState !== "running" &&
    !(await AuditScheduleRepository.attachAudit(
      attemptId,
      leaseToken,
      Date.now(),
    ))
  )
    throw new AppError("CONFLICT", "launch_fenced");
  const usage = await AuditRepository.getAuditUsageForOrganization(
    attempt.organizationId,
  );
  if (
    usage.runningCount > limits.maxRunningAudits ||
    usage.capacityUnits > limits.maxCapacityUnits
  )
    throw new AppError("AUDIT_CAPACITY_REACHED");
  const observation = await observeScheduledWorkflow(
    env.SITE_AUDIT_WORKFLOW,
    attemptId,
  );
  if (observation.state !== "missing")
    return { auditId: attemptId, observation };
  if (
    !(await AuditScheduleRepository.markRunning(
      attemptId,
      leaseToken,
      Date.now(),
    ))
  )
    throw new AppError("CONFLICT", "launch_fenced");
  if (
    !(await AuditScheduleRepository.renewLease(
      attemptId,
      leaseToken,
      Date.now(),
    )) ||
    !(await AuditScheduleRepository.executionAllowed(attemptId, Date.now()))
  )
    throw new AppError("CONFLICT", "launch_fenced");
  return {
    auditId: attemptId,
    observation: await createScheduledWorkflow(env.SITE_AUDIT_WORKFLOW, {
      id: attemptId,
      retention: { successRetention: "1 day", errorRetention: "1 day" },
      params: {
        auditId: attemptId,
        scheduledAttemptId: attemptId,
        billingCustomer,
        projectId: attempt.projectId,
        startUrl,
        config,
        access: credential?.sealed,
        renderLocks: [],
      },
    }),
  };
}
