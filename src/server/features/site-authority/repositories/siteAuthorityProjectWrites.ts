import { and, eq, sql, type SQL } from "drizzle-orm";
import { getDatabaseProvider } from "@/db/provider";
import { hasOrgPermission } from "@/lib/org-permissions";
import type { runBatch } from "@/db/runBatch";
import {
  organization,
  projects,
  projectSiteAuthority as authority,
  siteAuthorityChallenges as challenges,
} from "@/db/schema";
import type { RevocationReason } from "@/types/schemas/siteAuthority";

export type AuthorityScope = {
  organizationId: string;
  userId: string;
  role: string;
  requireMembership: boolean;
};
type AuthorityTx = Parameters<Parameters<typeof runBatch>[0]>[0];

// Every terminal statement repeats this guard; the first lock is not authorization.
export function authorityScope(
  scope: AuthorityScope,
  projectId: string,
  manage = true,
): SQL {
  return sql`exists (select 1 from projects p where p.id = ${projectId}
    and p.organization_id = ${scope.organizationId} and p.archived_at is null
    ${manage ? sql`and ${hasOrgPermission(scope.role, { integration: ["manage"] }) ? 1 : 0} = 1` : sql``}
    ${scope.requireMembership ? sql`and exists (select 1 from member m where m.organization_id = p.organization_id and m.user_id = ${scope.userId} and m.role = ${scope.role})` : sql``})`;
}

export function lockAuthorityProject(
  tx: AuthorityTx,
  scope: AuthorityScope,
  projectId: string,
) {
  return tx
    .update(projects)
    .set({ name: sql`${projects.name}` })
    .where(and(eq(projects.id, projectId), authorityScope(scope, projectId)));
}

export function lockProject(
  tx: AuthorityTx,
  projectId: string,
  organizationId: string,
) {
  return tx
    .update(projects)
    .set({ name: sql`${projects.name}` })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
      ),
    );
}

/** Organizations precede sorted project locks when transferring a workspace. */
export function lockAuthorityOrganization(
  tx: AuthorityTx,
  organizationId: string,
) {
  if (getDatabaseProvider() === "postgres") {
    const query = tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this branch runs only on the actual PG transaction builder
    const lockingQuery = query as unknown as {
      for(mode: "update"): Promise<unknown>;
    };
    return lockingQuery.for("update");
  }
  return tx
    .update(organization)
    .set({ name: sql`${organization.name}` })
    .where(eq(organization.id, organizationId));
}

/** Caller locks the project first, before comparing the old domain or repointing it. */
export function invalidateSiteAuthority(
  tx: AuthorityTx,
  projectId: string,
  organizationId: string,
  {
    reason,
    nowMs,
    condition = sql`true`,
  }: { reason: RevocationReason; nowMs: number; condition?: SQL },
) {
  const ownsProject = sql`exists (select 1 from projects p where p.id = ${projectId} and p.organization_id = ${organizationId} and ${condition})`;
  return [
    tx
      .update(challenges)
      .set({
        status: reason === "website_changed" ? "superseded" : "revoked",
        claimToken: null,
        claimUntilMs: null,
      })
      .where(
        and(
          eq(challenges.projectId, projectId),
          sql`${challenges.status} in ('pending','checking')`,
          ownsProject,
        ),
      ),
    tx
      .update(authority)
      .set({
        version: sql`${authority.version} + 1`,
        status: "revoked",
        currentChallengeId: null,
        completionClaimToken: null,
        verifiedAtMs: null,
        verifiedUntilMs: null,
        revocationReason: reason,
        updatedAtMs: nowMs,
      })
      .where(and(eq(authority.projectId, projectId), ownsProject)),
  ];
}
