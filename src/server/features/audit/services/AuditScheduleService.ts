import { AuditBudgetRepository } from "../repositories/AuditBudgetRepository";
import {
  nextAuditOccurrences,
  auditCalendarSchema,
} from "@/shared/audit-schedule";
import { AUDIT_LIMITS } from "./audit-capacity";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { sha256Hex } from "@/server/lib/audit/ids";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import { AppError } from "@/server/lib/errors";
import {
  auditScheduleProjectSchema,
  auditScheduleEstimateInputSchema,
  auditScheduleSaveInputSchema,
  auditAttemptListInputSchema,
  auditAttemptSchema,
  type AuditScheduleInput,
  type AuditScheduleEstimateInput,
  type AuditScheduleEstimate,
  type AuditScheduleGetResult,
  type AuditScheduleBlockedReason,
  type AuditAttemptListInput,
  type AuditAttemptListResult,
} from "@/types/schemas/audit-schedule";
import {
  AuditScheduleRepository,
  scheduleSettings,
} from "../repositories/AuditScheduleRepository";
import {
  auditScheduleAccess,
  type AuditScheduleActor,
} from "./auditScheduleAccess";
import { auditSchedulePolicy } from "./auditSchedulePolicy";

function normalizedInput(value: AuditScheduleEstimateInput) {
  const input = auditScheduleEstimateInputSchema.parse(value);
  let target: URL;
  try {
    target = new URL(
      /^https?:\/\//.test(input.startUrl.trim())
        ? input.startUrl.trim()
        : `https://${input.startUrl.trim()}`,
    );
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid audit URL");
  }
  if (!isCrawlableUrl(target.href) || target.username || target.password)
    throw new AppError("CRAWL_TARGET_BLOCKED");
  target.hash = "";
  return { ...input, startUrl: target.href };
}
async function reviewPageLimit(organizationId: string) {
  if (!(await isHostedServerAuthMode()))
    return AUDIT_LIMITS.self_hosted.maxPagesPerAudit;
  // Review uses the local projection without network; dispatch still checks live entitlement.
  const billing =
    await AuditScheduleRepository.getBillingStatus(organizationId);
  return AUDIT_LIMITS[
    billing?.isPaying && billing.paidPlanStatus === "active" ? "paid" : "free"
  ].maxPagesPerAudit;
}
async function estimateDetails(
  actor: AuditScheduleActor,
  value: AuditScheduleEstimateInput,
) {
  const input = normalizedInput(value);
  const access = await auditScheduleAccess(actor, input.projectId);
  const { policy, fingerprint: policyFingerprint } =
    await auditSchedulePolicy();
  const pageLimit = await reviewPageLimit(access.scope.organizationId);
  const blockedReasons: AuditScheduleBlockedReason[] = [];
  if (input.maxPages > pageLimit) blockedReasons.push("page_limit");
  if (!access.canManage) blockedReasons.push("owner_required");
  if (!access.backgroundAuthoritySupported)
    blockedReasons.push("unsupported_background_authority");
  if (access.project.archivedAt) blockedReasons.push("project_archived");
  if (!policy) blockedReasons.push("recurring_policy_not_configured");
  if (
    input.renderJavaScript ||
    input.lighthouseStrategy !== "none" ||
    input.maxCostMicrosPerRun !== 0 ||
    input.maxCostMicrosPerUtcDay !== 0
  )
    blockedReasons.push("paid_recurrence_unavailable");
  if (
    input.maxPages > input.maxPagesPerUtcDay ||
    (policy &&
      (input.maxPages > policy.maxPagesPerUtcDay ||
        input.maxPagesPerUtcDay > policy.maxPagesPerUtcDay ||
        input.maxRunsPerUtcDay > policy.maxRunsPerUtcDay))
  )
    blockedReasons.push("budget_reapproval");
  const { state: _state, ...configuration } = input;
  const estimateFingerprint = await sha256Hex(
    JSON.stringify({
      configuration,
      organizationId: access.scope.organizationId,
      sponsorUserId: access.scope.userId,
      domain: access.project.domain,
      policyFingerprint,
      pageLimit,
    }),
  );
  const estimate: AuditScheduleEstimate = {
    estimateFingerprint,
    nextOccurrences: nextAuditOccurrences(
      auditCalendarSchema.parse({
        cadence: input.cadence,
        timeZone: input.timeZone,
        hour: input.hour,
        minute: input.minute,
        ...(input.cadence === "weekly" ? { weekday: input.weekday } : {}),
      }),
      Date.now(),
    ),
    maxPagesPerRun: Math.min(input.maxPages, pageLimit),
    pageLimitPerRun: pageLimit,
    maxRunsPerUtcDay: Math.min(
      input.maxRunsPerUtcDay,
      policy?.maxRunsPerUtcDay ?? 0,
    ),
    maxPagesPerUtcDay: Math.min(
      input.maxPagesPerUtcDay,
      policy?.maxPagesPerUtcDay ?? 0,
    ),
    maxConcurrentRuns: policy?.maxConcurrentRuns ?? 0,
    maxCostMicrosPerRun: 0,
    maxCostMicrosPerUtcDay: 0,
    paidRecurrenceAvailable: false,
    blockedReasons,
  };
  return { access, input, policyFingerprint, estimate };
}
async function get(
  actor: AuditScheduleActor,
  value: { projectId: string },
): Promise<AuditScheduleGetResult> {
  const { projectId } = auditScheduleProjectSchema.parse(value);
  const access = await auditScheduleAccess(actor, projectId);
  const row = await AuditScheduleRepository.get(access.scope, projectId);
  let schedule: AuditScheduleGetResult["schedule"] = null;
  let pageLimitPerRun: number;
  if (row) {
    const settings = scheduleSettings(row);
    const { estimate, policyFingerprint } = await estimateDetails(
      actor,
      settings,
    );
    pageLimitPerRun = estimate.pageLimitPerRun;
    // Reader need not be owner: sponsor authority, not viewer role, controls the schedule.
    const blockedReasons: AuditScheduleBlockedReason[] =
      estimate.blockedReasons.filter((reason) => reason !== "owner_required");
    if (
      row.blockedReason === "project_changed" ||
      row.blockedReason === "project_archived" ||
      row.blockedReason === "organization_changed"
    )
      blockedReasons.push(row.blockedReason);
    if (row.domain !== access.project.domain)
      blockedReasons.push("project_changed");
    if (row.policyFingerprint !== policyFingerprint)
      blockedReasons.push("budget_reapproval");
    if (!(await AuditScheduleRepository.sponsorActive(row)))
      blockedReasons.push("owner_required");
    schedule = {
      projectId,
      version: row.version,
      settings,
      state:
        row.state === "enabled" && blockedReasons.length
          ? "blocked"
          : row.state,
      blockedReasons: [...new Set(blockedReasons)],
      nextDueAtMs: row.nextDueAtMs,
      updatedAtMs: row.updatedAtMs,
    };
  } else pageLimitPerRun = await reviewPageLimit(access.scope.organizationId);
  const observedAtMs = Date.now();
  const utcDay = new Date(observedAtMs).toISOString().slice(0, 10);
  const [ledger, outstanding] = await Promise.all([
    AuditBudgetRepository.getUsage(access.scope.organizationId, utcDay),
    AuditBudgetRepository.outstandingUsage(access.scope.organizationId),
  ]);
  return {
    pageLimitPerRun,
    usage: {
      utcDay,
      observedAtMs,
      reservedRuns: ledger?.reservedRuns ?? 0,
      consumedRuns: ledger?.consumedRuns ?? 0,
      reservedPages: ledger?.reservedPages ?? 0,
      consumedPages: ledger?.consumedPages ?? 0,
      reservedCostMicros: ledger?.reservedCostMicros ?? 0,
      consumedCostMicros: ledger?.consumedCostMicros ?? 0,
      ...outstanding,
      pageAccounting: "admission_units_including_conservative_upper_bounds",
    },
    schedule,
    canManage: access.canManage,
    backgroundAuthoritySupported: access.backgroundAuthoritySupported,
    paidRecurrenceAvailable: false,
  };
}
async function estimateSchedule(
  actor: AuditScheduleActor,
  input: AuditScheduleEstimateInput,
) {
  return (await estimateDetails(actor, input)).estimate;
}
async function save(
  actor: AuditScheduleActor,
  value: AuditScheduleInput,
): Promise<AuditScheduleGetResult> {
  const parsed = auditScheduleSaveInputSchema.parse(value);
  const { expectedVersion, estimateFingerprint, ...settings } = parsed;
  const details = await estimateDetails(actor, settings);
  await auditScheduleAccess(actor, parsed.projectId, true);
  if (details.access.project.archivedAt)
    throw new AppError("CONFLICT", "project_archived");
  if (details.estimate.blockedReasons.includes("paid_recurrence_unavailable"))
    throw new AppError("VALIDATION_ERROR", "paid_recurrence_unavailable");
  if (expectedVersion === 0 && parsed.state !== "paused")
    throw new AppError("CONFLICT", "Save a paused schedule before enabling it");
  if (parsed.state === "enabled" && details.estimate.blockedReasons.length)
    throw new AppError("CONFLICT", details.estimate.blockedReasons.join(","));
  if (details.estimate.estimateFingerprint !== estimateFingerprint)
    throw new AppError("CONFLICT", "budget_reapproval");
  const saved = await AuditScheduleRepository.save(
    details.access.scope,
    { ...details.input, expectedVersion, estimateFingerprint },
    {
      fingerprint: estimateFingerprint,
      policyFingerprint: details.policyFingerprint,
      domain: details.access.project.domain,
      nextDueAtMs:
        parsed.state === "enabled" ? details.estimate.nextOccurrences[0] : null,
      nowMs: Date.now(),
    },
  );
  if (!saved)
    throw new AppError("CONFLICT", "Schedule version or authority changed");
  return get(actor, { projectId: parsed.projectId });
}
async function listAttempts(
  actor: AuditScheduleActor,
  value: AuditAttemptListInput,
): Promise<AuditAttemptListResult> {
  const input = auditAttemptListInputSchema.parse(value);
  const { scope } = await auditScheduleAccess(actor, input.projectId);
  const rows = await AuditScheduleRepository.listAttempts(
    scope,
    input.projectId,
    input.limit,
    input.cursor,
  );
  return {
    attempts: rows.slice(0, input.limit).map((row) =>
      auditAttemptSchema.parse({
        id: row.id,
        projectId: row.projectId,
        scheduleVersion: row.scheduleVersion,
        dueAtMs: row.dueAtMs,
        auditId: row.auditId,
        launchState: row.launchState,
        coverageState: row.coverageState,
        billingState: row.billingState,
        reason: row.reason,
        createdAtMs: row.createdAtMs,
        startedAtMs: row.startedAtMs,
        finishedAtMs: row.finishedAtMs,
        retryAtMs: ["completed", "failed", "skipped", "cancelled"].includes(
          row.launchState,
        )
          ? null
          : row.retryAtMs,
        firstMissedAtMs: row.firstMissedAtMs,
        lastMissedAtMs: row.lastMissedAtMs,
        missedCount: row.missedCount,
        resultDeleted: row.resultDeleted,
      }),
    ),
    nextCursor: rows.length > input.limit ? rows[input.limit - 1].id : null,
  };
}
export const AuditScheduleService = {
  get,
  estimate: estimateSchedule,
  save,
  listAttempts,
};
