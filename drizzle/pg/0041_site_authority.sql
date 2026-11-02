CREATE TABLE "site_authority_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"authority_version" integer NOT NULL,
	"origin" text NOT NULL,
	"method" text NOT NULL,
	"nonce" text NOT NULL,
	"status" text NOT NULL,
	"issued_at_ms" bigint NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"next_check_at_ms" bigint NOT NULL,
	"attempts_used" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"claim_until_ms" bigint,
	"checked_at_ms" bigint,
	"last_failure" text,
	"http_status" integer,
	"evidence_sha256" text,
	"issued_by_user_id" text,
	CONSTRAINT "site_authority_challenges_project_id_uidx" UNIQUE("project_id","id"),
	CONSTRAINT "site_authority_challenges_version_check" CHECK ("site_authority_challenges"."authority_version" > 0),
	CONSTRAINT "site_authority_challenges_method_check" CHECK ("site_authority_challenges"."method" in ('http_file','dns_txt')),
	CONSTRAINT "site_authority_challenges_status_check" CHECK ("site_authority_challenges"."status" in ('pending','checking','verified','expired','exhausted','superseded','revoked')),
	CONSTRAINT "site_authority_challenges_time_check" CHECK ("site_authority_challenges"."issued_at_ms" >= 0 and "site_authority_challenges"."expires_at_ms" > "site_authority_challenges"."issued_at_ms" and "site_authority_challenges"."next_check_at_ms" >= 0),
	CONSTRAINT "site_authority_challenges_attempts_check" CHECK ("site_authority_challenges"."attempts_used" between 0 and 5),
	CONSTRAINT "site_authority_challenges_claim_check" CHECK (("site_authority_challenges"."claim_token" is null and "site_authority_challenges"."claim_until_ms" is null and "site_authority_challenges"."status" <> 'checking') or ("site_authority_challenges"."claim_token" is not null and "site_authority_challenges"."claim_until_ms" is not null and length("site_authority_challenges"."claim_token") = 36 and "site_authority_challenges"."claim_until_ms" > "site_authority_challenges"."issued_at_ms" and "site_authority_challenges"."status" = 'checking')),
	CONSTRAINT "site_authority_challenges_bounds_check" CHECK (length("site_authority_challenges"."id") = 36 and length("site_authority_challenges"."nonce") = 43 and length("site_authority_challenges"."origin") between 9 and 261 and ("site_authority_challenges"."http_status" is null or "site_authority_challenges"."http_status" between 100 and 599) and ("site_authority_challenges"."evidence_sha256" is null or length("site_authority_challenges"."evidence_sha256") = 64)),
	CONSTRAINT "site_authority_challenges_failure_check" CHECK ("site_authority_challenges"."last_failure" is null or "site_authority_challenges"."last_failure" in ('not_found','mismatch','redirect','blocked_target','unreachable','timeout','body_too_large','invalid_response','dns_unavailable','dns_not_found')),
	CONSTRAINT "site_authority_challenges_evidence_check" CHECK ("site_authority_challenges"."status" <> 'verified' or ("site_authority_challenges"."checked_at_ms" is not null and "site_authority_challenges"."evidence_sha256" is not null and "site_authority_challenges"."last_failure" is null))
);
--> statement-breakpoint
CREATE TABLE "project_site_authority" (
	"project_id" text PRIMARY KEY NOT NULL,
	"origin" text,
	"version" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"current_challenge_id" text,
	"verified_at_ms" bigint,
	"verified_until_ms" bigint,
	"revocation_reason" text,
	"last_issued_at_ms" bigint,
	"issue_window_started_at_ms" bigint,
	"issued_in_window" integer DEFAULT 0 NOT NULL,
	"completion_claim_token" text,
	"updated_at_ms" bigint NOT NULL,
	CONSTRAINT "project_site_authority_completion_check" CHECK (completion_claim_token is null or length(completion_claim_token) = 36),
	CONSTRAINT "project_site_authority_version_check" CHECK ("project_site_authority"."version" >= 0),
	CONSTRAINT "project_site_authority_status_check" CHECK ("project_site_authority"."status" in ('unverified','pending','verified','revoked')),
	CONSTRAINT "project_site_authority_reason_check" CHECK ("project_site_authority"."revocation_reason" is null or "project_site_authority"."revocation_reason" in ('user','website_changed','project_archived','organization_changed')),
	CONSTRAINT "project_site_authority_window_check" CHECK ("project_site_authority"."issued_in_window" between 0 and 10),
	CONSTRAINT "project_site_authority_origin_check" CHECK ("project_site_authority"."origin" is null or length("project_site_authority"."origin") between 9 and 261),
	CONSTRAINT "project_site_authority_grant_check" CHECK (("project_site_authority"."status" = 'verified' and "project_site_authority"."origin" is not null and "project_site_authority"."current_challenge_id" is not null and "project_site_authority"."verified_at_ms" is not null and "project_site_authority"."verified_until_ms" is not null and "project_site_authority"."verified_until_ms" > "project_site_authority"."verified_at_ms") or ("project_site_authority"."status" <> 'verified' and "project_site_authority"."verified_at_ms" is null and "project_site_authority"."verified_until_ms" is null))
);
--> statement-breakpoint
ALTER TABLE "project_site_authority" ADD CONSTRAINT "project_site_authority_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_site_authority" ADD CONSTRAINT "project_site_authority_current_challenge_fk" FOREIGN KEY ("project_id","current_challenge_id") REFERENCES "public"."site_authority_challenges"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_authority_challenges" ADD CONSTRAINT "site_authority_challenges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_authority_challenges" ADD CONSTRAINT "site_authority_challenges_issued_by_user_id_user_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_authority_challenges_project_version_uidx" ON "site_authority_challenges" USING btree ("project_id","authority_version");--> statement-breakpoint
CREATE INDEX "site_authority_challenges_project_issued_idx" ON "site_authority_challenges" USING btree ("project_id","issued_at_ms");