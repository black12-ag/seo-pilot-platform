import { createServerFn } from "@tanstack/react-start";
import { AuditEvidenceService } from "@/server/features/audit/services/AuditEvidenceService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { AppError } from "@/server/lib/errors";
import {
  auditEvidenceInputSchema,
  auditEvidenceCompareInputSchema,
} from "@/types/schemas/audit-evidence";

export const getAuditEvidence = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(auditEvidenceInputSchema)
  .handler(async ({ context, data }) => {
    if (data.projectId !== context.projectId) throw new AppError("NOT_FOUND");
    return AuditEvidenceService.get(context, data);
  });

export const compareAuditEvidence = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(auditEvidenceCompareInputSchema)
  .handler(async ({ context, data }) => {
    if (data.projectId !== context.projectId) throw new AppError("NOT_FOUND");
    return AuditEvidenceService.compare(context, data);
  });

export const exportAuditEvidence = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(auditEvidenceInputSchema)
  .handler(async ({ context, data }) => {
    if (data.projectId !== context.projectId) throw new AppError("NOT_FOUND");
    return AuditEvidenceService.export(context, data);
  });
