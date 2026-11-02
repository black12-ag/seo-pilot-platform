CREATE TABLE `content_check_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`check_set_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`context_hash` text NOT NULL,
	`source_set_hash` text NOT NULL,
	`rule_version` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`) REFERENCES `content_revisions`(`project_id`,`content_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_check_sets_scope_uidx` ON `content_check_sets` (`project_id`,`content_id`,`revision_id`,`id`);--> statement-breakpoint
CREATE TABLE `content_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`head_version` integer DEFAULT 0 NOT NULL,
	`archived_at_ms` integer,
	`created_by_user_id` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`review_version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_items_project_id_id_uidx` ON `content_items` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `content_mutations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`kind` text NOT NULL,
	`result_id` text NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "content_mutations_completed_check" CHECK("content_mutations"."completed" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_mutations_project_mutation_uidx` ON `content_mutations` (`project_id`,`mutation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_mutations_project_id_id_uidx` ON `content_mutations` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `content_project_state` (
	`project_id` text PRIMARY KEY NOT NULL,
	`context_version` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `content_review_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`request_id` text NOT NULL,
	`mutation_receipt_id` text NOT NULL,
	`reviewer_user_id` text,
	`reviewer_membership_id` text,
	`decision` text NOT NULL,
	`surface` text NOT NULL,
	`reason` text NOT NULL,
	`assessed_remaining_text` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`request_version` integer NOT NULL,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewer_membership_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`,`request_id`) REFERENCES `content_review_requests`(`project_id`,`content_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`mutation_receipt_id`) REFERENCES `content_mutations`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_review_events_scope_uidx` ON `content_review_events` (`project_id`,`content_id`,`revision_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_review_events_receipt_uidx` ON `content_review_events` (`mutation_receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_review_events_version_uidx` ON `content_review_events` (`request_id`,`request_version`);--> statement-breakpoint
CREATE TABLE `content_review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`check_set_id` text NOT NULL,
	`mutation_receipt_id` text NOT NULL,
	`assignee_user_id` text,
	`requested_by_user_id` text,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`context_version` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`sequence` integer NOT NULL,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`,`check_set_id`) REFERENCES `content_check_sets`(`project_id`,`content_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`mutation_receipt_id`) REFERENCES `content_mutations`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_review_requests_scope_uidx` ON `content_review_requests` (`project_id`,`content_id`,`revision_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_review_requests_receipt_uidx` ON `content_review_requests` (`mutation_receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_review_requests_sequence_uidx` ON `content_review_requests` (`content_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `content_revision_parents` (
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`revision_id` text PRIMARY KEY NOT NULL,
	`parent_revision_id` text NOT NULL,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`) REFERENCES `content_revisions`(`project_id`,`content_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`content_id`,`parent_revision_id`) REFERENCES `content_revisions`(`project_id`,`content_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `content_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`version` integer NOT NULL,
	`mutation_receipt_id` text NOT NULL,
	`brief_json` text NOT NULL,
	`markdown` text NOT NULL,
	`metadata_json` text NOT NULL,
	`context_json` text NOT NULL,
	`context_version` integer NOT NULL,
	`context_hash` text NOT NULL,
	`source_set_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`open_questions_json` text NOT NULL,
	`omissions_json` text NOT NULL,
	`author_user_id` text,
	`surface` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`redacted_at_ms` integer,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`content_id`) REFERENCES `content_items`(`project_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`mutation_receipt_id`) REFERENCES `content_mutations`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_revisions_project_content_id_uidx` ON `content_revisions` (`project_id`,`content_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_revisions_content_version_uidx` ON `content_revisions` (`content_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_revisions_receipt_uidx` ON `content_revisions` (`mutation_receipt_id`);--> statement-breakpoint
CREATE TABLE `content_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`check_set_id` text NOT NULL,
	`claim_id` text,
	`field` text,
	`rule` text NOT NULL,
	`status` text NOT NULL,
	`severity` text NOT NULL,
	`explanation` text NOT NULL,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`,`check_set_id`) REFERENCES `content_check_sets`(`project_id`,`content_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`,`claim_id`) REFERENCES `content_claims`(`project_id`,`content_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `content_claim_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`event_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`assessment` text NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`,`event_id`) REFERENCES `content_review_events`(`project_id`,`content_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`,`claim_id`) REFERENCES `content_claims`(`project_id`,`content_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`content_id`) REFERENCES `content_items`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `content_claim_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`source_id` text NOT NULL,
	`range_start` integer NOT NULL,
	`range_end` integer NOT NULL,
	`excerpt` text NOT NULL,
	`excerpt_hash` text NOT NULL,
	`passage_id` text NOT NULL,
	`relation` text NOT NULL,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`,`claim_id`) REFERENCES `content_claims`(`project_id`,`content_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`,`source_id`) REFERENCES `content_revision_sources`(`project_id`,`content_id`,`revision_id`,`source_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `content_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`field` text,
	`range_start` integer,
	`range_end` integer,
	`text` text NOT NULL,
	`text_hash` text NOT NULL,
	`kind` text NOT NULL,
	`factual` integer NOT NULL,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`) REFERENCES `content_revisions`(`project_id`,`content_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_claims_scope_uidx` ON `content_claims` (`project_id`,`content_id`,`revision_id`,`id`);--> statement-breakpoint
CREATE TABLE `content_revision_check_heads` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`check_set_id` text NOT NULL,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`,`check_set_id`) REFERENCES `content_check_sets`(`project_id`,`content_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `content_revision_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`source_id` text NOT NULL,
	`purpose` text NOT NULL,
	FOREIGN KEY (`project_id`,`content_id`,`revision_id`) REFERENCES `content_revisions`(`project_id`,`content_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`source_id`) REFERENCES `content_sources`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_revision_sources_scope_uidx` ON `content_revision_sources` (`project_id`,`content_id`,`revision_id`,`source_id`);--> statement-breakpoint
CREATE TABLE `content_source_audit_references` (
	`source_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`audit_id` text NOT NULL,
	`page_id` text,
	`issue_id` text,
	FOREIGN KEY (`project_id`,`source_id`) REFERENCES `content_sources`(`project_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`audit_id`) REFERENCES `audits`(`project_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audit_id`,`page_id`) REFERENCES `audit_pages`(`audit_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audit_id`,`issue_id`) REFERENCES `audit_issues`(`audit_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `content_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`mutation_receipt_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`attribution` text NOT NULL,
	`source_text` text NOT NULL,
	`text_hash` text NOT NULL,
	`captured_at_ms` integer NOT NULL,
	`publisher_date` text,
	`language` text,
	`market` text,
	`extraction_method` text NOT NULL,
	`extraction_version` text NOT NULL,
	`extraction_status` text NOT NULL,
	`extraction_reason` text,
	`created_by_user_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`mutation_receipt_id`) REFERENCES `content_mutations`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_sources_project_id_id_uidx` ON `content_sources` (`project_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_sources_receipt_uidx` ON `content_sources` (`mutation_receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_issues_audit_id_id_uidx` ON `audit_issues` (`audit_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_pages_audit_id_id_uidx` ON `audit_pages` (`audit_id`,`id`);