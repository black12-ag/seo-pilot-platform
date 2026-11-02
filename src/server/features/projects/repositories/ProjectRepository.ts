import { invalidateAuditSchedule } from "@/server/features/audit/repositories/auditScheduleProjectWrites";
import { and, count, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  lockProject,
  invalidateSiteAuthority,
} from "@/server/features/site-authority/repositories/siteAuthorityProjectWrites";
import { projects } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import { bumpContentContext } from "@/server/features/content/repositories/contentProjectWrites";

async function listProjects(organizationId: string) {
  return db.query.projects.findMany({
    where: and(
      eq(projects.organizationId, organizationId),
      isNull(projects.archivedAt),
    ),
    orderBy: [desc(projects.createdAt), desc(projects.id)],
  });
}

async function countProjects(organizationId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    );
  return row?.value ?? 0;
}

async function getProjectForOrganization(
  projectId: string,
  organizationId: string,
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return project ?? null;
}

// The archived counterpart of getProjectForOrganization, for the surfaces that
// owe the reader "this project is archived" instead of a bare not-found. Still
// org-scoped, so it adds no cross-org existence oracle.
async function getArchivedProjectForOrganization(
  projectId: string,
  organizationId: string,
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNotNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return project ?? null;
}

// Look up a project by id alone (no org scoping). Only for trusted server
// contexts that have already authorized access another way — e.g. the
// SAM chat Durable Object, whose connections are authorized in the Worker
// before they reach the DO, and which derives its org from the project.
async function getProjectById(projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)))
    .limit(1);
  return project ?? null;
}

async function createProject(
  organizationId: string,
  name: string,
  domain?: string,
  // Omitted keeps the column defaults.
  market?: { locationCode: number; languageCode: string },
) {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(projects)
    .values({ id, organizationId, name, domain, ...market })
    .returning();
  return row;
}

async function updateProject(
  projectId: string,
  organizationId: string,
  input: {
    name: string;
    domain?: string;
    // Omitted leaves the market columns untouched.
    market?: { locationCode: number; languageCode: string };
  },
) {
  await writeProjectWebsite(projectId, organizationId, {
    name: input.name,
    domain: input.domain ?? null,
    ...input.market,
  });
  const row = await getProjectForOrganization(projectId, organizationId);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

async function writeProjectWebsite(
  projectId: string,
  organizationId: string,
  values: {
    domain: string | null;
    name?: string;
    locationCode?: number;
    languageCode?: string;
  },
) {
  await runBatch((tx) => [
    lockProject(tx, projectId, organizationId),
    bumpContentContext(
      tx,
      projectId,
      sql`p.organization_id = ${organizationId} and p.archived_at is null`,
    ),
    ...invalidateSiteAuthority(tx, projectId, organizationId, {
      reason: "website_changed",
      nowMs: Date.now(),
      condition:
        values.domain === null
          ? sql`p.archived_at is null and p.domain is not null`
          : sql`p.archived_at is null and (p.domain is null or p.domain <> ${values.domain})`,
    }),
    ...invalidateAuditSchedule(tx, projectId, organizationId, {
      reason: "project_changed",
      nowMs: Date.now(),
      condition:
        values.domain === null
          ? sql`p.archived_at is null and p.domain is not null`
          : sql`p.archived_at is null and (p.domain is null or p.domain <> ${values.domain})`,
    }),
    tx
      .update(projects)
      .set(values)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.archivedAt),
        ),
      ),
  ]);
}

async function updateProjectWebsite(
  projectId: string,
  organizationId: string,
  domain: string,
  market: { locationCode: number; languageCode: string },
) {
  await writeProjectWebsite(projectId, organizationId, { domain, ...market });
  const row = await getProjectForOrganization(projectId, organizationId);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

// Saves the key only if the project has none, so concurrent first uses can't
// leave the site's key file pointing at a key that was overwritten.
async function setIndexNowKeyIfMissing(
  projectId: string,
  organizationId: string,
  key: string,
) {
  await db
    .update(projects)
    .set({ indexnowKey: key })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.indexnowKey),
      ),
    );
}

async function tryCreateDefaultProject(organizationId: string) {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(projects)
    .values({
      id,
      organizationId,
      name: "Default",
      domain: null,
    })
    .onConflictDoNothing()
    .returning({ id: projects.id });
  return inserted.length > 0 ? id : null;
}

async function listArchivedProjects(organizationId: string) {
  return db.query.projects.findMany({
    where: and(
      eq(projects.organizationId, organizationId),
      isNotNull(projects.archivedAt),
    ),
    orderBy: [desc(projects.archivedAt), desc(projects.id)],
  });
}

async function restoreProject(projectId: string, organizationId: string) {
  await runBatch((tx) => [
    lockProject(tx, projectId, organizationId),
    bumpContentContext(
      tx,
      projectId,
      sql`p.organization_id = ${organizationId} and p.archived_at is not null`,
    ),
    ...invalidateSiteAuthority(tx, projectId, organizationId, {
      reason: "project_archived",
      nowMs: Date.now(),
      condition: sql`p.archived_at is not null`,
    }),
    ...invalidateAuditSchedule(tx, projectId, organizationId, {
      reason: "project_archived",
      nowMs: Date.now(),
      condition: sql`p.archived_at is not null`,
    }),
    tx
      .update(projects)
      .set({ archivedAt: null })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNotNull(projects.archivedAt),
        ),
      ),
  ]);
  if (!(await getProjectForOrganization(projectId, organizationId)))
    throw new AppError("NOT_FOUND");
}

async function archiveProject(projectId: string, organizationId: string) {
  await runBatch((tx) => [
    lockProject(tx, projectId, organizationId),
    bumpContentContext(
      tx,
      projectId,
      sql`p.organization_id = ${organizationId} and p.archived_at is null`,
    ),
    ...invalidateSiteAuthority(tx, projectId, organizationId, {
      reason: "project_archived",
      nowMs: Date.now(),
      condition: sql`p.archived_at is null`,
    }),
    ...invalidateAuditSchedule(tx, projectId, organizationId, {
      reason: "project_archived",
      nowMs: Date.now(),
      condition: sql`p.archived_at is null`,
    }),
    tx
      .update(projects)
      .set({ archivedAt: sql`(current_timestamp)` })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.archivedAt),
        ),
      ),
  ]);
  if (!(await getArchivedProjectForOrganization(projectId, organizationId)))
    throw new AppError("NOT_FOUND");
}

export const ProjectRepository = {
  listProjects,
  listArchivedProjects,
  countProjects,
  getProjectForOrganization,
  getArchivedProjectForOrganization,
  getProjectById,
  createProject,
  updateProject,
  updateProjectWebsite,
  setIndexNowKeyIfMissing,
  tryCreateDefaultProject,
  archiveProject,
  restoreProject,
} as const;
