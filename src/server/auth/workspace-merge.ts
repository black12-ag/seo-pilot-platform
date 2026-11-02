import { invalidateAuditSchedule } from "@/server/features/audit/repositories/auditScheduleProjectWrites";
import { env } from "cloudflare:workers";
import { and, asc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { chunk, firstBy, identity, sort } from "remeda";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { bumpContentContext } from "@/server/features/content/repositories/contentProjectWrites";
import {
  lockProject,
  lockAuthorityOrganization,
  invalidateSiteAuthority,
} from "@/server/features/site-authority/repositories/siteAuthorityProjectWrites";
import { getAuthMode } from "@/lib/auth-mode";
import { AppError } from "@/server/lib/errors";
import {
  auditSchedules,
  auditScheduleAttempts,
  ga4Connections,
  gscConnections,
  organization,
  organizationActivationState,
  projects,
  userOnboardingAnswers,
} from "@/db/schema";
import { SHARED_WORKSPACE_ORGANIZATION_ID } from "./delegated-organization";

// Earliest-wins pick across nullable UTC timestamp strings (string compare is
// chronological for these).
function earliest(values: (string | null)[]) {
  return (
    firstBy(
      values.filter((value): value is string => value !== null),
      identity(),
    ) ?? null
  );
}

// Before the shared workspace, every Cloudflare Access user got their own
// `delegated-${userId}` organization (and local_noauth got delegated-local-admin,
// which an operator switching modes wants folded in too). The shared workspace
// id has no such prefix, so this matches exactly the legacy set.
const legacyWorkspaceFilter = like(organization.id, "delegated-%");

async function countLegacyWorkspaces() {
  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(legacyWorkspaceFilter);

  return rows.length;
}

// Folds every legacy per-user workspace into the shared workspace: projects
// (which carry all their keywords, rank tracking, audits, and agent data with
// them) plus the org-scoped rows, then deletes the emptied legacy orgs. Safe
// to re-run and safe under concurrent clicks — every statement is a no-op once
// the legacy orgs are gone.
async function mergeLegacyWorkspaces() {
  // Hard gate, independent of any caller-side check: outside cloudflare_access
  // mode the "delegated-%" orgs are either live (local_noauth resolves to
  // delegated-local-admin — merging would strand its data in a workspace that
  // mode never shows) or should not exist at all (hosted).
  if (getAuthMode(env.AUTH_MODE) !== "cloudflare_access") {
    throw new AppError(
      "FORBIDDEN",
      "Workspace merge is only available in cloudflare_access auth mode.",
    );
  }

  const legacyOrgs = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(legacyWorkspaceFilter)
    .orderBy(asc(organization.id));

  if (legacyOrgs.length === 0) {
    return { mergedWorkspaces: 0 };
  }

  const legacyIds = legacyOrgs.map((org) => org.id);
  // Legacy org names are "<email localpart> workspace" — reuse the localpart
  // to label renamed projects with their previous owner.
  const ownerLabelByOrgId = new Map(
    legacyOrgs.map((org) => [org.id, org.name.replace(/ workspace$/, "")]),
  );

  // Each legacy workspace auto-created a ("Default", no-domain) project, and
  // the shared workspace allows only one active such project. Rename them
  // before repointing so the partial unique index can't reject the move —
  // renaming (never deleting) means a Default that holds work survives intact.
  const transferredProjects = sort(
    (
      await Promise.all(
        legacyOrgs.map((org) =>
          db
            .select({
              id: projects.id,
              organizationId: projects.organizationId,
              name: projects.name,
              domain: projects.domain,
              archivedAt: projects.archivedAt,
            })
            .from(projects)
            .where(eq(projects.organizationId, org.id)),
        ),
      )
    ).flat(),
    (a, b) => a.id.localeCompare(b.id),
  );
  const conflictingDefaults = transferredProjects.filter(
    (project) =>
      project.name === "Default" &&
      project.domain === null &&
      project.archivedAt === null,
  );

  // Earliest-wins merge of activation milestones across the shared row and
  // all legacy rows.
  const activationRows = (
    await Promise.all(
      chunk([SHARED_WORKSPACE_ORGANIZATION_ID, ...legacyIds], 50).map((ids) =>
        db
          .select()
          .from(organizationActivationState)
          .where(inArray(organizationActivationState.organizationId, ids)),
      ),
    )
  ).flat();
  const mergedActivation = {
    firstMcpAuthorizedAt: earliest(
      activationRows.map((row) => row.firstMcpAuthorizedAt),
    ),
    firstMcpToolCallAt: earliest(
      activationRows.map((row) => row.firstMcpToolCallAt),
    ),
  };

  const repointToShared = { organizationId: SHARED_WORKSPACE_ORGANIZATION_ID };

  await runBatch((tx) => [
    ...legacyIds.map((id) => lockAuthorityOrganization(tx, id)),
    // Fail atomically under the organization locks before transferring uncertain work.
    ...legacyIds.map((id) =>
      tx
        .update(organization)
        .set({ name: sql`null` })
        .where(
          and(
            eq(organization.id, id),
            sql`exists (select 1 from audit_schedule_attempts a where a.organization_id = ${id} and (a.launch_state in ('pending','launching','running') or a.billing_state <> 'settled'))`,
          ),
        ),
    ),
    ...transferredProjects.map((project) =>
      lockProject(tx, project.id, project.organizationId),
    ),
    ...transferredProjects.map((project) =>
      bumpContentContext(
        tx,
        project.id,
        sql`p.organization_id = ${project.organizationId}`,
      ),
    ),
    ...transferredProjects.flatMap((project) =>
      invalidateSiteAuthority(tx, project.id, project.organizationId, {
        reason: "organization_changed",
        nowMs: Date.now(),
      }),
    ),
    ...transferredProjects.flatMap((project) =>
      invalidateAuditSchedule(tx, project.id, project.organizationId, {
        reason: "organization_changed",
        nowMs: Date.now(),
      }),
    ),
    ...transferredProjects.flatMap((project) => [
      tx
        .update(auditSchedules)
        .set(repointToShared)
        .where(
          and(
            eq(auditSchedules.projectId, project.id),
            eq(auditSchedules.organizationId, project.organizationId),
            eq(auditSchedules.state, "paused"),
            sql`exists (select 1 from projects p where p.id = ${project.id} and p.organization_id = ${project.organizationId})`,
          ),
        ),
      tx
        .update(auditScheduleAttempts)
        .set(repointToShared)
        .where(
          and(
            eq(auditScheduleAttempts.projectId, project.id),
            eq(auditScheduleAttempts.organizationId, project.organizationId),
            eq(auditScheduleAttempts.billingState, "settled"),
            sql`${auditScheduleAttempts.launchState} not in ('pending','launching','running') and exists (select 1 from projects p where p.id = ${project.id} and p.organization_id = ${project.organizationId})`,
          ),
        ),
    ]),
    ...conflictingDefaults.map((project) =>
      tx
        .update(projects)
        .set({
          name: `Default (${ownerLabelByOrgId.get(project.organizationId) ?? "imported"})`,
        })
        .where(
          and(
            eq(projects.id, project.id),
            eq(projects.organizationId, project.organizationId),
            eq(projects.name, "Default"),
            isNull(projects.domain),
            isNull(projects.archivedAt),
          ),
        ),
    ),
    ...transferredProjects.map((project) =>
      tx
        .update(projects)
        .set(repointToShared)
        .where(
          and(
            eq(projects.id, project.id),
            eq(projects.organizationId, project.organizationId),
          ),
        ),
    ),
    // A project created before the organization locks aborts the entire captured merge.
    ...legacyIds.map((id) =>
      tx
        .update(organization)
        .set({ name: sql`null` })
        .where(
          and(
            eq(organization.id, id),
            sql`exists (select 1 from ${projects} where ${projects.organizationId} = ${id})`,
          ),
        ),
    ),
    ...legacyIds.flatMap((id) => [
      tx
        .update(userOnboardingAnswers)
        .set(repointToShared)
        .where(eq(userOnboardingAnswers.organizationId, id)),
      tx
        .update(gscConnections)
        .set(repointToShared)
        .where(eq(gscConnections.organizationId, id)),
      tx
        .update(ga4Connections)
        .set(repointToShared)
        .where(eq(ga4Connections.organizationId, id)),
    ]),
    ...(activationRows.length > 0
      ? [
          tx
            .insert(organizationActivationState)
            .values({
              organizationId: SHARED_WORKSPACE_ORGANIZATION_ID,
              ...mergedActivation,
            })
            .onConflictDoUpdate({
              target: organizationActivationState.organizationId,
              set: mergedActivation,
            }),
        ]
      : []),
    // Everything user-visible is repointed above; deleting the legacy orgs
    // cascades away only the per-org leftovers (members, billing status,
    // legacy activation rows).
    ...legacyIds.map((id) =>
      tx
        .delete(organization)
        .where(
          and(
            eq(organization.id, id),
            sql`not exists (select 1 from ${projects} where ${projects.organizationId} = ${id})`,
          ),
        ),
    ),
  ]);

  return { mergedWorkspaces: legacyOrgs.length };
}

export const WorkspaceMergeService = {
  countLegacyWorkspaces,
  mergeLegacyWorkspaces,
} as const;
