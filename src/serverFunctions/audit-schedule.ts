import { createServerFn } from "@tanstack/react-start";
import { AuditScheduleService } from "@/server/features/audit/services/AuditScheduleService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { AppError } from "@/server/lib/errors";
import {
  auditScheduleProjectSchema,
  auditScheduleEstimateInputSchema,
  auditScheduleSaveInputSchema,
  auditAttemptListInputSchema,
} from "@/types/schemas/audit-schedule";

export const getAuditSchedule = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(auditScheduleProjectSchema)
  .handler(async ({ context, data }) => {
    if (data.projectId !== context.projectId) throw new AppError("NOT_FOUND");
    return AuditScheduleService.get(context, data);
  });

export const estimateAuditSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(auditScheduleEstimateInputSchema)
  .handler(async ({ context, data }) => {
    if (data.projectId !== context.projectId) throw new AppError("NOT_FOUND");
    return AuditScheduleService.estimate(context, data);
  });

export const saveAuditSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(auditScheduleSaveInputSchema)
  .handler(async ({ context, data }) => {
    if (data.projectId !== context.projectId) throw new AppError("NOT_FOUND");
    return AuditScheduleService.save(context, data);
  });

export const listAuditAttempts = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(auditAttemptListInputSchema)
  .handler(async ({ context, data }) => {
    if (data.projectId !== context.projectId) throw new AppError("NOT_FOUND");
    return AuditScheduleService.listAttempts(context, data);
  });
