import { sql } from "drizzle-orm";
import type { ProofFailure } from "@/server/features/site-authority/services/authorityProof";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { user } from "./better-auth-schema";

export const siteAuthorityChallenges = sqliteTable(
  "site_authority_challenges",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    authorityVersion: integer("authority_version").notNull(),
    origin: text("origin").notNull(),
    method: text("method", { enum: ["http_file", "dns_txt"] }).notNull(),
    nonce: text("nonce").notNull(),
    status: text("status", {
      enum: [
        "pending",
        "checking",
        "verified",
        "expired",
        "exhausted",
        "superseded",
        "revoked",
      ],
    }).notNull(),
    issuedAtMs: integer("issued_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    nextCheckAtMs: integer("next_check_at_ms").notNull(),
    attemptsUsed: integer("attempts_used").notNull().default(0),
    claimToken: text("claim_token"),
    claimUntilMs: integer("claim_until_ms"),
    checkedAtMs: integer("checked_at_ms"),
    lastFailure: text("last_failure").$type<ProofFailure>(),
    httpStatus: integer("http_status"),
    evidenceSha256: text("evidence_sha256"),
    issuedByUserId: text("issued_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("site_authority_challenges_project_version_uidx").on(
      t.projectId,
      t.authorityVersion,
    ),
    unique("site_authority_challenges_project_id_uidx").on(t.projectId, t.id),
    index("site_authority_challenges_project_issued_idx").on(
      t.projectId,
      t.issuedAtMs,
    ),
    check(
      "site_authority_challenges_version_check",
      sql`${t.authorityVersion} > 0`,
    ),
    check(
      "site_authority_challenges_method_check",
      sql`${t.method} in ('http_file','dns_txt')`,
    ),
    check(
      "site_authority_challenges_status_check",
      sql`${t.status} in ('pending','checking','verified','expired','exhausted','superseded','revoked')`,
    ),
    check(
      "site_authority_challenges_time_check",
      sql`${t.issuedAtMs} >= 0 and ${t.expiresAtMs} > ${t.issuedAtMs} and ${t.nextCheckAtMs} >= 0`,
    ),
    check(
      "site_authority_challenges_attempts_check",
      sql`${t.attemptsUsed} between 0 and 5`,
    ),
    check(
      "site_authority_challenges_claim_check",
      sql`(${t.claimToken} is null and ${t.claimUntilMs} is null and ${t.status} <> 'checking') or (${t.claimToken} is not null and ${t.claimUntilMs} is not null and length(${t.claimToken}) = 36 and ${t.claimUntilMs} > ${t.issuedAtMs} and ${t.status} = 'checking')`,
    ),
    check(
      "site_authority_challenges_bounds_check",
      sql`length(${t.id}) = 36 and length(${t.nonce}) = 43 and length(${t.origin}) between 9 and 261 and (${t.httpStatus} is null or ${t.httpStatus} between 100 and 599) and (${t.evidenceSha256} is null or length(${t.evidenceSha256}) = 64)`,
    ),
    check(
      "site_authority_challenges_failure_check",
      sql`${t.lastFailure} is null or ${t.lastFailure} in ('not_found','mismatch','redirect','blocked_target','unreachable','timeout','body_too_large','invalid_response','dns_unavailable','dns_not_found')`,
    ),
    check(
      "site_authority_challenges_evidence_check",
      sql`${t.status} <> 'verified' or (${t.checkedAtMs} is not null and ${t.evidenceSha256} is not null and ${t.lastFailure} is null)`,
    ),
  ],
);

export const projectSiteAuthority = sqliteTable(
  "project_site_authority",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    origin: text("origin"),
    version: integer("version").notNull().default(0),
    status: text("status", {
      enum: ["unverified", "pending", "verified", "revoked"],
    }).notNull(),
    currentChallengeId: text("current_challenge_id"),
    verifiedAtMs: integer("verified_at_ms"),
    verifiedUntilMs: integer("verified_until_ms"),
    revocationReason: text("revocation_reason", {
      enum: [
        "user",
        "website_changed",
        "project_archived",
        "organization_changed",
      ],
    }),
    lastIssuedAtMs: integer("last_issued_at_ms"),
    issueWindowStartedAtMs: integer("issue_window_started_at_ms"),
    issuedInWindow: integer("issued_in_window").notNull().default(0),
    completionClaimToken: text("completion_claim_token"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.currentChallengeId],
      foreignColumns: [
        siteAuthorityChallenges.projectId,
        siteAuthorityChallenges.id,
      ],
      name: "project_site_authority_current_challenge_fk",
    }).onDelete("no action"),
    check(
      "project_site_authority_completion_check",
      sql`completion_claim_token is null or length(completion_claim_token) = 36`,
    ),
    check("project_site_authority_version_check", sql`${t.version} >= 0`),
    check(
      "project_site_authority_status_check",
      sql`${t.status} in ('unverified','pending','verified','revoked')`,
    ),
    check(
      "project_site_authority_reason_check",
      sql`${t.revocationReason} is null or ${t.revocationReason} in ('user','website_changed','project_archived','organization_changed')`,
    ),
    check(
      "project_site_authority_window_check",
      sql`${t.issuedInWindow} between 0 and 10`,
    ),
    check(
      "project_site_authority_origin_check",
      sql`${t.origin} is null or length(${t.origin}) between 9 and 261`,
    ),
    check(
      "project_site_authority_grant_check",
      sql`(${t.status} = 'verified' and ${t.origin} is not null and ${t.currentChallengeId} is not null and ${t.verifiedAtMs} is not null and ${t.verifiedUntilMs} is not null and ${t.verifiedUntilMs} > ${t.verifiedAtMs}) or (${t.status} <> 'verified' and ${t.verifiedAtMs} is null and ${t.verifiedUntilMs} is null)`,
    ),
  ],
);
