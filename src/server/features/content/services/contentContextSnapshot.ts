import { sort } from "remeda";
import { ContentRepository } from "@/server/features/content/repositories/ContentRepository";
import { getProjectContext } from "@/server/features/project-context/services/ProjectContextService";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { sha256Hex } from "@/server/lib/audit/ids";
import { AppError } from "@/server/lib/errors";
import type { ContentLocale } from "@/types/schemas/content";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function contentContextSnapshot(
  organizationId: string,
  projectId: string,
  locale: ContentLocale,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const version = await ContentRepository.getContextVersion(
      organizationId,
      projectId,
    );
    if (version === null) throw new AppError("NOT_FOUND");
    const [project, context] = await Promise.all([
      ProjectRepository.getProjectForOrganization(projectId, organizationId),
      getProjectContext(projectId),
    ]);
    const after = await ContentRepository.getContextVersion(
      organizationId,
      projectId,
    );
    if (after === null || !project) throw new AppError("NOT_FOUND");
    if (version !== after) continue;
    const snapshot = {
      project: {
        name: project.name,
        domain: project.domain,
        locationCode: project.locationCode,
        languageCode: project.languageCode,
      },
      locale,
      sections: sort(context.sections, (a, b) => compare(a.key, b.key)),
      customSections: sort(context.customSections, (a, b) =>
        compare(a.slug, b.slug),
      ),
      competitors: sort(context.competitors, (a, b) => compare(a.id, b.id)),
      keyPages: sort(context.keyPages, (a, b) => compare(a.id, b.id)),
    };
    return {
      snapshot,
      contextVersion: version,
      contextHash: await sha256Hex(JSON.stringify(snapshot)),
    };
  }
  throw new AppError("CONFLICT", "context_changed");
}
