import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  foreignKey,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization, user } from "./better-auth-schema";
import { audits } from "./audit.schema";

export const auditSchedules = sqliteTable(
  "audit_schedules",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sponsorUserId: text("sponsor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    domain: text("domain"),
    version: integer("version").notNull(),
    state: text("state", { enum: ["paused", "enabled"] }).notNull(),
    startUrl: text("start_url").notNull(),
    cadence: text("cadence", { enum: ["daily", "weekly"] }).notNull(),
    timeZone: text("time_zone").notNull(),
    hour: integer("hour").notNull(),
    minute: integer("minute").notNull(),
    weekday: integer("weekday"),
    maxPages: integer("max_pages").notNull(),
    renderJavaScript: integer("render_javascript", {
      mode: "boolean",
    }).notNull(),
    lighthouseStrategy: text("lighthouse_strategy", {
      enum: ["none", "auto"],
    }).notNull(),
    maxCostMicrosPerRun: integer("max_cost_micros_per_run").notNull(),
    maxCostMicrosPerUtcDay: integer("max_cost_micros_per_utc_day").notNull(),
    maxPagesPerUtcDay: integer("max_pages_per_utc_day").notNull(),
    maxRunsPerUtcDay: integer("max_runs_per_utc_day").notNull(),
    estimateFingerprint: text("estimate_fingerprint").notNull(),
    policyFingerprint: text("policy_fingerprint").notNull(),
    nextDueAtMs: integer("next_due_at_ms"),
    blockedReason: text("blocked_reason"),
    updatedAtMs: integer("updated_at_ms").notNull(),
    mutationToken: text("mutation_token").notNull(),
  },
  (t) => [
    index("audit_schedules_due_idx").on(t.state, t.nextDueAtMs),
    check(
      "audit_schedules_state_check",
      sql`${t.state} in ('paused','enabled') and (${t.state} <> 'paused' or ${t.nextDueAtMs} is null)`,
    ),
    check(
      "audit_schedules_calendar_check",
      sql`${t.cadence} in ('daily','weekly') and ${t.hour} between 0 and 23 and ${t.minute} between 0 and 59 and (${t.weekday} is null or ${t.weekday} between 0 and 6) and (${t.cadence} <> 'weekly' or ${t.weekday} is not null)`,
    ),
    check(
      "audit_schedules_limits_check",
      sql`${t.version} > 0 and ${t.maxPages} between 10 and 10000 and ${t.maxCostMicrosPerRun} >= 0 and ${t.maxCostMicrosPerUtcDay} >= 0 and ${t.maxPagesPerUtcDay} >= 10 and ${t.maxRunsPerUtcDay} > 0 and ${t.updatedAtMs} >= 0`,
    ),
    check(
      "audit_schedules_lighthouse_check",
      sql`${t.lighthouseStrategy} in ('none','auto')`,
    ),
  ],
);

