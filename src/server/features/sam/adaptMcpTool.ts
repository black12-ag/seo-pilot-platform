import { tool, type Tool } from "ai";
import { z, type ZodRawShape } from "zod";
import { withPgClient } from "@/db";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolContext } from "@/server/mcp/context";
import { instrumentMcpToolHandler } from "@/server/mcp/instrumentation";
import { capToolOutput } from "./samToolOutput";

// Shape of the MCP tool objects exported from src/server/mcp/tools/*. SAM reuses
// the exact same definitions the MCP server registers, so the in-app agent and
// the MCP server can never drift in what a tool does or how it bills.
export type McpToolDefinition<Shape extends ZodRawShape> = {
  name: string;
  config: { description: string; inputSchema: Shape };
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    context: ToolContext,
  ) => Promise<CallToolResult>;
};

// Flatten an MCP CallToolResult into a plain value for the model. The text
// block renders the same rows the structured data carries (see
// tool-text-output.test.ts), so when both exist only the head of the text
// survives — the title line and any caveat, not a second copy of every row.
// A tool result is re-sent on every step of its turn and persisted in the
// transcript, so the duplicate would cost twice everywhere.
const SUMMARY_HEAD_CHARS = 300;

export function toModelOutput(result: CallToolResult): {
  summary: string;
  data?: CallToolResult["structuredContent"];
} {
  const text = (result.content ?? [])
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  const data = result.structuredContent;
  // A text-only response still gets a `{ meta }` structuredContent when it
  // carries a deep link; that is not a second copy of the text.
  const dataHasRows =
    data != null && Object.keys(data).some((key) => key !== "meta");
  if (!dataHasRows) return data ? { summary: text, data } : { summary: text };
  const summary =
    text.length > SUMMARY_HEAD_CHARS
      ? `${text.slice(0, SUMMARY_HEAD_CHARS)}… (full rows in data)`
      : text;
  return { summary, data };
}

// Bind the session project before shared validation; model arguments never establish scope.
export function adaptSchemaMcpTool<Input extends z.ZodType>(
  def: {
    name: string;
    config: {
      description: string;
      inputSchema: Input;
      outputSchema?: z.ZodType;
    };
    handler: (
      args: z.output<Input>,
      context: ToolContext,
    ) => Promise<CallToolResult>;
  },
  modelSchema: z.ZodType<Record<string, unknown>>,
  context: ToolContext,
  projectId?: string,
): Tool {
  const handler = instrumentMcpToolHandler(
    def.name,
    def.config.outputSchema,
    def.handler,
  );
  return tool({
    description: def.config.description,
    inputSchema: modelSchema,
    execute: async (args) => {
      try {
        const fullArgs = def.config.inputSchema.parse(
          projectId === undefined ? args : { ...args, projectId },
        );
        // Inference callbacks do not inherit a request-scoped Postgres client.
        return capToolOutput(
          toModelOutput(await withPgClient(() => handler(fullArgs, context))),
        );
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

export function adaptMcpTool<Shape extends ZodRawShape>(
  def: McpToolDefinition<Shape>,
  context: ToolContext,
  projectId: string,
): Tool {
  const { projectId: _projectIdSchema, ...modelShape } = def.config.inputSchema;
  const bindsProject = "projectId" in def.config.inputSchema;
  return adaptSchemaMcpTool(
    {
      ...def,
      config: { ...def.config, inputSchema: z.object(def.config.inputSchema) },
    },
    z.object(bindsProject ? modelShape : def.config.inputSchema),
    context,
    bindsProject ? projectId : undefined,
  );
}
