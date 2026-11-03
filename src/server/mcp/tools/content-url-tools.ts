import { z } from "zod";
import { ContentSourceService } from "@/server/features/content/services/ContentSourceService";
import { mcpResponse } from "@/server/mcp/formatters";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  CONTENT_URL_SOURCE_LIMIT,
  contentUrlCaptureOutcomeSchema,
  captureContentUrlsInputSchema,
  captureContentUrlsResultSchema,
} from "@/types/schemas/contentSourceIntake";
import { contentToolActor } from "./content-tools";

const outputSchema = captureContentUrlsResultSchema.loose().extend({
  outcomes: z
    .array(
      z.discriminatedUnion("state", [
        contentUrlCaptureOutcomeSchema.options[0].loose().extend({
          urlCapture:
            contentUrlCaptureOutcomeSchema.options[0].shape.urlCapture.loose(),
        }),
        contentUrlCaptureOutcomeSchema.options[1].loose(),
      ]),
    )
    .min(1)
    .max(CONTENT_URL_SOURCE_LIMIT),
});

export function captureContentUrlsTool(surface: "mcp" | "sam") {
  return {
    name: "capture_content_urls",
    config: {
      title: "Capture public content URLs",
      description:
        "Explicitly capture up to five public URLs with a separate mutation ID per URL. Returns bounded outcomes without source text; replaying a receipt does not guarantee an HTTP request occurred exactly once.",
      inputSchema: captureContentUrlsInputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    handler: withMcpProjectAuth(
      async (args: z.infer<typeof captureContentUrlsInputSchema>, context) => {
        const result = captureContentUrlsResultSchema.parse(
          await ContentSourceService.captureUrls(
            contentToolActor(context.auth, surface),
            args,
          ),
        );
        return mcpResponse({
          text: `Captured ${result.outcomes.length} URL outcomes. No content was approved.`,
          structuredContent: result,
        });
      },
    ),
  };
}