export const auditScheduleAttempts = sqliteTable(
  "audit_schedule_attempts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sponsorUserId: text("sponsor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    domain: text("domain"),
    scheduleVersion: integer("schedule_version").notNull(),
    dueAtMs: integer("due_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    requestJson: text("request_json").notNull(),
    requestHash: text("request_hash").notNull(),
    policyFingerprint: text("policy_fingerprint").notNull(),
    auditId: text("audit_id").references(() => audits.id, {
      onDelete: "set null",
    }),
    launchState: text("launch_state", {
      enum: [
        "pending",
        "launching",
        "running",
        "completed",
        "failed",
        "skipped",
        "cancelled",
      ],
    }).notNull(),
    coverageState: text("coverage_state", {
      enum: ["unassessed", "partial", "complete"],
    })
      .notNull()
      .default("unassessed"),
    billingState: text("billing_state", {
      enum: ["reserved", "settled", "release_pending", "unknown"],
    })
      .notNull()
      .default("settled"),
    leaseToken: text("lease_token"),
    leaseUntilMs: integer("lease_until_ms"),
    executionRevokedAtMs: integer("execution_revoked_at_ms"),
    launchCount: integer("launch_count").notNull().default(0),
    retryAtMs: integer("retry_at_ms"),
    reason: text("reason"),
    createdAtMs: integer("created_at_ms").notNull(),
    startedAtMs: integer("started_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
    reservedDay: text("reserved_day"),
    reservedPages: integer("reserved_pages").notNull().default(0),
    firstMissedAtMs: integer("first_missed_at_ms").notNull(),
    lastMissedAtMs: integer("last_missed_at_ms").notNull(),
    missedCount: integer("missed_count"),
    // Immutable historical identity survives deletion of the original organization.
    originalOrganizationId: text("original_organization_id").notNull(),
    resultDeleted: integer("result_deleted", { mode: "boolean" })
      .notNull()
      .default(false),
    workflowObservedAtMs: integer("workflow_observed_at_ms"),
    reservationToken: text("reservation_token"),
    completionToken: text("completion_token"),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.auditId],
      foreignColumns: [audits.projectId, audits.id],
      name: "audit_attempt_project_audit_fk",
    }).onDelete("no action"),
    uniqueIndex("audit_attempt_slot_uidx").on(
      t.projectId,
      t.scheduleVersion,
      t.dueAtMs,
    ),
    uniqueIndex("audit_attempt_active_project_uidx")
      .on(t.projectId)
      .where(sql`${t.launchState} in ('pending','launching','running')`),
    index("audit_attempt_recovery_idx").on(
      t.launchState,
      t.retryAtMs,
      t.leaseUntilMs,
    ),
    index("audit_attempt_history_idx").on(t.projectId, t.createdAtMs, t.id),
    check(
      "audit_attempt_state_check",
      sql`${t.launchState} in ('pending','launching','running','completed','failed','skipped','cancelled') and ${t.coverageState} in ('unassessed','partial','complete') and ${t.billingState} in ('reserved','settled','release_pending','unknown')`,
    ),
    check(
      "audit_attempt_lease_check",
      sql`(${t.leaseToken} is null and ${t.leaseUntilMs} is null) or (${t.leaseToken} is not null and ${t.leaseUntilMs} is not null)`,
    ),
    check(
      "audit_attempt_limits_check",
      sql`${t.scheduleVersion} > 0 and ${t.dueAtMs} >= 0 and ${t.expiresAtMs} > ${t.dueAtMs} and ${t.launchCount} >= 0 and ${t.reservedPages} >= 0 and (${t.missedCount} is null or ${t.missedCount} > 0)`,
    ),
  ],
);

export const auditScheduleDailyUsage = sqliteTable(
  "audit_schedule_daily_usage",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    utcDay: text("utc_day").notNull(),
    reservedRuns: integer("reserved_runs").notNull().default(0),
    consumedRuns: integer("consumed_runs").notNull().default(0),
    reservedPages: integer("reserved_pages").notNull().default(0),
    consumedPages: integer("consumed_pages").notNull().default(0),
    reservedCostMicros: integer("reserved_cost_micros").notNull().default(0),
    consumedCostMicros: integer("consumed_cost_micros").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.utcDay] }),
    check(
      "audit_daily_nonnegative_check",
      sql`${t.reservedRuns} >= 0 and ${t.consumedRuns} >= 0 and ${t.reservedPages} >= 0 and ${t.consumedPages} >= 0 and ${t.reservedCostMicros} >= 0 and ${t.consumedCostMicros} >= 0`,
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => auditScheduleAttempts.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventType: text("event_type", {
      enum: [
        "attempt_skipped",
        "audit_completed",
        "audit_failed",
        "schedule_blocked",
      ],
    }).notNull(),
    summaryJson: text("summary_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    uniqueIndex("audit_events_attempt_type_uidx").on(t.attemptId, t.eventType),
    index("audit_events_project_idx").on(t.projectId, t.createdAtMs),
    check(
      "audit_events_type_check",
      sql`${t.eventType} in ('attempt_skipped','audit_completed','audit_failed','schedule_blocked')`,
    ),
  ],
);
