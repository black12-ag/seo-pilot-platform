import { queryOptions } from "@tanstack/react-query";
import {
  getAuditEvidence,
  compareAuditEvidence,
} from "@/serverFunctions/audit-evidence";

export const auditEvidenceQuery = (projectId: string, auditId: string) =>
  queryOptions({
    queryKey: ["audit-evidence", projectId, auditId],
    queryFn: () => getAuditEvidence({ data: { projectId, auditId } }),
    refetchInterval: (query) =>
      query.state.data?.state === "pending" ? 10_000 : false,
  });

export const auditComparisonQuery = (
  projectId: string,
  auditId: string,
  baselineAuditId: string,
) =>
  queryOptions({
    queryKey: ["audit-comparison", projectId, auditId, baselineAuditId],
    queryFn: () =>
      compareAuditEvidence({ data: { projectId, auditId, baselineAuditId } }),
    enabled: Boolean(baselineAuditId),
  });
