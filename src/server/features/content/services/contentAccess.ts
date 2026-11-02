import { hasOrgPermission } from "@/lib/org-permissions";
import { ContentRepository } from "@/server/features/content/repositories/ContentRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import { usesBetterAuthServer } from "@/server/lib/runtime-env";
import type { ContentActor } from "@/types/schemas/content";

export async function contentAccess(actor: ContentActor, projectId: string) {
  if (!actor.userId || !actor.organizationId)
    throw new AppError("UNAUTHENTICATED");
  const requireMembership = await usesBetterAuthServer();
  const membership = requireMembership
    ? await ContentRepository.getMembership(actor.organizationId, actor.userId)
    : null;
  if (requireMembership && !membership) throw new AppError("FORBIDDEN");
  const project = await ProjectRepository.getProjectForOrganization(
    projectId,
    actor.organizationId,
  );
  if (!project) throw new AppError("NOT_FOUND");
  const role = membership?.role ?? actor.role;
  return {
    project,
    membership,
    scope: { ...actor, role, requireMembership },
    canReview:
      actor.surface === "web" &&
      membership !== null &&
      hasOrgPermission(role, { content: ["review"] }),
  };
}
