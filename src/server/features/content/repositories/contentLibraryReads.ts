import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  contentItems,
  contentRevisions,
  contentRevisionParents,
  contentReviewRequests,
  projects,
} from "@/db/schema";
import {
  contentBriefSchema,
  contentItemPageSchema,
  contentMetadataSchema,
  contentRevisionPageSchema,
  type ListContentInput,
} from "@/types/schemas/content";

export async function getItemStatus(
  organizationId: string,
  projectId: string,
  contentId: string,
) {
  const [row] = await db
    .select({
      id: contentItems.id,
      projectId: contentItems.projectId,
      headVersion: contentItems.headVersion,
      reviewVersion: contentItems.reviewVersion,
      archivedAtMs: contentItems.archivedAtMs,
    })
    .from(contentItems)
    .innerJoin(projects, eq(projects.id, contentItems.projectId))
    .where(
      and(
        eq(contentItems.id, contentId),
        eq(contentItems.projectId, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listRevisions(
  organizationId: string,
  projectId: string,
  contentId: string,
  options: { cursor?: string; limit?: number },
) {
  const authorized = sql`exists (select 1 from projects p where p.id = ${projectId} and p.organization_id = ${organizationId} and p.archived_at is null)`;
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  let before: number | undefined;
  if (options.cursor) {
    const [anchor] = await db
      .select({ version: contentRevisions.version })
      .from(contentRevisions)
      .where(
        and(
          eq(contentRevisions.id, options.cursor),
          eq(contentRevisions.projectId, projectId),
          eq(contentRevisions.contentId, contentId),
          authorized,
        ),
      )
      .limit(1);
    if (!anchor) return { items: [], nextCursor: null };
    before = anchor.version;
  }
  const rows = await db
    .select({
      id: contentRevisions.id,
      version: contentRevisions.version,
      parentRevisionId: contentRevisionParents.parentRevisionId,
      authorUserId: contentRevisions.authorUserId,
      surface: contentRevisions.surface,
      createdAtMs: contentRevisions.createdAtMs,
      redactedAtMs: contentRevisions.redactedAtMs,
    })
    .from(contentRevisions)
    .leftJoin(
      contentRevisionParents,
      eq(contentRevisionParents.revisionId, contentRevisions.id),
    )
    .where(
      and(
        eq(contentRevisions.projectId, projectId),
        eq(contentRevisions.contentId, contentId),
        before === undefined ? undefined : lt(contentRevisions.version, before),
        authorized,
      ),
    )
    .orderBy(desc(contentRevisions.version))
    .limit(limit + 1);
  return contentRevisionPageSchema.parse({
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  });
}

export async function list(organizationId: string, input: ListContentInput) {
  const limit = input.limit ?? 20;
  const state = sql`case when ${contentRevisions.redactedAtMs} is not null then 'privacy_erased' when ${contentReviewRequests.state} = 'pending' then 'review_requested' when ${contentReviewRequests.state} in ('approved','changes_requested','rejected') then ${contentReviewRequests.state} when ${contentRevisions.markdown} = '' then 'brief' else 'draft' end`;
  const rows = await db
    .select({
      item: contentItems,
      brief: contentRevisions.briefJson,
      metadata: contentRevisions.metadataJson,
      redactedAtMs: contentRevisions.redactedAtMs,
      state,
    })
    .from(contentItems)
    .innerJoin(projects, eq(projects.id, contentItems.projectId))
    .innerJoin(
      contentRevisions,
      and(
        eq(contentRevisions.projectId, contentItems.projectId),
        eq(contentRevisions.contentId, contentItems.id),
        eq(contentRevisions.version, contentItems.headVersion),
      ),
    )
    .leftJoin(
      contentReviewRequests,
      and(
        eq(contentReviewRequests.projectId, contentItems.projectId),
        eq(contentReviewRequests.contentId, contentItems.id),
        eq(contentReviewRequests.revisionId, contentRevisions.id),
        eq(contentReviewRequests.sequence, contentItems.reviewVersion),
      ),
    )
    .where(
      and(
        eq(contentItems.projectId, input.projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
        input.archived
          ? isNotNull(contentItems.archivedAtMs)
          : isNull(contentItems.archivedAtMs),
        input.cursor ? gt(contentItems.id, input.cursor) : undefined,
        input.state ? sql`${state} = ${input.state}` : undefined,
      ),
    )
    .orderBy(asc(contentItems.id))
    .limit(limit + 1);
  return contentItemPageSchema.parse({
    items: rows.slice(0, limit).map((row) => {
      const brief =
        row.redactedAtMs === null
          ? contentBriefSchema.parse(JSON.parse(row.brief))
          : null;
      const metadata =
        row.redactedAtMs === null
          ? contentMetadataSchema.parse(JSON.parse(row.metadata))
          : null;
      return {
        id: row.item.id,
        projectId: row.item.projectId,
        headVersion: row.item.headVersion,
        archivedAtMs: row.item.archivedAtMs,
        createdAtMs: row.item.createdAtMs,
        updatedAtMs: row.item.updatedAtMs,
        state: row.state,
        title: metadata?.title ?? "",
        topic: brief?.topic ?? "",
      };
    }),
    nextCursor: rows.length > limit ? rows[limit - 1].item.id : null,
  });
}
