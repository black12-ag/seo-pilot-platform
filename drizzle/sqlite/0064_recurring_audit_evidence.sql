CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_type` text NOT NULL,
	`summary_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `audit_schedule_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "audit_events_type_check" CHECK("audit_events"."event_type" in ('attempt_skipped','audit_completed','audit_failed','schedule_blocked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_attempt_type_uidx` ON `audit_events` (`attempt_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `audit_events_project_idx` ON `audit_events` (`project_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `audit_schedule_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`sponsor_user_id` text,
	`domain` text,
	`schedule_version` integer NOT NULL,
	`due_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`request_json` text NOT NULL,
	`request_hash` text NOT NULL,
	`policy_fingerprint` text NOT NULL,
	`audit_id` text,
	`launch_state` text NOT NULL,
	`coverage_state` text DEFAULT 'unassessed' NOT NULL,
	`billing_state` text DEFAULT 'settled' NOT NULL,
	`lease_token` text,
	`lease_until_ms` integer,
	`execution_revoked_at_ms` integer,
	`launch_count` integer DEFAULT 0 NOT NULL,
	`retry_at_ms` integer,
	`reason` text,
	`created_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`finished_at_ms` integer,
	`reserved_day` text,
	`reserved_pages` integer DEFAULT 0 NOT NULL,
	`first_missed_at_ms` integer NOT NULL,
	`last_missed_at_ms` integer NOT NULL,
	`missed_count` integer,
	`original_organization_id` text NOT NULL,
	`result_deleted` integer DEFAULT false NOT NULL,
	`workflow_observed_at_ms` integer,
	`reservation_token` text,
	`completion_token` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sponsor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`audit_id`) REFERENCES `audits`(`project_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_attempt_state_check" CHECK("audit_schedule_attempts"."launch_state" in ('pending','launching','running','completed','failed','skipped','cancelled') and "audit_schedule_attempts"."coverage_state" in ('unassessed','partial','complete') and "audit_schedule_attempts"."billing_state" in ('reserved','settled','release_pending','unknown')),
	CONSTRAINT "audit_attempt_lease_check" CHECK(("audit_schedule_attempts"."lease_token" is null and "audit_schedule_attempts"."lease_until_ms" is null) or ("audit_schedule_attempts"."lease_token" is not null and "audit_schedule_attempts"."lease_until_ms" is not null)),
	CONSTRAINT "audit_attempt_limits_check" CHECK("audit_schedule_attempts"."schedule_version" > 0 and "audit_schedule_attempts"."due_at_ms" >= 0 and "audit_schedule_attempts"."expires_at_ms" > "audit_schedule_attempts"."due_at_ms" and "audit_schedule_attempts"."launch_count" >= 0 and "audit_schedule_attempts"."reserved_pages" >= 0 and ("audit_schedule_attempts"."missed_count" is null or "audit_schedule_attempts"."missed_count" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_attempt_slot_uidx` ON `audit_schedule_attempts` (`project_id`,`schedule_version`,`due_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_attempt_active_project_uidx` ON `audit_schedule_attempts` (`project_id`) WHERE "audit_schedule_attempts"."launch_state" in ('pending','launching','running');--> statement-breakpoint
CREATE INDEX `audit_attempt_recovery_idx` ON `audit_schedule_attempts` (`launch_state`,`retry_at_ms`,`lease_until_ms`);--> statement-breakpoint
CREATE INDEX `audit_attempt_history_idx` ON `audit_schedule_attempts` (`project_id`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE TABLE `audit_schedule_daily_usage` (
	`organization_id` text NOT NULL,
	`utc_day` text NOT NULL,
	`reserved_runs` integer DEFAULT 0 NOT NULL,
	`consumed_runs` integer DEFAULT 0 NOT NULL,
	`reserved_pages` integer DEFAULT 0 NOT NULL,
	`consumed_pages` integer DEFAULT 0 NOT NULL,
	`reserved_cost_micros` integer DEFAULT 0 NOT NULL,
	`consumed_cost_micros` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`organization_id`, `utc_day`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "audit_daily_nonnegative_check" CHECK("audit_schedule_daily_usage"."reserved_runs" >= 0 and "audit_schedule_daily_usage"."consumed_runs" >= 0 and "audit_schedule_daily_usage"."reserved_pages" >= 0 and "audit_schedule_daily_usage"."consumed_pages" >= 0 and "audit_schedule_daily_usage"."reserved_cost_micros" >= 0 and "audit_schedule_daily_usage"."consumed_cost_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE `audit_schedules` (
	`project_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`sponsor_user_id` text,
	`domain` text,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`start_url` text NOT NULL,
	`cadence` text NOT NULL,
	`time_zone` text NOT NULL,
	`hour` integer NOT NULL,
	`minute` integer NOT NULL,
	`weekday` integer,
	`max_pages` integer NOT NULL,
	`render_javascript` integer NOT NULL,
	`lighthouse_strategy` text NOT NULL,
	`max_cost_micros_per_run` integer NOT NULL,
	`max_cost_micros_per_utc_day` integer NOT NULL,
	`max_pages_per_utc_day` integer NOT NULL,
	`max_runs_per_utc_day` integer NOT NULL,
	`estimate_fingerprint` text NOT NULL,
	`policy_fingerprint` text NOT NULL,
	`next_due_at_ms` integer,
	`blocked_reason` text,
	`updated_at_ms` integer NOT NULL,
	`mutation_token` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sponsor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_schedules_state_check" CHECK("audit_schedules"."state" in ('paused','enabled') and ("audit_schedules"."state" <> 'paused' or "audit_schedules"."next_due_at_ms" is null)),
	CONSTRAINT "audit_schedules_calendar_check" CHECK("audit_schedules"."cadence" in ('daily','weekly') and "audit_schedules"."hour" between 0 and 23 and "audit_schedules"."minute" between 0 and 59 and ("audit_schedules"."weekday" is null or "audit_schedules"."weekday" between 0 and 6) and ("audit_schedules"."cadence" <> 'weekly' or "audit_schedules"."weekday" is not null)),
	CONSTRAINT "audit_schedules_limits_check" CHECK("audit_schedules"."version" > 0 and "audit_schedules"."max_pages" between 10 and 10000 and "audit_schedules"."max_cost_micros_per_run" >= 0 and "audit_schedules"."max_cost_micros_per_utc_day" >= 0 and "audit_schedules"."max_pages_per_utc_day" >= 10 and "audit_schedules"."max_runs_per_utc_day" > 0 and "audit_schedules"."updated_at_ms" >= 0),
	CONSTRAINT "audit_schedules_lighthouse_check" CHECK("audit_schedules"."lighthouse_strategy" in ('none','auto'))
);
--> statement-breakpoint
CREATE INDEX `audit_schedules_due_idx` ON `audit_schedules` (`state`,`next_due_at_ms`);--> statement-breakpoint
CREATE TABLE `audit_run_evidence` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`manifest_json` text NOT NULL,
	`artifact_key` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`coverage_state` text NOT NULL,
	`observed_start_at_ms` integer,
	`observed_end_at_ms` integer,
	`finalized_at_ms` integer NOT NULL,
	`seal_token` text NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`audit_id`) REFERENCES `audits`(`project_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_evidence_state_check" CHECK("audit_run_evidence"."coverage_state" in ('unassessed','partial','complete')),
	CONSTRAINT "audit_evidence_hash_check" CHECK(length("audit_run_evidence"."artifact_sha256") = 64 and "audit_run_evidence"."finalized_at_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX `audit_evidence_project_time_idx` ON `audit_run_evidence` (`project_id`,`finalized_at_ms`);--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `fetched_at_ms` integer;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `content_assessed` integer;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `is_html` integer;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `is_likely_js_shell` integer;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `rendering_mode` text;--> statement-breakpoint
ALTER TABLE `audits` ADD `is_scheduled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `audits` ADD `requested_start_url` text;--> statement-breakpoint
ALTER TABLE `audits` ADD `requested_config` text;--> statement-breakpoint
ALTER TABLE `audits` ADD `evidence_seal_token` text;--> statement-breakpoint
ALTER TABLE `audits` ADD `evidence_seal_started_at_ms` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `audits_project_id_id_uidx` ON `audits` (`project_id`,`id`);