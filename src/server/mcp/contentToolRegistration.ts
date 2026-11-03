import {
  getContentRevisionTool,
  exportContentRevisionTool,
} from "@/server/mcp/tools/content-read-tools";
import {
  archiveContentTool,
  listContentTool,
  captureContentSourceTool,
  createContentBriefTool,
  saveContentRevisionTool,
} from "@/server/mcp/tools/content-tools";
import {
  getContentReviewTool,
  requestContentReviewTool,
} from "@/server/mcp/tools/content-review-tools";
import { captureContentUrlsTool } from "@/server/mcp/tools/content-url-tools";
import type { OpenSeoToolDefinition, ToolSchema } from "./server";

export function registerContentTools(
  register: <Input extends ToolSchema>(
    tool: OpenSeoToolDefinition<Input>,
  ) => void,
) {
  register(captureContentSourceTool("mcp"));
  register(captureContentUrlsTool("mcp"));
  register(archiveContentTool("mcp"));
  register(listContentTool("mcp"));
  register(getContentRevisionTool("mcp"));
  register(exportContentRevisionTool("mcp"));
  register(getContentReviewTool("mcp"));
  register(requestContentReviewTool("mcp"));
  register(createContentBriefTool("mcp"));
  register(saveContentRevisionTool("mcp"));
}
