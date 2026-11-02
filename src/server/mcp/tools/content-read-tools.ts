import { z } from "zod";
import { ContentService } from "@/server/features/content/services/ContentService";
import { ContentExportService } from "@/server/features/content/services/contentExport";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { buildDashboardUrl } from "@/server/mcp/urls";
import {
  getContentRevisionInputSchema,
  exportContentRevisionInputSchema,
} from "@/types/schemas/content";
import { contentToolActor } from "./content-tools";

function downloadUrl(
  baseUrl: string,
  input: {
    projectId: string;
    contentId: string;
    revisionId: string;
    format: "markdown" | "json";
  },
) {
  const path = `/api/content/${encodeURIComponent(input.projectId)}/${encodeURIComponent(input.contentId)}/${encodeURIComponent(input.revisionId)}/export`;
  return buildDashboardUrl(baseUrl, path, { format: input.format });
}
const readAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
};
const previewOutput = z
  .object({
    revisionId: z.string(),
    contentId: z.string(),
    state: z.enum(["available", "privacy_erased"]),
    preview: z.string().optional(),
    complete: z.literal(false),
    truncated: z.boolean(),
    downloadUrl: z.string().optional(),
    ...optionalMetaOutputSchema,
  })
  .loose();

export function getContentRevisionTool(surface: "mcp" | "sam") {
  return {
    name: "get_content_revision",
    config: {
      title: "Get content revision",
      description:
        "Read a bounded preview of a saved revision. This is incomplete and cannot be saved as a full revision; use the authenticated complete download for all content and evidence.",
      inputSchema: getContentRevisionInputSchema,
      outputSchema: previewOutput,
      annotations: readAnnotations,
    },
    handler: withMcpProjectAuth(
      async (args: z.infer<typeof getContentRevisionInputSchema>, context) => {
        const status = await ContentService.getRevisionStatus(
          contentToolActor(context.auth, surface),
          args,
        );
        if (status.state === "privacy_erased")
          return mcpResponse({
            text: "This revision was privacy erased and is unavailable.",
            structuredContent: {
              contentId: args.contentId,
              revisionId: status.id,
              state: "privacy_erased",
              complete: false,
              truncated: true,
            },
            meta: buildProjectMeta(
              context,
              args.projectId,
              `/p/${args.projectId}/content`,
            ),
          });
        const result = await ContentService.getRevision(
          contentToolActor(context.auth, surface),
          args,
        );
        const chars = Array.from(result.revision.markdown);
        const url = downloadUrl(context.baseUrl, {
          projectId: args.projectId,
          contentId: args.contentId,
          revisionId: result.revision.id,
          format: "json",
        });
        const preview = chars.slice(0, 2000).join("");
        return mcpResponse({
          text: `Revision ${result.revision.id}: incomplete preview; authenticated complete download: ${url}`,
          structuredContent: {
            contentId: args.contentId,
            revisionId: result.revision.id,
            state: "available" as const,
            version: result.revision.version,
            metadata: {
              title: result.revision.metadata.title,
              slug: result.revision.metadata.slug,
              description: result.revision.metadata.description,
            },
            sources: result.sources.map(({ sourceId, state }) => ({
              sourceId,
              state,
            })),
            checkSetId: result.checks.id,
            checkCount: result.checks.checks.length,
            preview,
            truncated: true,
            bodyTruncated: chars.length > 2000,
            complete: false as const,
            downloadUrl: url,
          },
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/content/${encodeURIComponent(args.contentId)}`,
          ),
        });
      },
    ),
  };
}

export function exportContentRevisionTool(surface: "mcp" | "sam") {
  return {
    name: "export_content_revision",
    config: {
      title: "Export content revision",
      description:
        "Preview a saved revision export and obtain its authenticated complete download. The preview is incomplete and cannot be used as a complete saved revision.",
      inputSchema: exportContentRevisionInputSchema,
      outputSchema: previewOutput,
      annotations: readAnnotations,
    },
    handler: withMcpProjectAuth(
      async (
        args: z.infer<typeof exportContentRevisionInputSchema>,
        context,
      ) => {
        const status = await ContentService.getRevisionStatus(
          contentToolActor(context.auth, surface),
          {
            projectId: args.projectId,
            contentId: args.contentId,
            revisionId: args.revisionId,
          },
        );
        if (status.state === "privacy_erased")
          return mcpResponse({
            text: "This revision was privacy erased and cannot be exported.",
            structuredContent: {
              contentId: args.contentId,
              revisionId: status.id,
              state: "privacy_erased",
              complete: false,
              truncated: true,
            },
            meta: buildProjectMeta(
              context,
              args.projectId,
              `/p/${args.projectId}/content`,
            ),
          });
        const artifact = await ContentExportService.exportRevision(
          contentToolActor(context.auth, surface),
          args,
        );
        const chars = Array.from(artifact.content);
        const url = downloadUrl(context.baseUrl, args);
        return mcpResponse({
          text: `Incomplete export preview; authenticated complete download: ${url}. The download response headers report the actual downloaded byte count and SHA-256.`,
          structuredContent: {
            contentId: args.contentId,
            revisionId: args.revisionId,
            state: "available" as const,
            preview: chars.slice(0, 2000).join(""),
            truncated: chars.length > 2000,
            complete: false as const,
            downloadUrl: url,
            previewArtifactBytes: artifact.bytes,
            previewArtifactSha256: artifact.sha256,
            manifest: artifact.manifest,
          },
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/content/${encodeURIComponent(args.contentId)}`,
          ),
        });
      },
    ),
  };
}
