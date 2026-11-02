import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { member, user } from "./better-auth-schema";

export const contentProjectState = sqliteTable("content_project_state", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  contextVersion: integer("context_version").notNull().default(0),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const contentItems = sqliteTable(
  "content_items",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    headVersion: integer("head_version").notNull().default(0),
    archivedAtMs: integer("archived_at_ms"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    reviewVersion: integer("review_version").notNull().default(0),
  },
  (t) => [
    uniqueIndex("content_items_project_id_id_uidx").on(t.projectId, t.id),
  ],
);

export const contentMutations = sqliteTable(
  "content_mutations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mutationId: text("mutation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    kind: text("kind").notNull(),
    resultId: text("result_id").notNull(),
    completed: integer("completed").notNull().default(0),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    uniqueIndex("content_mutations_project_mutation_uidx").on(
      t.projectId,
      t.mutationId,
    ),
    uniqueIndex("content_mutations_project_id_id_uidx").on(t.projectId, t.id),
    check("content_mutations_completed_check", sql`${t.completed} in (0, 1)`),
  ],
);

export const contentRevisions = sqliteTable(
  "content_revisions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    version: integer("version").notNull(),
    mutationReceiptId: text("mutation_receipt_id").notNull(),
    briefJson: text("brief_json").notNull(),
    markdown: text("markdown").notNull(),
    metadataJson: text("metadata_json").notNull(),
    contextJson: text("context_json").notNull(),
    contextVersion: integer("context_version").notNull(),
    contextHash: text("context_hash").notNull(),
    sourceSetHash: text("source_set_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    openQuestionsJson: text("open_questions_json").notNull(),
    omissionsJson: text("omissions_json").notNull(),
    authorUserId: text("author_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    surface: text("surface").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    redactedAtMs: integer("redacted_at_ms"),
  },
  (t) => [
    uniqueIndex("content_revisions_project_content_id_uidx").on(
      t.projectId,
      t.contentId,
      t.id,
    ),
    uniqueIndex("content_revisions_content_version_uidx").on(
      t.contentId,
      t.version,
    ),
    uniqueIndex("content_revisions_receipt_uidx").on(t.mutationReceiptId),
    foreignKey({
      columns: [t.projectId, t.contentId],
      foreignColumns: [contentItems.projectId, contentItems.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.mutationReceiptId],
      foreignColumns: [contentMutations.projectId, contentMutations.id],
    }).onDelete("no action"),
  ],
);

export const contentRevisionParents = sqliteTable(
  "content_revision_parents",
  {
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    revisionId: text("revision_id").primaryKey(),
    parentRevisionId: text("parent_revision_id").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId],
      foreignColumns: [
        contentRevisions.projectId,
        contentRevisions.contentId,
        contentRevisions.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.contentId, t.parentRevisionId],
      foreignColumns: [
        contentRevisions.projectId,
        contentRevisions.contentId,
        contentRevisions.id,
      ],
    }).onDelete("cascade"),
  ],
);

export const contentCheckSets = sqliteTable(
  "content_check_sets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    revisionId: text("revision_id").notNull(),
    checkSetHash: text("check_set_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    contextHash: text("context_hash").notNull(),
    sourceSetHash: text("source_set_hash").notNull(),
    ruleVersion: text("rule_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    uniqueIndex("content_check_sets_scope_uidx").on(
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

export const contentReviewRequests = sqliteTable(
  "content_review_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    revisionId: text("revision_id").notNull(),
    checkSetId: text("check_set_id").notNull(),
    mutationReceiptId: text("mutation_receipt_id").notNull(),
    assigneeUserId: text("assignee_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull(),
    state: text("state").notNull(),
    contextVersion: integer("context_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    sequence: integer("sequence").notNull(),
  },
  (t) => [
    uniqueIndex("content_review_requests_scope_uidx").on(
      t.projectId,
      t.contentId,
      t.revisionId,
      t.id,
    ),
    uniqueIndex("content_review_requests_receipt_uidx").on(t.mutationReceiptId),
    uniqueIndex("content_review_requests_sequence_uidx").on(
      t.contentId,
      t.sequence,
    ),
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
      columns: [t.projectId, t.mutationReceiptId],
      foreignColumns: [contentMutations.projectId, contentMutations.id],
    }).onDelete("no action"),
  ],
);

export const contentReviewEvents = sqliteTable(
  "content_review_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contentId: text("content_id").notNull(),
    revisionId: text("revision_id").notNull(),
    requestId: text("request_id").notNull(),
    mutationReceiptId: text("mutation_receipt_id").notNull(),
    reviewerUserId: text("reviewer_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    reviewerMembershipId: text("reviewer_membership_id").references(
      () => member.id,
      { onDelete: "set null" },
    ),
    decision: text("decision").notNull(),
    surface: text("surface").notNull(),
    reason: text("reason").notNull(),
    assessedRemainingText: integer("assessed_remaining_text").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    requestVersion: integer("request_version").notNull(),
  },
  (t) => [
    uniqueIndex("content_review_events_scope_uidx").on(
      t.projectId,
      t.contentId,
      t.revisionId,
      t.id,
    ),
    uniqueIndex("content_review_events_receipt_uidx").on(t.mutationReceiptId),
    uniqueIndex("content_review_events_version_uidx").on(
      t.requestId,
      t.requestVersion,
    ),
    foreignKey({
      columns: [t.projectId, t.contentId, t.revisionId, t.requestId],
      foreignColumns: [
        contentReviewRequests.projectId,
        contentReviewRequests.contentId,
        contentReviewRequests.revisionId,
        contentReviewRequests.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.mutationReceiptId],
      foreignColumns: [contentMutations.projectId, contentMutations.id],
    }).onDelete("no action"),
  ],
);
