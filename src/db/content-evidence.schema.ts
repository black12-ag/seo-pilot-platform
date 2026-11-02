import {
  foreignKey,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { user } from "./better-auth-schema";
import { audits, auditIssues, auditPages } from "./audit.schema";
import {
  contentCheckSets,
  contentItems,
  contentMutations,
  contentRevisions,
  contentReviewEvents,
} from "./content.schema";

export const contentSources = sqliteTable(
  "content_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mutationReceiptId: text("mutation_receipt_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    attribution: text("attribution").notNull(),
    sourceText: text("source_text").notNull(),
    textHash: text("text_hash").notNull(),
    capturedAtMs: integer("captured_at_ms").notNull(),
    publisherDate: text("publisher_date"),
    language: text("language"),
    market: text("market"),
    extractionMethod: text("extraction_method").notNull(),
    extractionVersion: text("extraction_version").notNull(),
    extractionStatus: text("extraction_status").notNull(),
    extractionReason: text("extraction_reason"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("content_sources_project_id_id_uidx").on(t.projectId, t.id),
    uniqueIndex("content_sources_receipt_uidx").on(t.mutationReceiptId),
    foreignKey({
      columns: [t.projectId, t.mutationReceiptId],
      foreignColumns: [contentMutations.projectId, contentMutations.id],
    }).onDelete("no action"),
  ],
);

export const contentSourceAuditReferences = sqliteTable(
  "content_source_audit_references",
  {
    sourceId: text("source_id").primaryKey(),
    projectId: text("project_id").notNull(),
    auditId: text("audit_id").notNull(),
    pageId: text("page_id"),
    issueId: text("issue_id"),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.sourceId],
      foreignColumns: [contentSources.projectId, contentSources.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.auditId],
      foreignColumns: [audits.projectId, audits.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.auditId, t.pageId],
      foreignColumns: [auditPages.auditId, auditPages.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.auditId, t.issueId],
      foreignColumns: [auditIssues.auditId, auditIssues.id],
    }).onDelete("cascade"),
  ],
);

export const contentRevisionSources = sqliteTable(
  "content_revision_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    revisionId: text("revision_id").notNull(),
    sourceId: text("source_id").notNull(),
    purpose: text("purpose").notNull(),
  },
  (t) => [
    uniqueIndex("content_revision_sources_scope_uidx").on(
      t.projectId,
      t.contentId,
      t.revisionId,
      t.sourceId,
    ),
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId],
      foreignColumns: [
        contentRevisions.projectId,
        contentRevisions.contentId,
        contentRevisions.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.sourceId],
      foreignColumns: [contentSources.projectId, contentSources.id],
    }).onDelete("no action"),
  ],
);

export const contentClaims = sqliteTable(
  "content_claims",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    revisionId: text("revision_id").notNull(),
    targetKind: text("target_kind").notNull(),
    field: text("field"),
    rangeStart: integer("range_start"),
    rangeEnd: integer("range_end"),
    text: text("text").notNull(),
    textHash: text("text_hash").notNull(),
    kind: text("kind").notNull(),
    factual: integer("factual").notNull(),
  },
  (t) => [
    uniqueIndex("content_claims_scope_uidx").on(
      t.projectId,
      t.contentId,
      t.revisionId,
      t.id,
    ),
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId],
      foreignColumns: [
        contentRevisions.projectId,
        contentRevisions.contentId,
        contentRevisions.id,
      ],
    }).onDelete("cascade"),
  ],
);

export const contentClaimEvidence = sqliteTable(
  "content_claim_evidence",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    revisionId: text("revision_id").notNull(),
    claimId: text("claim_id").notNull(),
    sourceId: text("source_id").notNull(),
    rangeStart: integer("range_start").notNull(),
    rangeEnd: integer("range_end").notNull(),
    excerpt: text("excerpt").notNull(),
    excerptHash: text("excerpt_hash").notNull(),
    passageId: text("passage_id").notNull(),
    relation: text("relation").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId, t.claimId],
      foreignColumns: [
        contentClaims.projectId,
        contentClaims.contentId,
        contentClaims.revisionId,
        contentClaims.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId, t.sourceId],
      foreignColumns: [
        contentRevisionSources.projectId,
        contentRevisionSources.contentId,
        contentRevisionSources.revisionId,
        contentRevisionSources.sourceId,
      ],
    }).onDelete("no action"),
  ],
);

export const contentChecks = sqliteTable(
  "content_checks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    revisionId: text("revision_id").notNull(),
    checkSetId: text("check_set_id").notNull(),
    claimId: text("claim_id"),
    field: text("field"),
    rule: text("rule").notNull(),
    status: text("status").notNull(),
    severity: text("severity").notNull(),
    explanation: text("explanation").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId, t.checkSetId],
      foreignColumns: [
        contentCheckSets.projectId,
        contentCheckSets.contentId,
        contentCheckSets.revisionId,
        contentCheckSets.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId, t.claimId],
      foreignColumns: [
        contentClaims.projectId,
        contentClaims.contentId,
        contentClaims.revisionId,
        contentClaims.id,
      ],
    }).onDelete("no action"),
  ],
);

export const contentRevisionCheckHeads = sqliteTable(
  "content_revision_check_heads",
  {
    revisionId: text("revision_id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    checkSetId: text("check_set_id").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId, t.checkSetId],
      foreignColumns: [
        contentCheckSets.projectId,
        contentCheckSets.contentId,
        contentCheckSets.revisionId,
        contentCheckSets.id,
      ],
    }).onDelete("cascade"),
  ],
);

export const contentClaimAssessments = sqliteTable(
  "content_claim_assessments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    revisionId: text("revision_id").notNull(),
    eventId: text("event_id").notNull(),
    claimId: text("claim_id").notNull(),
    assessment: text("assessment").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId, t.eventId],
      foreignColumns: [
        contentReviewEvents.projectId,
        contentReviewEvents.contentId,
        contentReviewEvents.revisionId,
        contentReviewEvents.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId, t.claimId],
      foreignColumns: [
        contentClaims.projectId,
        contentClaims.contentId,
        contentClaims.revisionId,
        contentClaims.id,
      ],
    }).onDelete("no action"),
    foreignKey({
      columns: [t.projectId, t.contentId],
      foreignColumns: [contentItems.projectId, contentItems.id],
    }).onDelete("no action"),
  ],
);
