import { hasOrgPermission } from "@/lib/org-permissions";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import { usesBetterAuthServer } from "@/server/lib/runtime-env";

export type AuditScheduleActor = {
  organizationId: string;
  userId: string;
  role: string;
};
export type AuditScheduleScope = AuditScheduleActor & {
  requireMembership: boolean;
};

export async function auditScheduleAccess(
  actor: AuditScheduleActor,
  projectId: string,
  manage = false,
) {
  if (!actor.userId || !actor.organizationId)
    throw new AppError("UNAUTHENTICATED");
  const requireMembership = await usesBetterAuthServer();
  const membership = requireMembership
    ? await AuthRepository.getMembership(actor.userId, actor.organizationId)
    : null;
  if (requireMembership && !membership) throw new AppError("FORBIDDEN");
  const role = membership?.role ?? actor.role;
  const project =
    (await ProjectRepository.getProjectForOrganization(
      projectId,
      actor.organizationId,
    )) ??
    (await ProjectRepository.getArchivedProjectForOrganization(
      projectId,
      actor.organizationId,
    ));
  if (!project) throw new AppError("NOT_FOUND");
  const canManage = hasOrgPermission(role, { billing: ["manage"] });
  if (manage && !canManage) throw new AppError("FORBIDDEN", "owner_required");
  const scope: AuditScheduleScope = { ...actor, role, requireMembership };
  return {
    scope,
    project,
    canManage,
    backgroundAuthoritySupported: requireMembership,
  };
}
