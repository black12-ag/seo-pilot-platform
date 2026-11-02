import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import { usesBetterAuthServer } from "@/server/lib/runtime-env";
import type { ToolAuthContext } from "@/server/mcp/context";
import type { AuthorityScope } from "../repositories/SiteAuthorityRepository";

export type AuthorityActor = Pick<
  ToolAuthContext,
  "organizationId" | "userId" | "role"
>;

/** Context comes from authenticated middleware, never the request body. */
export async function siteAuthorityAccess(
  actor: AuthorityActor,
  projectId: string,
  manage = false,
) {
  if (!actor.userId || !actor.organizationId) {
    throw new AppError("UNAUTHENTICATED");
  }
  const requireMembership = await usesBetterAuthServer();
  let role = actor.role;
  if (requireMembership) {
    const membership = await AuthRepository.getMembership(
      actor.userId,
      actor.organizationId,
    );
    if (!membership) throw new AppError("FORBIDDEN");
    role = membership.role;
  }
  const project = await ProjectRepository.getProjectForOrganization(
    projectId,
    actor.organizationId,
  );
  if (!project) throw new AppError("NOT_FOUND");
  if (manage) requireOrgPermission({ role }, { integration: ["manage"] });
  const scope: AuthorityScope = {
    organizationId: actor.organizationId,
    userId: actor.userId,
    role,
    requireMembership,
  };
  return {
    scope,
    project,
    canManage: hasOrgPermission(role, { integration: ["manage"] }),
  };
}
