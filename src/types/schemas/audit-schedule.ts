import { z } from "zod";
import { auditCalendarSchema } from "@/shared/audit-schedule";
import { MIN_AUDIT_PAGES, PAID_MAX_AUDIT_PAGES } from "@/shared/audit-limits";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(200);
export const auditScheduleProjectSchema = z.strictObject({ projectId: id });
export const auditScheduleBlockedReasonSchema = z.enum([
  "recurring_policy_not_configured",
  "paid_recurrence_unavailable",
  "owner_required",
  "project_archived",
  "project_changed",
  "organization_changed",
  "budget_reapproval",
  "capacity",
  "unsupported_background_authority",
  "page_limit",
]);
export type AuditScheduleBlockedReason = z.infer<
  typeof auditScheduleBlockedReasonSchema
>;
const settings = {
  projectId: id,
  state: z.enum(["paused", "enabled"]),
  startUrl: z.string().min(1).max(2048),
  maxPages: z.number().int().min(MIN_AUDIT_PAGES).max(PAID_MAX_AUDIT_PAGES),
  renderJavaScript: z.boolean(),
  lighthouseStrategy: z.enum(["none", "auto"]),
  maxCostMicrosPerRun: count,
  maxCostMicrosPerUtcDay: count,
  maxPagesPerUtcDay: count.min(MIN_AUDIT_PAGES),
  maxRunsPerUtcDay: count.min(1),
};
// Extend the actual calendar validator so wire and scheduling rules cannot drift.
export const auditScheduleEstimateInputSchema = z.discriminatedUnion(
  "cadence",
  [
    auditCalendarSchema.options[0].extend(settings),
    auditCalendarSchema.options[1].extend(settings),
  ],
);
const revision = {
  expectedVersion: count,
  estimateFingerprint: z.string().length(64),
};
export const auditScheduleSaveInputSchema = z.discriminatedUnion("cadence", [
  auditScheduleEstimateInputSchema.options[0].extend(revision),
  auditScheduleEstimateInputSchema.options[1].extend(revision),
]);
export type AuditScheduleEstimateInput = z.infer<
  typeof auditScheduleEstimateInputSchema
>;
export type AuditScheduleInput = z.infer<typeof auditScheduleSaveInputSchema>;
export const auditScheduleEstimateSchema = z.strictObject({
  estimateFingerprint: z.string().length(64),
  nextOccurrences: z.array(count).length(3),
  maxPagesPerRun: count,
  pageLimitPerRun: count,
  maxRunsPerUtcDay: count,
  maxPagesPerUtcDay: count,
  maxConcurrentRuns: count,
  maxCostMicrosPerRun: count,
  maxCostMicrosPerUtcDay: count,
  paidRecurrenceAvailable: z.literal(false),
  blockedReasons: z.array(auditScheduleBlockedReasonSchema),
});
export type AuditScheduleEstimate = z.infer<typeof auditScheduleEstimateSchema>;
export const auditScheduleViewSchema = z.strictObject({
  projectId: id,
  version: count,
  settings: auditScheduleEstimateInputSchema,
  state: z.enum(["paused", "enabled", "blocked"]),
  blockedReasons: z.array(auditScheduleBlockedReasonSchema),
  nextDueAtMs: count.nullable(),
  updatedAtMs: count,
});
const auditScheduleUsageSchema = z.strictObject({
  utcDay: z.string(),
  observedAtMs: count,
  reservedRuns: count,
  consumedRuns: count,
  reservedPages: count,
  consumedPages: count,
  reservedCostMicros: count,
  consumedCostMicros: count,
  outstandingRuns: count,
  unknownRuns: count,
  pageAccounting: z.literal(
    "admission_units_including_conservative_upper_bounds",
  ),
});
export const auditScheduleGetResultSchema = z.strictObject({
  pageLimitPerRun: count,
  schedule: auditScheduleViewSchema.nullable(),
  usage: auditScheduleUsageSchema,
  canManage: z.boolean(),
  backgroundAuthoritySupported: z.boolean(),
  paidRecurrenceAvailable: z.literal(false),
});
export type AuditScheduleGetResult = z.infer<
  typeof auditScheduleGetResultSchema
>;
export const auditAttemptSchema = z.strictObject({
  id,
  projectId: id,
  scheduleVersion: count,
  dueAtMs: count,
  auditId: id.nullable(),
  launchState: z.enum([
    "pending",
    "launching",
    "running",
    "completed",
    "failed",
    "skipped",
    "cancelled",
  ]),
  coverageState: z.enum(["unassessed", "partial", "complete"]),
  billingState: z.enum(["reserved", "settled", "release_pending", "unknown"]),
  reason: z.string().nullable(),
  createdAtMs: count,
  startedAtMs: count.nullable(),
  finishedAtMs: count.nullable(),
  retryAtMs: count.nullable(),
  firstMissedAtMs: count,
  lastMissedAtMs: count,
  missedCount: count.nullable(),
  resultDeleted: z.boolean(),
});
export const auditAttemptListInputSchema = auditScheduleProjectSchema.extend({
  cursor: id.optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const auditAttemptListResultSchema = z.strictObject({
  attempts: z.array(auditAttemptSchema),
  nextCursor: id.nullable(),
});
export type AuditAttemptListInput = z.input<typeof auditAttemptListInputSchema>;
export type AuditAttemptListResult = z.infer<
  typeof auditAttemptListResultSchema
>;
