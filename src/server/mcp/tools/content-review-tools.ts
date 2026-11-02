import { z } from "zod";
import { contentToolActor } from "./content-tools";
import { ContentReviewService } from "@/server/features/content/services/ContentReviewService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { buildDashboardUrl } from "@/server/mcp/urls";
import {
  getContentReviewInputSchema,
  requestContentReviewInputSchema,
  savedContentReviewSchema,
} from "@/types/schemas/contentReview";

const output = z
  .object({
    review: savedContentReviewSchema
      .pick({
        id: true,
        projectId: true,
        contentId: true,
        revisionId: true,
        state: true,
        version: true,
      })
      .loose()
      .nullable(),
    ...optionalMetaOutputSchema,
  })
  .loose();
export function getContentReviewTool(surface: "mcp" | "sam") {
  return {
    name: "get_content_review",
    config: {
      title: "Get content review",
      description:
        "Read a bounded review summary and open the authenticated human review page. Events are omitted; use the complete authenticated download. Recorded approval alone does not establish current publication eligibility.",
      inputSchema: getContentReviewInputSchema,
      outputSchema: output,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    handler: withMcpProjectAuth(
      async (args: z.infer<typeof getContentReviewInputSchema>, context) => {
        const review = await ContentReviewService.get(
          contentToolActor(context.auth, surface),
          args,
        );
        const { events: _events, ...summary } = review ?? {};
        const url = review
          ? buildDashboardUrl(
              context.baseUrl,
              `/api/content/${encodeURIComponent(args.projectId)}/${encodeURIComponent(args.contentId)}/${encodeURIComponent(review.revisionId)}/export`,
              { format: "json" },
            )
          : undefined;
        return mcpResponse({
          text: review
            ? `Review ${review.id}: ${review.state}. Current eligibility must be checked separately.`
            : "No review request found.",
          structuredContent: {
            review: review ? summary : null,
            eventsOmitted: Boolean(review),
            downloadUrl: url,
          },
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/content/review`,
            { contentId: args.contentId, requestId: review?.id },
          ),
        });
      },
    ),
  };
}
export function requestContentReviewTool(surface: "mcp" | "sam") {
  return {
    name: "request_content_review",
    config: {
      title: "Request content review",
      description:
        "Request a human review of the exact saved revision and check set, assigned to a current workspace member. This does not approve or publish content.",
      inputSchema: requestContentReviewInputSchema,
      outputSchema: output,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    handler: withMcpProjectAuth(
      async (
        args: z.infer<typeof requestContentReviewInputSchema>,
        context,
      ) => {
        const review = await ContentReviewService.request(
          contentToolActor(context.auth, surface),
          args,
        );
        const { events: _events, ...summary } = review;
        const url = buildDashboardUrl(
          context.baseUrl,
          `/api/content/${encodeURIComponent(args.projectId)}/${encodeURIComponent(args.contentId)}/${encodeURIComponent(review.revisionId)}/export`,
          { format: "json" },
        );
        return mcpResponse({
          text: `Human review requested for revision ${review.revisionId}; no approval was recorded.`,
          structuredContent: {
            review: summary,
            eventsOmitted: true,
            downloadUrl: url,
          },
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/content/review`,
            { contentId: args.contentId, requestId: review.id },
          ),
        });
      },
    ),
  };
}
