import { createServerFn } from "@tanstack/react-start";
import { ContentService } from "@/server/features/content/services/ContentService";
import { ContentSourceService } from "@/server/features/content/services/ContentSourceService";
import { AppError } from "@/server/lib/errors";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  createContentBriefInputSchema,
  archiveContentInputSchema,
  getContentRevisionInputSchema,
  listContentRevisionsInputSchema,
  listContentInputSchema,
  listContentSourcesInputSchema,
  saveContentRevisionInputSchema,
} from "@/types/schemas/content";
import { captureContentSourceInputSchema } from "@/types/schemas/contentEvidence";

function webActor(
  context: {
    userId: string;
    organizationId: string;
    role: string;
    projectId: string;
  },
  projectId: string,
) {
  if (projectId !== context.projectId) throw new AppError("NOT_FOUND");
  return {
    userId: context.userId,
    organizationId: context.organizationId,
    role: context.role,
    surface: "web" as const,
  };
}

export const captureContentSource = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(captureContentSourceInputSchema)
  .handler(async ({ context, data }) =>
    ContentSourceService.capture(webActor(context, data.projectId), data),
  );

export const getContentRevision = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(getContentRevisionInputSchema)
  .handler(async ({ context, data }) =>
    ContentService.getRevision(webActor(context, data.projectId), data),
  );

export const getContentRevisionStatus = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(getContentRevisionInputSchema)
  .handler(async ({ context, data }) =>
    ContentService.getRevisionStatus(webActor(context, data.projectId), data),
  );

export const createContentBrief = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createContentBriefInputSchema)
  .handler(async ({ context, data }) =>
    ContentService.createBrief(webActor(context, data.projectId), data),
  );

export const saveContentRevision = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(saveContentRevisionInputSchema)
  .handler(async ({ context, data }) =>
    ContentService.saveRevision(webActor(context, data.projectId), data),
  );

export const archiveContent = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(archiveContentInputSchema)
  .handler(async ({ context, data }) =>
    ContentService.archive(webActor(context, data.projectId), data),
  );

export const listContentRevisions = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(listContentRevisionsInputSchema)
  .handler(async ({ context, data }) =>
    ContentService.listRevisions(webActor(context, data.projectId), data),
  );

export const listContent = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(listContentInputSchema)
  .handler(async ({ context, data }) =>
    ContentService.list(webActor(context, data.projectId), data),
  );

export const listContentSources = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(listContentSourcesInputSchema)
  .handler(async ({ context, data }) =>
    ContentSourceService.list(webActor(context, data.projectId), data),
  );

export const getContentSource = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(
    getContentRevisionInputSchema
      .pick({ projectId: true })
      .extend({ sourceId: getContentRevisionInputSchema.shape.contentId }),
  )
  .handler(async ({ context, data }) =>
    ContentSourceService.get(
      webActor(context, data.projectId),
      data.projectId,
      data.sourceId,
    ),
  );
