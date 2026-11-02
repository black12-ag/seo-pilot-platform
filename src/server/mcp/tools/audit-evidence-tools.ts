import { z } from "zod";
import { AuditEvidenceService } from "@/server/features/audit/services/AuditEvidenceService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  auditEvidenceInputSchema,
  auditEvidenceCompareInputSchema,
  auditEvidenceManifestSchema,
  auditEvidenceResultSchema,
  auditEvidenceCompareResultSchema,
  auditEvidenceExportResultSchema,
} from "@/types/schemas/audit-evidence";

const targetOutput = auditEvidenceManifestSchema.shape.requested
  .extend({
    config: auditEvidenceManifestSchema.shape.requested.shape.config.loose(),
  })
  .loose();
const evidenceOutput = auditEvidenceResultSchema
  .extend({
    manifest: auditEvidenceManifestSchema
      .extend({
        requested: targetOutput,
        effective: targetOutput,
        coverage: auditEvidenceManifestSchema.shape.coverage.loose(),
        artifact: auditEvidenceManifestSchema.shape.artifact.loose(),
      })
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

export const getAuditEvidenceTool = {
  name: "get_audit_evidence",
  config: {
    title: "Get audit evidence",
    description:
      "Read immutable evidence for an authorized project audit: requested/effective scope, observation times, coverage and stop reasons. Legacy coverage is unknown, not zero or complete. Reading never launches a run.",
    inputSchema: auditEvidenceInputSchema,
    outputSchema: evidenceOutput,
    annotations: readAnnotations,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<typeof auditEvidenceInputSchema>, context) => {
      const result = await AuditEvidenceService.get(context.auth, args);
      return mcpResponse({
        text: `Evidence ${result.state}. Coverage: ${result.manifest?.coverage.state ?? "unknown"}. Stop reasons: ${result.manifest?.coverage.stopReasons.join(", ") || "not recorded"}.`,
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

export const compareAuditEvidenceTool = {
  name: "compare_audit_evidence",
  config: {
    title: "Compare audit evidence",
    description:
      "Compare two explicit authorized audit IDs only within compatible scope/configuration and successfully assessed URL/device cohorts. Disappeared, blocked or unassessed pages are unknown, never fixed. An incompatible or empty cohort has no improvement claim.",
    inputSchema: auditEvidenceCompareInputSchema,
    outputSchema: auditEvidenceCompareResultSchema
      .extend({
        baseline: evidenceOutput,
        current: evidenceOutput,
        issues: z.array(
          auditEvidenceCompareResultSchema.shape.issues.element.loose(),
        ),
        lighthouse: z.array(
          auditEvidenceCompareResultSchema.shape.lighthouse.element
            .extend({
              baseline:
                auditEvidenceCompareResultSchema.shape.lighthouse.element.shape.baseline.loose(),
              current:
                auditEvidenceCompareResultSchema.shape.lighthouse.element.shape.current.loose(),
            })
            .loose(),
        ),
        ...optionalMetaOutputSchema,
      })
      .loose(),
    annotations: readAnnotations,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<typeof auditEvidenceCompareInputSchema>, context) => {
      const result = await AuditEvidenceService.compare(context.auth, args);
      return mcpResponse({
        text: result.comparable
          ? `Comparable cohort: ${result.matchedPages} matched assessed pages. See structured evidence for original coverage and unmatched pages.`
          : `Not directly comparable: ${result.reason ?? "unknown evidence"}.`,
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

export const exportAuditEvidenceTool = {
  name: "export_audit_evidence",
  config: {
    title: "Export audit evidence",
    description:
      "Export authenticated structured JSON containing the actual manifest, page, issue and Lighthouse rows. Preserves provenance and unknown legacy fields. No public artifact URL, site request or audit launch.",
    inputSchema: auditEvidenceInputSchema,
    outputSchema: auditEvidenceExportResultSchema
      .extend(optionalMetaOutputSchema)
      .loose(),
    annotations: readAnnotations,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<typeof auditEvidenceInputSchema>, context) => {
      const result = await AuditEvidenceService.export(context.auth, args);
      return mcpResponse({
        text: `Evidence export ${result.filename}; actual JSON is in structured content.content.`,
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
