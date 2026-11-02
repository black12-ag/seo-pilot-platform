import { ContentRepository } from "@/server/features/content/repositories/ContentRepository";
import { ContentEvidenceRepository } from "@/server/features/content/repositories/ContentEvidenceRepository";
import { AppError } from "@/server/lib/errors";
import {
  getContentRevisionInputSchema,
  type ContentActor,
  type GetContentRevisionInput,
} from "@/types/schemas/content";
import { contentAccess } from "./contentAccess";
import { contentContextSnapshot } from "./contentContextSnapshot";
import { ContentSourceService } from "./ContentSourceService";

export async function getRevision(
  actor: ContentActor,
  raw: GetContentRevisionInput,
) {
  const input = getContentRevisionInputSchema.parse(raw);
  await contentAccess(actor, input.projectId);
  const item = await ContentRepository.getItemStatus(
    actor.organizationId,
    input.projectId,
    input.contentId,
  );
  if (!item) throw new AppError("NOT_FOUND");
  const revision = await ContentRepository.getRevision(
    actor.organizationId,
    input.projectId,
    input.contentId,
    input.revisionId,
  );
  if (!revision) {
    const status = await ContentRepository.getRevisionStatus(
      actor.organizationId,
      input.projectId,
      input.contentId,
      input.revisionId,
    );
    if (status && status.redactedAtMs !== null)
      throw new AppError("CONFLICT", "revision_erased");
    throw new AppError("NOT_FOUND");
  }
  const checks = await ContentEvidenceRepository.getCurrentCheckSet(
    actor.organizationId,
    input.projectId,
    input.contentId,
    revision.id,
  );
  if (!checks) throw new AppError("CONFLICT", "check_set_unavailable");
  const live = await contentContextSnapshot(
    actor.organizationId,
    input.projectId,
    input.locale ?? revision.brief.locale,
  );
  const sources = await Promise.all(
    revision.sourceIds.map(async (sourceId) => {
      try {
        return {
          sourceId,
          state: "available" as const,
          source: await ContentSourceService.get(
            actor,
            input.projectId,
            sourceId,
          ),
        };
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === "CONFLICT" &&
          error.message === "source_unavailable"
        )
          return { sourceId, state: "unavailable" as const, source: null };
        throw error;
      }
    }),
  );
  await contentAccess(actor, input.projectId);
  return {
    revision,
    item,
    checks,
    sources,
    currentContextVersion: live.contextVersion,
    currentContextSnapshot: live.snapshot,
  };
}

export async function getRevisionStatus(
  actor: ContentActor,
  raw: GetContentRevisionInput,
) {
  const input = getContentRevisionInputSchema.parse(raw);
  await contentAccess(actor, input.projectId);
  const status = await ContentRepository.getRevisionStatus(
    actor.organizationId,
    input.projectId,
    input.contentId,
    input.revisionId,
  );
  await contentAccess(actor, input.projectId);
  if (!status) throw new AppError("NOT_FOUND");
  return {
    id: status.id,
    version: status.version,
    state:
      status.redactedAtMs === null
        ? ("available" as const)
        : ("privacy_erased" as const),
  };
}
