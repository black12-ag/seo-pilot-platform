import { z } from "zod";
import { ContentService } from "@/server/features/content/services/ContentService";
import { ContentSourceService } from "@/server/features/content/services/ContentSourceService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  captureContentSourceInputSchema,
  savedContentSourceSchema,
} from "@/types/schemas/contentEvidence";
import {
  archiveContentInputSchema,
  contentItemPageSchema,
  listContentInputSchema,
  savedContentItemSchema,
  createContentBriefInputSchema,
  saveContentRevisionInputSchema,
} from "@/types/schemas/content";

export function contentToolActor(
  auth: { userId: string; organizationId: string; role: string },
  surface: "mcp" | "sam",
) {
  return {
    userId: auth.userId,
    organizationId: auth.organizationId,
    role: auth.role,
    surface,
  };
}

const mutationOutput = z
  .object({
    ok: z.boolean(),
    contentId: z.string().optional(),
    revisionId: z.string().optional(),
    headVersion: z.number().optional(),
    code: z.string().optional(),
    currentHeadVersion: z.number().optional(),
    ...optionalMetaOutputSchema,
  })
  .loose();
const writeAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

export function listContentTool(surface: "mcp" | "sam") {
  return {
    name: "list_content",
    config: {
      title: "List content",
      description:
        "List a bounded page of project content. States are recorded review workflow states, not current publication eligibility.",
      inputSchema: listContentInputSchema,
      outputSchema: contentItemPageSchema
        .extend({
          items: z.array(savedContentItemSchema.loose()),
          ...optionalMetaOutputSchema,
        })
        .loose(),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    handler: withMcpProjectAuth(
      async (args: z.infer<typeof listContentInputSchema>, context) => {
        const result = await ContentService.list(
          contentToolActor(context.auth, surface),
          args,
        );
        return mcpResponse({
          text: `${result.items.length} content records in this page; recorded review states do not establish current eligibility.`,
          structuredContent: result,
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/content`,
          ),
        });
      },
    ),
  };
}

export function archiveContentTool(surface: "mcp" | "sam") {
  return {
    name: "archive_content",
    config: {
      title: "Archive content",
      description:
        "Archive content at the expected head version only on explicit request. History is retained; archiving does not publish or delete it.",
      inputSchema: archiveContentInputSchema,
      outputSchema: z
        .object({
          ok: z.boolean(),
          contentId: z.string(),
          replayed: z.boolean(),
          ...optionalMetaOutputSchema,
        })
        .loose(),
      annotations: { ...writeAnnotations, destructiveHint: true },
    },
    handler: withMcpProjectAuth(
      async (args: z.infer<typeof archiveContentInputSchema>, context) => {
        const result = await ContentService.archive(
          contentToolActor(context.auth, surface),
          args,
        );
        return mcpResponse({
          text: `Content ${result.contentId} archived; history is retained.`,
          structuredContent: result,
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/content`,
          ),
        });
      },
    ),
  };
}

export function createContentBriefTool(surface: "mcp" | "sam") {
  return {
    name: "create_content_brief",
    config: {
      title: "Create content brief",
      description:
        "Save a manual brief without generating or publishing content.",
      inputSchema: createContentBriefInputSchema,
      outputSchema: mutationOutput,
      annotations: writeAnnotations,
    },
    handler: withMcpProjectAuth(
      async (args: z.infer<typeof createContentBriefInputSchema>, context) => {
        const result = await ContentService.createBrief(
          contentToolActor(context.auth, surface),
          args,
        );
        const summary = result.ok
          ? {
              ok: true,
              contentId: result.revision.contentId,
              revisionId: result.revision.id,
              headVersion: result.headVersion,
            }
          : result;
        return mcpResponse({
          text: result.ok
            ? `Brief saved as revision ${result.revision.id}.`
            : `Conflict: current version ${result.currentHeadVersion}.`,
          structuredContent: summary,
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/content`,
          ),
        });
      },
    ),
  };
}

export function saveContentRevisionTool(surface: "mcp" | "sam") {
  return {
    name: "save_content_revision",
    config: {
      title: "Save content revision",
      description:
        "Save a complete manual revision with expected head and context versions. A conflict leaves the caller's draft unchanged; this does not approve or publish.",
      inputSchema: saveContentRevisionInputSchema,
      outputSchema: mutationOutput,
      annotations: writeAnnotations,
    },
    handler: withMcpProjectAuth(
      async (args: z.infer<typeof saveContentRevisionInputSchema>, context) => {
        const result = await ContentService.saveRevision(
          contentToolActor(context.auth, surface),
          args,
        );
        const summary = result.ok
          ? {
              ok: true,
              contentId: result.revision.contentId,
              revisionId: result.revision.id,
              headVersion: result.headVersion,
            }
          : result;
        return mcpResponse({
          text: result.ok
            ? `Saved revision ${result.revision.id}; it is not approved.`
            : `Conflict: current version ${result.currentHeadVersion}; keep your draft.`,
          structuredContent: summary,
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/content`,
          ),
        });
      },
    ),
  };
}

export function captureContentSourceTool(surface: "mcp" | "sam") {
  return {
    name: "capture_content_source",
    config: {
      title: "Capture content source",
      description:
        "Capture attributed pasted text or an existing project audit observation. The response omits source text; this records evidence without creating a draft or approving content.",
      inputSchema: captureContentSourceInputSchema,
      outputSchema: z
        .object({
          source: savedContentSourceSchema
            .pick({
              id: true,
              projectId: true,
              kind: true,
              title: true,
              extractionStatus: true,
            })
            .loose(),
          replayed: z.boolean(),
          ...optionalMetaOutputSchema,
        })
        .loose(),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    handler: withMcpProjectAuth(
      async (
        args: z.infer<typeof captureContentSourceInputSchema>,
        context,
      ) => {
        const result = await ContentSourceService.capture(
          {
            userId: context.auth.userId,
            organizationId: context.auth.organizationId,
            role: context.auth.role,
            surface,
          },
          args,
        );
        const { sourceText: _sourceText, ...source } = result.source;
        return mcpResponse({
          text: `Source ${source.id} captured with status ${source.extractionStatus}. No content was approved.`,
          structuredContent: { source, replayed: result.replayed },
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/content`,
          ),
        });
      },
    ),
  };
}
