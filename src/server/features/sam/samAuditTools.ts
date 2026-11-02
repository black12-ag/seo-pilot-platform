import {
  getAuditScheduleTool,
  estimateAuditScheduleTool,
  saveAuditScheduleTool,
  listAuditAttemptsTool,
} from "@/server/mcp/tools/audit-schedule-tools";
import {
  getAuditEvidenceTool,
  compareAuditEvidenceTool,
  exportAuditEvidenceTool,
} from "@/server/mcp/tools/audit-evidence-tools";
import { z } from "zod";
import type { ToolContext } from "@/server/mcp/context";
import { adaptSchemaMcpTool } from "./adaptMcpTool";
import type { Tool } from "ai";
import { getAuditStatusTool } from "@/server/mcp/tools/site-audit-tools";
import type { McpToolDefinition } from "./adaptMcpTool";

// Audits run for minutes, and a chat model cannot sleep — given an instant
// status tool it spin-polls, and every call plus its result is persisted into
// the session history. SAM's get_audit_status therefore waits server-side:
// while the audit is running, it re-reads every few seconds and returns as
// soon as the status line changes (or when the budget runs out), so one tool
// call buys ~a minute of quiet waiting. The sleep sits BETWEEN adapted calls,
// so each re-read scopes its own short-lived DB client rather than holding one
// through the wait; each re-read also emits its own mcp:tool_call event, so
// telemetry counts server polls, not model calls.
const AUDIT_STATUS_POLL_MS = 2_000;
const AUDIT_STATUS_WAIT_BUDGET_MS = 50_000;

// The adapted tool returns toModelOutput's { summary, data } flattening; the
// summary line carries phase + page counts, so a changed line IS progress.
const auditProgressLine = (result: unknown): string | null =>
  typeof result === "object" &&
  result !== null &&
  "summary" in result &&
  typeof result.summary === "string"
    ? result.summary
    : null;

const auditIsRunning = (result: unknown): boolean => {
  if (typeof result !== "object" || result === null || !("data" in result)) {
    return false;
  }
  const data = result.data;
  if (typeof data !== "object" || data === null || !("status" in data)) {
    return false;
  }
  const status = data.status;
  return (
    typeof status === "object" &&
    status !== null &&
    "status" in status &&
    status.status === "running"
  );
};

export function waitingAuditStatusTool(
  adapt: (
    definition: McpToolDefinition<typeof getAuditStatusTool.config.inputSchema>,
  ) => Tool,
): Tool {
  const base = adapt({
    ...getAuditStatusTool,
    config: {
      ...getAuditStatusTool.config,
      description: `${getAuditStatusTool.config.description} While the audit is running this call waits up to ~1 minute server-side and returns as soon as progress changes, so never call it in a tight loop: check a few times, narrating progress to the user in between, and if it is still running after that, say so and let the user come back for the results.`,
    },
  });
  const baseExecute = base.execute;
  if (!baseExecute) return base;

  return {
    ...base,
    execute: async (args, options) => {
      const deadline = Date.now() + AUDIT_STATUS_WAIT_BUDGET_MS;
      let result: unknown = await baseExecute(args, options);
      const initial = auditProgressLine(result);
      while (
        auditIsRunning(result) &&
        auditProgressLine(result) === initial &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, AUDIT_STATUS_POLL_MS),
        );
        result = await baseExecute(args, options);
      }
      return result;
    },
  };
}

export function recurringAuditTools(context: ToolContext, projectId: string) {
  const estimate = estimateAuditScheduleTool.config.inputSchema;
  const save = saveAuditScheduleTool.config.inputSchema;
  return {
    get_audit_schedule: adaptSchemaMcpTool(
      getAuditScheduleTool,
      getAuditScheduleTool.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    estimate_audit_schedule: adaptSchemaMcpTool(
      estimateAuditScheduleTool,
      z.discriminatedUnion("cadence", [
        estimate.options[0].omit({ projectId: true }),
        estimate.options[1].omit({ projectId: true }),
      ]),
      context,
      projectId,
    ),
    save_audit_schedule: adaptSchemaMcpTool(
      saveAuditScheduleTool,
      z.discriminatedUnion("cadence", [
        save.options[0].omit({ projectId: true }),
        save.options[1].omit({ projectId: true }),
      ]),
      context,
      projectId,
    ),
    list_audit_attempts: adaptSchemaMcpTool(
      listAuditAttemptsTool,
      listAuditAttemptsTool.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    get_audit_evidence: adaptSchemaMcpTool(
      getAuditEvidenceTool,
      getAuditEvidenceTool.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    compare_audit_evidence: adaptSchemaMcpTool(
      compareAuditEvidenceTool,
      compareAuditEvidenceTool.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
    export_audit_evidence: adaptSchemaMcpTool(
      exportAuditEvidenceTool,
      exportAuditEvidenceTool.config.inputSchema.omit({ projectId: true }),
      context,
      projectId,
    ),
  };
}
