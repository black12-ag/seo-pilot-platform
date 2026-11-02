import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
import {
  contentProjectState,
  contentMutations,
  contentItems,
  contentRevisions,
  contentRevisionParents,
  contentRevisionSources,
  contentClaims,
  contentClaimEvidence,
  member,
  projects,
} from "@/db/schema";
import { savedContentRevisionSchema } from "@/types/schemas/content";
import { archive, createRevision, saveRevision } from "./contentRevisionWrites";
import { getItemStatus, list, listRevisions } from "./contentLibraryReads";

async function getMembership(organizationId: string, userId: string) {
  const [row] = await db
    .select({ id: member.id, role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);
  return row ?? null;
}

async function getContextVersion(organizationId: string, projectId: string) {
  const [row] = await db
    .select({ version: contentProjectState.contextVersion })
    .from(projects)
    .leftJoin(
      contentProjectState,
      eq(contentProjectState.projectId, projects.id),
    )
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return row ? (row.version ?? 0) : null;
}

async function getMutation(
  organizationId: string,
  projectId: string,
  mutationId: string,
) {
  const [row] = await db
    .select({
      kind: contentMutations.kind,
      requestHash: contentMutations.requestHash,
      resultId: contentMutations.resultId,
    })
    .from(contentMutations)
    .innerJoin(projects, eq(projects.id, contentMutations.projectId))
    .where(
      and(
        eq(contentMutations.projectId, projectId),
        eq(contentMutations.mutationId, mutationId),
        eq(contentMutations.completed, 1),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getRevisionById(
  organizationId: string,
  projectId: string,
  revisionId: string,
) {
  const [row] = await db
    .select({ contentId: contentRevisions.contentId })
    .from(contentRevisions)
    .innerJoin(projects, eq(projects.id, contentRevisions.projectId))
    .where(
      and(
        eq(contentRevisions.id, revisionId),
        eq(contentRevisions.projectId, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return row
    ? getRevision(organizationId, projectId, row.contentId, revisionId)
    : null;
}

async function getRevisionByVersion(
  organizationId: string,
  projectId: string,
  contentId: string,
  version: number,
) {
  const [row] = await db
    .select({ id: contentRevisions.id })
    .from(contentRevisions)
    .innerJoin(projects, eq(projects.id, contentRevisions.projectId))
    .where(
      and(
        eq(contentRevisions.projectId, projectId),
        eq(contentRevisions.contentId, contentId),
        eq(contentRevisions.version, version),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return row ? getRevision(organizationId, projectId, contentId, row.id) : null;
}

async function getRevision(
  organizationId: string,
  projectId: string,
  contentId: string,
  revisionId?: string,
) {
  const authorized = sql`exists (select 1 from projects p where p.id = ${projectId} and p.organization_id = ${organizationId} and p.archived_at is null)`;
  const [row] = await db
    .select({
      revision: contentRevisions,
      parent: contentRevisionParents.parentRevisionId,
    })
    .from(contentRevisions)
    .innerJoin(
      contentItems,
      and(
        eq(contentItems.id, contentRevisions.contentId),
        eq(contentItems.projectId, contentRevisions.projectId),
      ),
    )
    .leftJoin(
      contentRevisionParents,
      eq(contentRevisionParents.revisionId, contentRevisions.id),
    )
    .where(
      and(
        eq(contentRevisions.projectId, projectId),
        eq(contentRevisions.contentId, contentId),
        revisionId
          ? eq(contentRevisions.id, revisionId)
          : eq(contentRevisions.version, contentItems.headVersion),
        authorized,
      ),
    )
    .limit(1);
  if (!row) return null;
  const revision = row.revision;
  if (revision.redactedAtMs !== null) return null;
  const [sources, claims, evidence] = await Promise.all([
    db
      .select()
      .from(contentRevisionSources)
      .where(
        and(eq(contentRevisionSources.revisionId, revision.id), authorized),
      ),
    db
      .select()
      .from(contentClaims)
      .where(and(eq(contentClaims.revisionId, revision.id), authorized))
      .orderBy(asc(contentClaims.id)),
    db
      .select()
      .from(contentClaimEvidence)
      .where(and(eq(contentClaimEvidence.revisionId, revision.id), authorized))
      .orderBy(asc(contentClaimEvidence.id)),
  ]);
  const brief: unknown = JSON.parse(revision.briefJson);
  const metadata: unknown = JSON.parse(revision.metadataJson);
  const openQuestions: unknown = JSON.parse(revision.openQuestionsJson);
  const omissions: unknown = JSON.parse(revision.omissionsJson);
  return savedContentRevisionSchema.parse({
    id: revision.id,
    projectId,
    contentId,
    version: revision.version,
    parentRevisionId: row.parent,
    brief,
    markdown: revision.markdown,
    metadata,
    contextJson: revision.contextJson,
    contextVersion: revision.contextVersion,
    contextHash: revision.contextHash,
    sourceSetHash: revision.sourceSetHash,
    contentHash: revision.contentHash,
    sourceIds: sort(
      sources.map((source) => source.sourceId),
      (a, b) => a.localeCompare(b),
    ),
    claims: claims.map((claim) => ({
      id: claim.id,
      target:
        claim.targetKind === "markdown"
          ? { kind: "markdown", start: claim.rangeStart, end: claim.rangeEnd }
          : { kind: "metadata", field: claim.field },
      text: claim.text,
      textHash: claim.textHash,
      kind: claim.kind,
      factual: claim.factual === 1,
      evidence: evidence
        .filter((entry) => entry.claimId === claim.id)
        .map((entry) => ({
          id: entry.id,
          sourceId: entry.sourceId,
          start: entry.rangeStart,
          end: entry.rangeEnd,
          excerpt: entry.excerpt,
          excerptHash: entry.excerptHash,
          passageId: entry.passageId,
          relation: entry.relation,
        })),
    })),
    openQuestions,
    omissions,
    authorUserId: revision.authorUserId,
    surface: revision.surface,
    createdAtMs: revision.createdAtMs,
  });
}

async function getRevisionStatus(
  organizationId: string,
  projectId: string,
  contentId: string,
  revisionId?: string,
) {
  const [row] = await db
    .select({
      id: contentRevisions.id,
      version: contentRevisions.version,
      redactedAtMs: contentRevisions.redactedAtMs,
    })
    .from(contentRevisions)
    .innerJoin(
      contentItems,
      and(
        eq(contentItems.id, contentRevisions.contentId),
        eq(contentItems.projectId, contentRevisions.projectId),
      ),
    )
    .innerJoin(projects, eq(projects.id, contentRevisions.projectId))
    .where(
      and(
        eq(contentRevisions.projectId, projectId),
        eq(contentRevisions.contentId, contentId),
        revisionId
          ? eq(contentRevisions.id, revisionId)
          : eq(contentRevisions.version, contentItems.headVersion),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export const ContentRepository = {
  getMembership,
  getContextVersion,
  getItemStatus,
  list,
  getMutation,
  getRevisionById,
  getRevisionByVersion,
  getRevision,
  getRevisionStatus,
  listRevisions,
  createRevision,
  saveRevision,
  archive,
} as const;
