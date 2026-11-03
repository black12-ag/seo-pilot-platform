import { and, eq, inArray, ne, notExists, or, sql } from "drizzle-orm";
import * as schema from "../../src/db/pg/schema";
import type { Db, UserRow } from "./inventory";

export async function erasePostgres(
  db: Db,
  user: UserRow,
  organizationIds: string[],
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        sql`
      exists (select 1 from member m where m.organization_id = ${schema.projects.organizationId} and m.user_id = ${user.id})
      or exists (select 1 from content_sources s where s.project_id = ${schema.projects.id} and s.created_by_user_id = ${user.id})
      or exists (select 1 from content_revisions r where r.project_id = ${schema.projects.id} and r.author_user_id = ${user.id})
      or exists (select 1 from content_review_events e where e.project_id = ${schema.projects.id} and e.reviewer_user_id = ${user.id})
    `,
      )
      .orderBy(schema.projects.id)
      .for("update");
    await tx
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.userId, user.id))
      .orderBy(schema.member.id)
      .for("update");
    const affected = sql`select r.id from content_revisions r where r.author_user_id = ${user.id} or exists (
      select 1 from content_revision_sources rs join content_sources s on s.id = rs.source_id and s.project_id = rs.project_id
      where rs.revision_id = r.id and s.created_by_user_id = ${user.id})`;
    const revisionRows = await tx
      .select({
        id: schema.contentRevisions.id,
        receiptId: schema.contentRevisions.mutationReceiptId,
      })
      .from(schema.contentRevisions)
      .where(sql`${schema.contentRevisions.id} in (${affected})`);
    const sourceRows = await tx
      .select({
        id: schema.contentSources.id,
        receiptId: schema.contentSources.mutationReceiptId,
      })
      .from(schema.contentSources)
      .where(eq(schema.contentSources.createdByUserId, user.id));
    const eventRows = await tx
      .select({
        id: schema.contentReviewEvents.id,
        receiptId: schema.contentReviewEvents.mutationReceiptId,
      })
      .from(schema.contentReviewEvents)
      .where(
        sql`${schema.contentReviewEvents.reviewerUserId} = ${user.id} or ${schema.contentReviewEvents.revisionId} in (${affected})`,
      );
    const now = Date.now();
    await tx.execute(sql`update content_mutations set request_hash = '' where id in (
      select mutation_receipt_id from content_sources where created_by_user_id = ${user.id}
      union select mutation_receipt_id from content_revisions where id in (${affected})
      union select mutation_receipt_id from content_review_events where reviewer_user_id = ${user.id} or revision_id in (${affected})
    )`);
    await tx.execute(
      sql`update content_claim_assessments set reason = '' where revision_id in (${affected}) or event_id in (select id from content_review_events where reviewer_user_id = ${user.id})`,
    );
    await tx.execute(
      sql`update content_review_events set reason = '' where reviewer_user_id = ${user.id} or revision_id in (${affected})`,
    );
    await tx.execute(
      sql`update content_checks set explanation = '' where revision_id in (${affected})`,
    );
    await tx.execute(
      sql`update content_check_sets set check_set_hash = '', content_hash = '', context_hash = '', source_set_hash = '' where revision_id in (${affected})`,
    );
    await tx.execute(
      sql`update content_claim_evidence set excerpt = '', excerpt_hash = '', passage_id = '' where revision_id in (${affected})`,
    );
    await tx.execute(
      sql`update content_claims set text = '', text_hash = '' where revision_id in (${affected})`,
    );
    await tx.execute(
      sql`update content_revisions set brief_json = '{}', markdown = '', metadata_json = '{}', context_json = '{}', context_hash = '', source_set_hash = '', content_hash = '', open_questions_json = '[]', omissions_json = '[]', redacted_at_ms = ${now} where id in (${affected})`,
    );
    await tx.execute(
      sql`delete from content_source_url_captures where source_id in (select id from content_sources where created_by_user_id = ${user.id})`,
    );
    await tx.execute(
      sql`delete from content_source_audit_references where source_id in (select id from content_sources where created_by_user_id = ${user.id})`,
    );
    await tx.execute(
      sql`update content_sources set title = '', attribution = '', source_text = '', text_hash = '', extraction_status = 'erased', extraction_reason = null, created_by_user_id = null where created_by_user_id = ${user.id}`,
    );
    await tx
      .delete(schema.invitation)
      .where(sql`lower(${schema.invitation.email}) = lower(${user.email})`);
    // Better Auth stores verification rows keyed by composite identifiers
    // (reset-password:<token>, delete-account-<token>) whose value is the
    // user id; emails never appear bare in either column.
    await tx
      .delete(schema.verification)
      .where(
        or(
          eq(schema.verification.identifier, user.id),
          eq(schema.verification.value, user.id),
        ),
      );
    // These columns intentionally have no user FK. Remove connection records
    // and anonymize retained audit attribution even if the user left that
    // workspace before making this request.
    await tx
      .delete(schema.gscConnections)
      .where(eq(schema.gscConnections.connectedByUserId, user.id));
    await tx
      .delete(schema.ga4Connections)
      .where(eq(schema.ga4Connections.connectedByUserId, user.id));
    // apikey.reference_id mirrors the plugin's polymorphic schema and has no
    // user FK, so keys don't cascade with the user row.
    await tx
      .delete(schema.apikey)
      .where(eq(schema.apikey.referenceId, user.id));
    await tx
      .update(schema.audits)
      .set({ startedByUserId: "gdpr-deleted-user" })
      .where(eq(schema.audits.startedByUserId, user.id));
    // reports.created_by_user_id has no FK either (same reason as audits), so a
    // surviving multi-member org keeps its reports with the attribution wiped.
    // Any public link on a report they created is revoked in the same
    // statement: the link is a capability published from their work, and it
    // must not outlive them.
    await tx
      .update(schema.reports)
      .set({
        createdByUserId: "gdpr-deleted-user",
        shareToken: null,
        sharedAt: null,
      })
      .where(eq(schema.reports.createdByUserId, user.id));
    await tx
      .update(schema.reportTemplates)
      .set({ createdByUserId: "gdpr-deleted-user" })
      .where(eq(schema.reportTemplates.createdByUserId, user.id));
    if (organizationIds.length > 0) {
      // Re-assert the solo-membership guard at delete time: anyone who
      // accepted an invite after the inventory was taken must abort the
      // transaction, not be cascaded away with the organization.
      const deletedOrganizations = await tx
        .delete(schema.organization)
        .where(
          and(
            inArray(schema.organization.id, organizationIds),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(schema.member)
                .where(
                  and(
                    eq(schema.member.organizationId, schema.organization.id),
                    ne(schema.member.userId, user.id),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: schema.organization.id });
      if (deletedOrganizations.length !== organizationIds.length) {
        throw new Error(
          "Organization(s) gained other members since the inventory was taken; aborting the Postgres delete. Re-run after resolving membership.",
        );
      }
    }
    const deleted = await tx
      .delete(schema.user)
      .where(eq(schema.user.id, user.id))
      .returning({ id: schema.user.id });
    if (deleted.length !== 1) {
      throw new Error("Postgres user row disappeared before the final delete.");
    }
    return {
      revisionIds: revisionRows.map((row) => row.id),
      sourceIds: sourceRows.map((row) => row.id),
      eventIds: eventRows.map((row) => row.id),
      receiptIds: [...revisionRows, ...sourceRows, ...eventRows].map(
        (row) => row.receiptId,
      ),
    };
  });
}

