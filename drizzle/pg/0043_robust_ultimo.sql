-- Defer scoped NO ACTION checks so whole-project cascades can complete without permitting referenced-source deletion.
CREATE TABLE "content_check_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"check_set_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"context_hash" text NOT NULL,
	"source_set_hash" text NOT NULL,
	"rule_version" text NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"head_version" integer DEFAULT 0 NOT NULL,
	"archived_at_ms" bigint,
	"created_by_user_id" text,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"review_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_mutations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"mutation_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"kind" text NOT NULL,
	"result_id" text NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "content_mutations_completed_check" CHECK ("content_mutations"."completed" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "content_project_state" (
	"project_id" text PRIMARY KEY NOT NULL,
	"context_version" integer DEFAULT 0 NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_review_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"request_id" text NOT NULL,
	"mutation_receipt_id" text NOT NULL,
	"reviewer_user_id" text,
	"reviewer_membership_id" text,
	"decision" text NOT NULL,
	"surface" text NOT NULL,
	"reason" text NOT NULL,
	"assessed_remaining_text" integer NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"request_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_review_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"check_set_id" text NOT NULL,
	"mutation_receipt_id" text NOT NULL,
	"assignee_user_id" text,
	"requested_by_user_id" text,
	"version" integer NOT NULL,
	"state" text NOT NULL,
	"context_version" integer NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"sequence" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_revision_parents" (
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision_id" text PRIMARY KEY NOT NULL,
	"parent_revision_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"version" integer NOT NULL,
	"mutation_receipt_id" text NOT NULL,
	"brief_json" text NOT NULL,
	"markdown" text NOT NULL,
	"metadata_json" text NOT NULL,
	"context_json" text NOT NULL,
	"context_version" integer NOT NULL,
	"context_hash" text NOT NULL,
	"source_set_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"open_questions_json" text NOT NULL,
	"omissions_json" text NOT NULL,
	"author_user_id" text,
	"surface" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"redacted_at_ms" bigint
);
--> statement-breakpoint
CREATE TABLE "content_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"check_set_id" text NOT NULL,
	"claim_id" text,
	"field" text,
	"rule" text NOT NULL,
	"status" text NOT NULL,
	"severity" text NOT NULL,
	"explanation" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_claim_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"event_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"assessment" text NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_claim_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"source_id" text NOT NULL,
	"range_start" integer NOT NULL,
	"range_end" integer NOT NULL,
	"excerpt" text NOT NULL,
	"excerpt_hash" text NOT NULL,
	"passage_id" text NOT NULL,
	"relation" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"field" text,
	"range_start" integer,
	"range_end" integer,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"kind" text NOT NULL,
	"factual" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_revision_check_heads" (
	"revision_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"check_set_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_revision_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"source_id" text NOT NULL,
	"purpose" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_source_audit_references" (
	"source_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"audit_id" text NOT NULL,
	"page_id" text,
	"issue_id" text
);
--> statement-breakpoint
CREATE TABLE "content_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"mutation_receipt_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"attribution" text NOT NULL,
	"source_text" text NOT NULL,
	"text_hash" text NOT NULL,
	"captured_at_ms" bigint NOT NULL,
	"publisher_date" text,
	"language" text,
	"market" text,
	"extraction_method" text NOT NULL,
	"extraction_version" text NOT NULL,
	"extraction_status" text NOT NULL,
	"extraction_reason" text,
	"created_by_user_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "content_check_sets_scope_uidx" ON "content_check_sets" USING btree ("project_id","content_id","revision_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_items_project_id_id_uidx" ON "content_items" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_mutations_project_mutation_uidx" ON "content_mutations" USING btree ("project_id","mutation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_mutations_project_id_id_uidx" ON "content_mutations" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_review_events_scope_uidx" ON "content_review_events" USING btree ("project_id","content_id","revision_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_review_events_receipt_uidx" ON "content_review_events" USING btree ("mutation_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_review_events_version_uidx" ON "content_review_events" USING btree ("request_id","request_version");--> statement-breakpoint
CREATE UNIQUE INDEX "content_review_requests_scope_uidx" ON "content_review_requests" USING btree ("project_id","content_id","revision_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_review_requests_receipt_uidx" ON "content_review_requests" USING btree ("mutation_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_review_requests_sequence_uidx" ON "content_review_requests" USING btree ("content_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "content_revisions_project_content_id_uidx" ON "content_revisions" USING btree ("project_id","content_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_revisions_content_version_uidx" ON "content_revisions" USING btree ("content_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "content_revisions_receipt_uidx" ON "content_revisions" USING btree ("mutation_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_claims_scope_uidx" ON "content_claims" USING btree ("project_id","content_id","revision_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_revision_sources_scope_uidx" ON "content_revision_sources" USING btree ("project_id","content_id","revision_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_sources_project_id_id_uidx" ON "content_sources" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_sources_receipt_uidx" ON "content_sources" USING btree ("mutation_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_issues_audit_id_id_uidx" ON "audit_issues" USING btree ("audit_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_pages_audit_id_id_uidx" ON "audit_pages" USING btree ("audit_id","id");--> statement-breakpoint
ALTER TABLE "content_check_sets" ADD CONSTRAINT "content_check_sets_project_id_content_id_revision_id_content_revisions_project_id_content_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id") REFERENCES "public"."content_revisions"("project_id","content_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_mutations" ADD CONSTRAINT "content_mutations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_project_state" ADD CONSTRAINT "content_project_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_events" ADD CONSTRAINT "content_review_events_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_events" ADD CONSTRAINT "content_review_events_reviewer_membership_id_member_id_fk" FOREIGN KEY ("reviewer_membership_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_events" ADD CONSTRAINT "content_review_events_project_id_content_id_revision_id_request_id_content_review_requests_project_id_content_id_revision_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id","request_id") REFERENCES "public"."content_review_requests"("project_id","content_id","revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_events" ADD CONSTRAINT "content_review_events_project_id_mutation_receipt_id_content_mutations_project_id_id_fk" FOREIGN KEY ("project_id","mutation_receipt_id") REFERENCES "public"."content_mutations"("project_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_review_requests" ADD CONSTRAINT "content_review_requests_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_requests" ADD CONSTRAINT "content_review_requests_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_requests" ADD CONSTRAINT "content_review_requests_project_id_content_id_revision_id_check_set_id_content_check_sets_project_id_content_id_revision_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id","check_set_id") REFERENCES "public"."content_check_sets"("project_id","content_id","revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_requests" ADD CONSTRAINT "content_review_requests_project_id_mutation_receipt_id_content_mutations_project_id_id_fk" FOREIGN KEY ("project_id","mutation_receipt_id") REFERENCES "public"."content_mutations"("project_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_revision_parents" ADD CONSTRAINT "content_revision_parents_project_id_content_id_revision_id_content_revisions_project_id_content_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id") REFERENCES "public"."content_revisions"("project_id","content_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revision_parents" ADD CONSTRAINT "content_revision_parents_project_id_content_id_parent_revision_id_content_revisions_project_id_content_id_id_fk" FOREIGN KEY ("project_id","content_id","parent_revision_id") REFERENCES "public"."content_revisions"("project_id","content_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_project_id_content_id_content_items_project_id_id_fk" FOREIGN KEY ("project_id","content_id") REFERENCES "public"."content_items"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_project_id_mutation_receipt_id_content_mutations_project_id_id_fk" FOREIGN KEY ("project_id","mutation_receipt_id") REFERENCES "public"."content_mutations"("project_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_checks" ADD CONSTRAINT "content_checks_project_id_content_id_revision_id_check_set_id_content_check_sets_project_id_content_id_revision_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id","check_set_id") REFERENCES "public"."content_check_sets"("project_id","content_id","revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_checks" ADD CONSTRAINT "content_checks_project_id_content_id_revision_id_claim_id_content_claims_project_id_content_id_revision_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id","claim_id") REFERENCES "public"."content_claims"("project_id","content_id","revision_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_claim_assessments" ADD CONSTRAINT "content_claim_assessments_project_id_content_id_revision_id_event_id_content_review_events_project_id_content_id_revision_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id","event_id") REFERENCES "public"."content_review_events"("project_id","content_id","revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claim_assessments" ADD CONSTRAINT "content_claim_assessments_project_id_content_id_revision_id_claim_id_content_claims_project_id_content_id_revision_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id","claim_id") REFERENCES "public"."content_claims"("project_id","content_id","revision_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_claim_assessments" ADD CONSTRAINT "content_claim_assessments_project_id_content_id_content_items_project_id_id_fk" FOREIGN KEY ("project_id","content_id") REFERENCES "public"."content_items"("project_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_claim_evidence" ADD CONSTRAINT "content_claim_evidence_project_id_content_id_revision_id_claim_id_content_claims_project_id_content_id_revision_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id","claim_id") REFERENCES "public"."content_claims"("project_id","content_id","revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claim_evidence" ADD CONSTRAINT "content_claim_evidence_project_id_content_id_revision_id_source_id_content_revision_sources_project_id_content_id_revision_id_source_id_fk" FOREIGN KEY ("project_id","content_id","revision_id","source_id") REFERENCES "public"."content_revision_sources"("project_id","content_id","revision_id","source_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_claims" ADD CONSTRAINT "content_claims_project_id_content_id_revision_id_content_revisions_project_id_content_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id") REFERENCES "public"."content_revisions"("project_id","content_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revision_check_heads" ADD CONSTRAINT "content_revision_check_heads_project_id_content_id_revision_id_check_set_id_content_check_sets_project_id_content_id_revision_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id","check_set_id") REFERENCES "public"."content_check_sets"("project_id","content_id","revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revision_sources" ADD CONSTRAINT "content_revision_sources_project_id_content_id_revision_id_content_revisions_project_id_content_id_id_fk" FOREIGN KEY ("project_id","content_id","revision_id") REFERENCES "public"."content_revisions"("project_id","content_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revision_sources" ADD CONSTRAINT "content_revision_sources_project_id_source_id_content_sources_project_id_id_fk" FOREIGN KEY ("project_id","source_id") REFERENCES "public"."content_sources"("project_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_source_audit_references" ADD CONSTRAINT "content_source_audit_references_project_id_source_id_content_sources_project_id_id_fk" FOREIGN KEY ("project_id","source_id") REFERENCES "public"."content_sources"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_source_audit_references" ADD CONSTRAINT "content_source_audit_references_project_id_audit_id_audits_project_id_id_fk" FOREIGN KEY ("project_id","audit_id") REFERENCES "public"."audits"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_source_audit_references" ADD CONSTRAINT "content_source_audit_references_audit_id_page_id_audit_pages_audit_id_id_fk" FOREIGN KEY ("audit_id","page_id") REFERENCES "public"."audit_pages"("audit_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_source_audit_references" ADD CONSTRAINT "content_source_audit_references_audit_id_issue_id_audit_issues_audit_id_id_fk" FOREIGN KEY ("audit_id","issue_id") REFERENCES "public"."audit_issues"("audit_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_sources" ADD CONSTRAINT "content_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_sources" ADD CONSTRAINT "content_sources_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_sources" ADD CONSTRAINT "content_sources_project_id_mutation_receipt_id_content_mutations_project_id_id_fk" FOREIGN KEY ("project_id","mutation_receipt_id") REFERENCES "public"."content_mutations"("project_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;