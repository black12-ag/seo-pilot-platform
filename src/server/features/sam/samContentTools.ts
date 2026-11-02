import {
  getContentRevisionTool,
  exportContentRevisionTool,
} from "@/server/mcp/tools/content-read-tools";
import type { ToolContext } from "@/server/mcp/context";
import {
  archiveContentTool,
  listContentTool,
  captureContentSourceTool,
  createContentBriefTool,
  saveContentRevisionTool,
} from "@/server/mcp/tools/content-tools";
import { adaptSchemaMcpTool } from "./adaptMcpTool";
import {
  getContentReviewTool,
  requestContentReviewTool,
} from "@/server/mcp/tools/content-review-tools";

export function contentTools(context: ToolContext, projectId: string) {
  const capture = captureContentSourceTool("sam");
  const create = createContentBriefTool("sam");
  const save = saveContentRevisionTool("sam");
  const archive = archiveContentTool("sam");
  const list = listContentTool("sam");
  const getRevision = getContentRevisionTool("sam");
  const exportRevision = exportContentRevisionTool("sam");
  const getReview = getContentReviewTool("sam");
  const requestReview = requestContentReviewTool("sam");
  return {
    get_content_revision: adaptSchemaMcpTool(
      getRevision,
      getRevision.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    export_content_revision: adaptSchemaMcpTool(
      exportRevision,
      exportRevision.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    list_content: adaptSchemaMcpTool(
      list,
      list.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    get_content_review: adaptSchemaMcpTool(
      getReview,
      getReview.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    request_content_review: adaptSchemaMcpTool(
      requestReview,
      requestReview.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    archive_content: adaptSchemaMcpTool(
      archive,
      archive.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    create_content_brief: adaptSchemaMcpTool(
      create,
      create.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    save_content_revision: adaptSchemaMcpTool(
      save,
      save.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    capture_content_source: adaptSchemaMcpTool(
      capture,
      capture.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
  };
}
