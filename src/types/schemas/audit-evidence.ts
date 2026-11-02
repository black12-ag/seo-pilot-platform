import { z } from "zod";

const id = z.string().min(1);
const count = z.number().int().nonnegative();
const config = z.strictObject({
  maxPages: count,
  lighthouseStrategy: z.enum(["none", "auto"]),
  renderJavaScript: z.boolean(),
  sitePlatform: z.string().nullable(),
});
const target = z.strictObject({ startUrl: z.string(), config });
export const auditEvidenceInputSchema = z.strictObject({
  projectId: id,
  auditId: id,
});
export const auditEvidenceCompareInputSchema = auditEvidenceInputSchema.extend({
  baselineAuditId: id,
});
const auditEvidenceCoverageSchema = z.strictObject({
  state: z.enum(["unassessed", "partial", "complete"]),
  stopReasons: z.array(z.string()),
  discoveredLowerBound: count,
  pending: count.nullable(),
  attempted: count,
  assessed: count,
  errors: count,
  blocked: count,
  rateLimited: count,
  unrenderedShell: count,
  lighthouseAttempted: count,
  lighthouseSucceeded: count,
  lighthouseFailed: count,
});
export const auditEvidenceManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  engineVersion: z.string(),
  rulesetVersion: z.string(),
  normalizationVersion: z.string(),
  sourceScope: z.string(),
  auditId: id,
  projectId: id,
  requested: target,
  effective: target,
  coverage: auditEvidenceCoverageSchema,
  observedStartAtMs: count.nullable(),
  observedEndAtMs: count.nullable(),
  finalizedAtMs: count,
  terminalStatus: z.enum(["completed", "failed"]),
  requestedHash: z.string().length(64),
  effectiveHash: z.string().length(64),
  source: z.enum(["plain_http", "manual"]),
  rowsHash: z.string().length(64),
  artifact: z.strictObject({ key: z.string(), sha256: z.string().length(64) }),
});
export type AuditEvidenceManifest = z.infer<typeof auditEvidenceManifestSchema>;
export const auditEvidenceResultSchema = z.strictObject({
  projectId: id,
  auditId: id,
  state: z.enum(["sealed", "pending", "legacy_unknown", "deleted"]),
  manifest: auditEvidenceManifestSchema.nullable(),
});
export type AuditEvidenceResult = z.infer<typeof auditEvidenceResultSchema>;
const lighthouseScores = z.strictObject({
  performanceScore: z.number().nullable(),
  accessibilityScore: z.number().nullable(),
  bestPracticesScore: z.number().nullable(),
  seoScore: z.number().nullable(),
});
export const auditEvidenceCompareResultSchema = z.strictObject({
  comparable: z.boolean(),
  reason: z.string().nullable(),
  baseline: auditEvidenceResultSchema,
  current: auditEvidenceResultSchema,
  matchedPages: count,
  enteredUrls: z.array(z.string()),
  exitedUrls: z.array(z.string()),
  unassessedUrls: z.array(z.string()),
  matchedLighthouseChecks: count,
  lighthouse: z.array(
    z.strictObject({
      url: z.string(),
      strategy: z.enum(["mobile", "desktop"]),
      baseline: lighthouseScores,
      current: lighthouseScores,
    }),
  ),
  crossPageIssueReason: z.string().nullable(),
  issues: z.array(
    z.strictObject({ issueType: z.string(), baseline: count, current: count }),
  ),
});
// The authenticated export is a JSON file containing the sealed manifest and actual rows.
export const auditEvidenceExportResultSchema = z.strictObject({
  filename: z.string(),
  contentType: z.literal("application/json"),
  content: z.string(),
});
export type AuditEvidenceCompareResult = z.infer<
  typeof auditEvidenceCompareResultSchema
>;
export type AuditEvidenceExportResult = z.infer<
  typeof auditEvidenceExportResultSchema
>;
