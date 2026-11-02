import { z } from "zod";
import { AuditScheduleService } from "@/server/features/audit/services/AuditScheduleService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  auditScheduleProjectSchema,
  auditScheduleEstimateInputSchema,
  auditScheduleSaveInputSchema,
  auditScheduleEstimateSchema,
  auditScheduleViewSchema,
  auditScheduleGetResultSchema,
  auditAttemptListInputSchema,
  auditAttemptListResultSchema,
  auditAttemptSchema,
} from "@/types/schemas/audit-schedule";

const settingsOutput = z.discriminatedUnion("cadence", [
  auditScheduleEstimateInputSchema.options[0].loose(),
  auditScheduleEstimateInputSchema.options[1].loose(),
]);
const scheduleOutput = auditScheduleGetResultSchema
  .extend({
    usage: auditScheduleGetResultSchema.shape.usage.loose(),
    schedule: auditScheduleViewSchema
      .extend({ settings: settingsOutput })
      .loose()
      .nullable(),
    ...optionalMetaOutputSchema,
  })
  .loose();
const readAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

export const getAuditScheduleTool = {
  name: "get_audit_schedule",
  config: {
    title: "Get audit schedule",
    description:
      "Read schedule intent, effective blocked reasons and current permission. No run is started. Plain HTTP recurrence only; rendering and Lighthouse recurrence are unavailable.",
    inputSchema: auditScheduleProjectSchema,
    outputSchema: scheduleOutput,
    annotations: readAnnotations,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<typeof auditScheduleProjectSchema>, context) => {
      const result = await AuditScheduleService.get(context.auth, args);
      return mcpResponse({
        text: result.schedule
          ? `Schedule ${result.schedule.state}; version ${result.schedule.version}. Blocked reasons: ${result.schedule.blockedReasons.join(", ") || "none"}.`
          : "Recurring audits are off. No schedule has been saved.",
        structuredContent: result,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit`,
        ),
      });
    },
  ),
};

export const estimateAuditScheduleTool = {
  name: "estimate_audit_schedule",
  config: {
    title: "Estimate audit schedule",
    description:
      "Review the next three UTC occurrences, requested page/run/day/cost caps and blocked reasons without fetching a site or holding credits. Obtain an estimate before an explicitly user-approved save; never silently change paid options.",
    inputSchema: auditScheduleEstimateInputSchema,
    outputSchema: auditScheduleEstimateSchema
      .extend(optionalMetaOutputSchema)
      .loose(),
    annotations: readAnnotations,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<typeof auditScheduleEstimateInputSchema>, context) => {
      const result = await AuditScheduleService.estimate(context.auth, args);
      return mcpResponse({
        text: `Review: up to ${result.maxPagesPerRun} pages/run, ${result.maxPagesPerUtcDay} pages/UTC day, ${result.maxRunsPerUtcDay} runs/UTC day; cost ceiling ${result.maxCostMicrosPerRun} micro-USD/run. Next: ${result.nextOccurrences.map((ms) => new Date(ms).toISOString()).join(", ")}. Blocked reasons: ${result.blockedReasons.join(", ") || "none"}.`,
        structuredContent: result,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit`,
        ),
      });
    },
  ),
};

export const saveAuditScheduleTool = {
  name: "save_audit_schedule",
  config: {
    title: "Save audit schedule",
    description:
      "Current owner only. Save paused settings or explicitly enable/pause a reviewed schedule using expectedVersion and the matching estimateFingerprint. Ask the user to review target, cadence/timezone and finite limits before enabling or increasing limits. New schedules are paused; enabling needs a second deliberate save. Saving never launches immediately. Paid recurrence is refused, never downgraded.",
    inputSchema: auditScheduleSaveInputSchema,
    outputSchema: scheduleOutput,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<typeof auditScheduleSaveInputSchema>, context) => {
      const result = await AuditScheduleService.save(context.auth, args);
      return mcpResponse({
        text: `Schedule ${result.schedule?.state ?? "off"}; version ${result.schedule?.version ?? 0}. No immediate audit was started. Blocked reasons: ${result.schedule?.blockedReasons.join(", ") || "none"}.`,
        structuredContent: result,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit`,
        ),
      });
    },
  ),
};

export const listAuditAttemptsTool = {
  name: "list_audit_attempts",
  config: {
    title: "List audit attempts",
    description:
      "Read bounded recurring attempt history. Launch, evidence coverage and billing state are separate. Missing or deleted results do not imply zero findings or complete coverage.",
    inputSchema: auditAttemptListInputSchema,
    outputSchema: auditAttemptListResultSchema
      .extend({
        attempts: z.array(auditAttemptSchema.loose()),
        ...optionalMetaOutputSchema,
      })
      .loose(),
    annotations: readAnnotations,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<typeof auditAttemptListInputSchema>, context) => {
      const result = await AuditScheduleService.listAttempts(
        context.auth,
        args,
      );
      return mcpResponse({
        text: result.attempts.length
          ? result.attempts
              .map(
                (attempt) =>
                  `${attempt.id}: launch ${attempt.launchState}, coverage ${attempt.coverageState}, billing ${attempt.billingState}${attempt.resultDeleted ? "; result deleted" : ""}${attempt.reason ? `; ${attempt.reason}` : ""}.`,
              )
              .join("\n")
          : "No recurring audit attempts yet.",
        structuredContent: result,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit`,
        ),
      });
    },
  ),
};
