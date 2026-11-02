CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"project_id" text NOT NULL,
	"event_type" text NOT NULL,
	"summary_json" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "audit_events_type_check" CHECK ("audit_events"."event_type" in ('attempt_skipped','audit_completed','audit_failed','schedule_blocked'))
);
--> statement-breakpoint
CREATE TABLE "audit_schedule_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"sponsor_user_id" text,
	"domain" text,
	"schedule_version" integer NOT NULL,
	"due_at_ms" bigint NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"request_json" text NOT NULL,
	"request_hash" text NOT NULL,
	"policy_fingerprint" text NOT NULL,
	"audit_id" text,
	"launch_state" text NOT NULL,
	"coverage_state" text DEFAULT 'unassessed' NOT NULL,
	"billing_state" text DEFAULT 'settled' NOT NULL,
	"lease_token" text,
	"lease_until_ms" bigint,
	"execution_revoked_at_ms" bigint,
	"launch_count" integer DEFAULT 0 NOT NULL,
	"retry_at_ms" bigint,
	"reason" text,
	"created_at_ms" bigint NOT NULL,
	"started_at_ms" bigint,
	"finished_at_ms" bigint,
	"reserved_day" text,
	"reserved_pages" integer DEFAULT 0 NOT NULL,
	"first_missed_at_ms" bigint NOT NULL,
	"last_missed_at_ms" bigint NOT NULL,
	"missed_count" integer,
	"original_organization_id" text NOT NULL,
	"result_deleted" boolean DEFAULT false NOT NULL,
	"workflow_observed_at_ms" bigint,
	"reservation_token" text,
	"completion_token" text,
	CONSTRAINT "audit_attempt_state_check" CHECK ("audit_schedule_attempts"."launch_state" in ('pending','launching','running','completed','failed','skipped','cancelled') and "audit_schedule_attempts"."coverage_state" in ('unassessed','partial','complete') and "audit_schedule_attempts"."billing_state" in ('reserved','settled','release_pending','unknown')),
	CONSTRAINT "audit_attempt_lease_check" CHECK (("audit_schedule_attempts"."lease_token" is null and "audit_schedule_attempts"."lease_until_ms" is null) or ("audit_schedule_attempts"."lease_token" is not null and "audit_schedule_attempts"."lease_until_ms" is not null)),
	CONSTRAINT "audit_attempt_limits_check" CHECK ("audit_schedule_attempts"."schedule_version" > 0 and "audit_schedule_attempts"."due_at_ms" >= 0 and "audit_schedule_attempts"."expires_at_ms" > "audit_schedule_attempts"."due_at_ms" and "audit_schedule_attempts"."launch_count" >= 0 and "audit_schedule_attempts"."reserved_pages" >= 0 and ("audit_schedule_attempts"."missed_count" is null or "audit_schedule_attempts"."missed_count" > 0))
);
--> statement-breakpoint
CREATE TABLE "audit_schedule_daily_usage" (
	"organization_id" text NOT NULL,
	"utc_day" text NOT NULL,
	"reserved_runs" integer DEFAULT 0 NOT NULL,
	"consumed_runs" integer DEFAULT 0 NOT NULL,
	"reserved_pages" integer DEFAULT 0 NOT NULL,
	"consumed_pages" integer DEFAULT 0 NOT NULL,
	"reserved_cost_micros" bigint DEFAULT 0 NOT NULL,
	"consumed_cost_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "audit_schedule_daily_usage_organization_id_utc_day_pk" PRIMARY KEY("organization_id","utc_day"),
	CONSTRAINT "audit_daily_nonnegative_check" CHECK ("audit_schedule_daily_usage"."reserved_runs" >= 0 and "audit_schedule_daily_usage"."consumed_runs" >= 0 and "audit_schedule_daily_usage"."reserved_pages" >= 0 and "audit_schedule_daily_usage"."consumed_pages" >= 0 and "audit_schedule_daily_usage"."reserved_cost_micros" >= 0 and "audit_schedule_daily_usage"."consumed_cost_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_schedules" (
	"project_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sponsor_user_id" text,
	"domain" text,
	"version" integer NOT NULL,
	"state" text NOT NULL,
	"start_url" text NOT NULL,
	"cadence" text NOT NULL,
	"time_zone" text NOT NULL,
	"hour" integer NOT NULL,
	"minute" integer NOT NULL,
	"weekday" integer,
	"max_pages" integer NOT NULL,
	"render_javascript" boolean NOT NULL,
	"lighthouse_strategy" text NOT NULL,
	"max_cost_micros_per_run" bigint NOT NULL,
	"max_cost_micros_per_utc_day" bigint NOT NULL,
	"max_pages_per_utc_day" integer NOT NULL,
	"max_runs_per_utc_day" integer NOT NULL,
	"estimate_fingerprint" text NOT NULL,
	"policy_fingerprint" text NOT NULL,
	"next_due_at_ms" bigint,
	"blocked_reason" text,
	"updated_at_ms" bigint NOT NULL,
	"mutation_token" text NOT NULL,
	CONSTRAINT "audit_schedules_state_check" CHECK ("audit_schedules"."state" in ('paused','enabled') and ("audit_schedules"."state" <> 'paused' or "audit_schedules"."next_due_at_ms" is null)),
	CONSTRAINT "audit_schedules_calendar_check" CHECK ("audit_schedules"."cadence" in ('daily','weekly') and "audit_schedules"."hour" between 0 and 23 and "audit_schedules"."minute" between 0 and 59 and ("audit_schedules"."weekday" is null or "audit_schedules"."weekday" between 0 and 6) and ("audit_schedules"."cadence" <> 'weekly' or "audit_schedules"."weekday" is not null)),
	CONSTRAINT "audit_schedules_limits_check" CHECK ("audit_schedules"."version" > 0 and "audit_schedules"."max_pages" between 10 and 10000 and "audit_schedules"."max_cost_micros_per_run" >= 0 and "audit_schedules"."max_cost_micros_per_utc_day" >= 0 and "audit_schedules"."max_pages_per_utc_day" >= 10 and "audit_schedules"."max_runs_per_utc_day" > 0 and "audit_schedules"."updated_at_ms" >= 0),
	CONSTRAINT "audit_schedules_lighthouse_check" CHECK ("audit_schedules"."lighthouse_strategy" in ('none','auto'))
);
--> statement-breakpoint
CREATE TABLE "audit_run_evidence" (
	"audit_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"manifest_json" text NOT NULL,
	"artifact_key" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"coverage_state" text NOT NULL,
	"observed_start_at_ms" bigint,
	"observed_end_at_ms" bigint,
	"finalized_at_ms" bigint NOT NULL,
	"seal_token" text NOT NULL,
	CONSTRAINT "audit_evidence_state_check" CHECK ("audit_run_evidence"."coverage_state" in ('unassessed','partial','complete')),
	CONSTRAINT "audit_evidence_hash_check" CHECK (length("audit_run_evidence"."artifact_sha256") = 64 and "audit_run_evidence"."finalized_at_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "fetched_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "content_assessed" boolean;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "is_html" boolean;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "is_likely_js_shell" boolean;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "rendering_mode" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "is_scheduled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "requested_start_url" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "requested_config" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "evidence_seal_token" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "evidence_seal_started_at_ms" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "audits_project_id_id_uidx" ON "audits" USING btree ("project_id","id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_attempt_id_audit_schedule_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."audit_schedule_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_attempts" ADD CONSTRAINT "audit_schedule_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_attempts" ADD CONSTRAINT "audit_schedule_attempts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_attempts" ADD CONSTRAINT "audit_schedule_attempts_sponsor_user_id_user_id_fk" FOREIGN KEY ("sponsor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_attempts" ADD CONSTRAINT "audit_schedule_attempts_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_attempts" ADD CONSTRAINT "audit_attempt_project_audit_fk" FOREIGN KEY ("project_id","audit_id") REFERENCES "public"."audits"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_daily_usage" ADD CONSTRAINT "audit_schedule_daily_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedules" ADD CONSTRAINT "audit_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedules" ADD CONSTRAINT "audit_schedules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedules" ADD CONSTRAINT "audit_schedules_sponsor_user_id_user_id_fk" FOREIGN KEY ("sponsor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_run_evidence" ADD CONSTRAINT "audit_run_evidence_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_run_evidence" ADD CONSTRAINT "audit_run_evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_run_evidence" ADD CONSTRAINT "audit_evidence_project_audit_fk" FOREIGN KEY ("project_id","audit_id") REFERENCES "public"."audits"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_attempt_type_uidx" ON "audit_events" USING btree ("attempt_id","event_type");--> statement-breakpoint
CREATE INDEX "audit_events_project_idx" ON "audit_events" USING btree ("project_id","created_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_attempt_slot_uidx" ON "audit_schedule_attempts" USING btree ("project_id","schedule_version","due_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_attempt_active_project_uidx" ON "audit_schedule_attempts" USING btree ("project_id") WHERE "audit_schedule_attempts"."launch_state" in ('pending','launching','running');--> statement-breakpoint
CREATE INDEX "audit_attempt_recovery_idx" ON "audit_schedule_attempts" USING btree ("launch_state","retry_at_ms","lease_until_ms");--> statement-breakpoint
CREATE INDEX "audit_attempt_history_idx" ON "audit_schedule_attempts" USING btree ("project_id","created_at_ms","id");--> statement-breakpoint
CREATE INDEX "audit_schedules_due_idx" ON "audit_schedules" USING btree ("state","next_due_at_ms");--> statement-breakpoint
CREATE INDEX "audit_evidence_project_time_idx" ON "audit_run_evidence" USING btree ("project_id","finalized_at_ms");--> statement-breakpoint