/** Independent post-commit read-back for the erasure receipt. */
export async function verifyPostgres(
  db: Db,
  userId: string,
  organizationIds: string[],
  content: {
    revisionIds: string[];
    sourceIds: string[];
    eventIds: string[];
    receiptIds: string[];
  },
) {
  const userRows = await db.$count(schema.user, eq(schema.user.id, userId));
  const organizationRows =
    organizationIds.length === 0
      ? 0
      : await db.$count(
          schema.organization,
          inArray(schema.organization.id, organizationIds),
        );
  if (userRows !== 0 || organizationRows !== 0) {
    throw new Error(
      "Postgres verification failed: user or organization rows remain.",
    );
  }
  const unsafeSources = content.sourceIds.length
    ? await db.$count(
        schema.contentSources,
        and(
          inArray(schema.contentSources.id, content.sourceIds),
          sql`(${schema.contentSources.sourceText} <> '' or ${schema.contentSources.attribution} <> '' or ${schema.contentSources.title} <> '' or ${schema.contentSources.textHash} <> '' or ${schema.contentSources.extractionStatus} <> 'erased')`,
        ),
      )
    : 0;
  const unsafeUrlCaptures = content.sourceIds.length
    ? await db.$count(
        schema.contentSourceUrlCaptures,
        inArray(schema.contentSourceUrlCaptures.sourceId, content.sourceIds),
      )
    : 0;
  const unsafeRevisions = content.revisionIds.length
    ? await db.$count(
        schema.contentRevisions,
        and(
          inArray(schema.contentRevisions.id, content.revisionIds),
          sql`(${schema.contentRevisions.redactedAtMs} is null or ${schema.contentRevisions.markdown} <> '' or ${schema.contentRevisions.briefJson} <> '{}' or ${schema.contentRevisions.metadataJson} <> '{}' or ${schema.contentRevisions.contextJson} <> '{}' or ${schema.contentRevisions.openQuestionsJson} <> '[]' or ${schema.contentRevisions.omissionsJson} <> '[]')`,
        ),
      )
    : 0;
  const unsafeClaims = content.revisionIds.length
    ? await db.$count(
        schema.contentClaims,
        and(
          inArray(schema.contentClaims.revisionId, content.revisionIds),
          sql`${schema.contentClaims.text} <> ''`,
        ),
      )
    : 0;
  const unsafeExcerpts = content.revisionIds.length
    ? await db.$count(
        schema.contentClaimEvidence,
        and(
          inArray(schema.contentClaimEvidence.revisionId, content.revisionIds),
          sql`${schema.contentClaimEvidence.excerpt} <> ''`,
        ),
      )
    : 0;
  const unsafeEvents = content.eventIds.length
    ? await db.$count(
        schema.contentReviewEvents,
        and(
          inArray(schema.contentReviewEvents.id, content.eventIds),
          sql`${schema.contentReviewEvents.reason} <> ''`,
        ),
      )
    : 0;
  const unsafeReceipts = content.receiptIds.length
    ? await db.$count(
        schema.contentMutations,
        and(
          inArray(schema.contentMutations.id, content.receiptIds),
          sql`${schema.contentMutations.requestHash} <> ''`,
        ),
      )
    : 0;
  const unsafeChecks = content.revisionIds.length
    ? await db.$count(
        schema.contentChecks,
        and(
          inArray(schema.contentChecks.revisionId, content.revisionIds),
          sql`${schema.contentChecks.explanation} <> ''`,
        ),
      )
    : 0;
  const unsafeAssessments = content.eventIds.length
    ? await db.$count(
        schema.contentClaimAssessments,
        and(
          inArray(schema.contentClaimAssessments.eventId, content.eventIds),
          sql`${schema.contentClaimAssessments.reason} <> ''`,
        ),
      )
    : 0;
  if (
    unsafeSources ||
    unsafeUrlCaptures ||
    unsafeRevisions ||
    unsafeClaims ||
    unsafeExcerpts ||
    unsafeEvents ||
    unsafeChecks ||
    unsafeAssessments ||
    unsafeReceipts
  )
    throw new Error(
      "Postgres verification failed: content erasure is incomplete.",
    );
  return {
    userRows,
    organizationRows,
    unsafeSources,
    unsafeUrlCaptures,
    unsafeRevisions,
    unsafeClaims,
    unsafeExcerpts,
    unsafeEvents,
    unsafeChecks,
    unsafeAssessments,
    unsafeReceipts,
  };
}
