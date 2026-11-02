import { sort } from "remeda";
import { AuditEvidenceRepository } from "../repositories/AuditEvidenceRepository";
import { AuditScheduleRepository } from "../repositories/AuditScheduleRepository";
import { getAuditScratchpad } from "../AuditScratchpad";
import { auditScheduleEstimateInputSchema } from "@/types/schemas/audit-schedule";
import { auditEvidenceManifestSchema } from "@/types/schemas/audit-evidence";
import { putTextToR2 } from "@/server/lib/r2";
import { AuditRepository } from "../repositories/AuditRepository";
import { parseAuditConfig, type AuditConfig } from "@/server/lib/audit/types";
import { sha256Hex } from "@/server/lib/audit/ids";

type Results = Awaited<
  ReturnType<typeof AuditRepository.getAuditResultsForProject>
>;

function publicConfig(config: AuditConfig) {
  return {
    maxPages: config.maxPages,
    lighthouseStrategy: config.lighthouseStrategy,
    renderJavaScript: config.renderJavaScript ?? false,
    sitePlatform: config.sitePlatform ?? null,
  };
}

/** Stable row ordering makes retries hash the same observation snapshot. */
async function buildAuditEvidenceManifest(input: {
  auditId: string;
  projectId: string;
  requested: { startUrl: string; config: AuditConfig };
  effective: { startUrl: string; config: AuditConfig };
  results: Results;
  discoveredLowerBound: number;
  pending: number | null;
  crawlCompleted: boolean;
  stoppedBy?: string;
  terminalStatus: "completed" | "failed";
  finalizedAtMs: number;
  source: "plain_http" | "manual";
}) {
  const pages = sort(input.results.pages, (a, b) => a.id.localeCompare(b.id));
  const issues = sort(input.results.issues, (a, b) => a.id.localeCompare(b.id));
  const lighthouse = sort(input.results.lighthouse, (a, b) =>
    a.id.localeCompare(b.id),
  );
  const assessed = pages.filter((page) => page.contentAssessed === true).length;
  const errors = pages.filter(
    (page) => page.fetchClass === "error" || (page.statusCode ?? 0) >= 400,
  ).length;
  const blocked = pages.filter((page) => page.fetchClass === "blocked").length;
  const rateLimited = pages.filter(
    (page) => page.fetchClass === "rate_limited",
  ).length;
  const unrenderedShell = pages.filter(
    (page) => page.isLikelyJsShell === true,
  ).length;
  const lighthouseFailed = lighthouse.filter(
    (row) => row.errorMessage || row.performanceScore === null,
  ).length;
  const times = pages.flatMap((page) =>
    page.fetchedAtMs === null ? [] : [page.fetchedAtMs],
  );
  const stopReasons: string[] = [];
  if (input.terminalStatus === "failed") stopReasons.push("workflow_failed");
  if (input.stoppedBy) stopReasons.push(input.stoppedBy);
  if (!input.crawlCompleted) stopReasons.push("frontier_not_exhausted");
  if (input.pending === null) stopReasons.push("discovery_state_unavailable");
  if ((input.pending ?? 0) > 0) stopReasons.push("frontier_remaining");
  if (
    (input.pending ?? 0) > 0 &&
    pages.length >= input.requested.config.maxPages
  )
    stopReasons.push("page_limit");
  if (blocked > 0) stopReasons.push("blocked_pages");
  if (rateLimited > 0) stopReasons.push("rate_limited_pages");
  if (errors > 0) stopReasons.push("page_errors");
  if (unrenderedShell > 0) stopReasons.push("javascript_shells");
  if (pages.length > assessed) stopReasons.push("unassessed_pages");
  if (times.length !== pages.length)
    stopReasons.push("observation_time_unknown");
  if (assessed === 0) stopReasons.push("no_assessed_pages");
  if (
    lighthouseFailed > 0 ||
    (input.results.audit?.lighthouseTotal ?? 0) > lighthouse.length
  )
    stopReasons.push("lighthouse_incomplete");
  const rows = { pages, issues, lighthouse };
  const rowsHash = await sha256Hex(JSON.stringify(rows));
  const core = {
    schemaVersion: 1 as const,
    terminalStatus: input.terminalStatus,
    engineVersion: "site-audit-1",
    rulesetVersion: "site-audit-1",
    normalizationVersion: "audit-url-1",
    sourceScope: "robots_allowed_sitemaps_and_internal_links",
    auditId: input.auditId,
    projectId: input.projectId,
    requested: {
      startUrl: input.requested.startUrl,
      config: publicConfig(input.requested.config),
    },
    effective: {
      startUrl: input.effective.startUrl,
      config: publicConfig(input.effective.config),
    },
    coverage: {
      state:
        assessed === 0
          ? ("unassessed" as const)
          : stopReasons.length > 0
            ? ("partial" as const)
            : ("complete" as const),
      stopReasons,
      discoveredLowerBound: Math.max(input.discoveredLowerBound, pages.length),
      pending: input.pending,
      attempted: pages.length,
      assessed,
      errors,
      blocked,
      rateLimited,
      unrenderedShell,
      lighthouseAttempted: lighthouse.length,
      lighthouseSucceeded: lighthouse.length - lighthouseFailed,
      lighthouseFailed,
    },
    observedStartAtMs: times.length ? Math.min(...times) : null,
    observedEndAtMs: times.length ? Math.max(...times) : null,
    finalizedAtMs: input.finalizedAtMs,
    source: input.source,
    rowsHash,
    requestedHash: await sha256Hex(
      JSON.stringify({
        startUrl: input.requested.startUrl,
        config: publicConfig(input.requested.config),
      }),
    ),
    effectiveHash: await sha256Hex(
      JSON.stringify({
        startUrl: input.effective.startUrl,
        config: publicConfig(input.effective.config),
      }),
    ),
  };
  const artifactBody = JSON.stringify({ manifest: core, ...rows });
  const sha256 = await sha256Hex(artifactBody);
  // Content addressing avoids overwrite when two finalizers race; SQL chooses
  // one immutable seal and the other artifact is never offered as evidence.
  const key = `site-audit/${input.projectId}/${input.auditId}/evidence/${sha256}.json`;
  return {
    manifest: auditEvidenceManifestSchema.parse({
      ...core,
      artifact: { key, sha256 },
    }),
    artifactBody,
  };
}

/** Workflow and watchdog share one recoverable seal, before scratch cleanup. */
export async function sealAuditEvidence(input: {
  auditId: string;
  projectId: string;
  workflowInstanceId: string;
  status: "completed" | "failed";
  crawl?: { completed: boolean; stoppedBy?: string };
  errorCode?: string;
  errorDetail?: string;
}) {
  const original = await AuditRepository.getAuditForWorkflow(
    input.auditId,
    input.workflowInstanceId,
  );
  if (!original || original.projectId !== input.projectId) return false;
  const existing = await AuditEvidenceRepository.getForWorkflow(
    input.auditId,
    input.projectId,
    input.workflowInstanceId,
  );
  if (existing) return true;
  const attempt = await AuditScheduleRepository.getAttempt(input.auditId);
  const frozen = attempt
    ? auditScheduleEstimateInputSchema.parse(JSON.parse(attempt.requestJson))
    : null;
  const requestedConfig = frozen ?? parseAuditConfig(original.requestedConfig);
  const requestedUrl = frozen?.startUrl ?? original.requestedStartUrl;
  if (!requestedConfig || !requestedUrl) return false;
  const claim = await AuditEvidenceRepository.beginSeal({
    ...input,
    nowMs: Date.now(),
  });
  if (!claim) return false;
  const results = await AuditRepository.getAuditResultsForProject(
    input.auditId,
    input.projectId,
  );
  const effectiveConfig = parseAuditConfig(results.audit?.config ?? null);
  if (!results.audit || !effectiveConfig) return false;
  let discoveredLowerBound = results.pages.length;
  let pending: number | null = null;
  try {
    const stats = await getAuditScratchpad(input.auditId).getStats();
    discoveredLowerBound = Math.max(stats.seen, results.pages.length);
    pending = Math.max(stats.pending, stats.seen - results.pages.length);
  } catch {
    /* Missing discovery state is explicitly unknown, never complete. */
  }
  const built = await buildAuditEvidenceManifest({
    auditId: input.auditId,
    projectId: input.projectId,
    requested: { startUrl: requestedUrl, config: requestedConfig },
    effective: { startUrl: results.audit.startUrl, config: effectiveConfig },
    results,
    discoveredLowerBound,
    pending,
    crawlCompleted: input.crawl?.completed ?? false,
    stoppedBy: input.crawl?.stoppedBy ?? input.errorCode,
    terminalStatus: input.status,
    finalizedAtMs: claim.finalizedAtMs,
    source: attempt ? "plain_http" : "manual",
  });
  await putTextToR2(built.manifest.artifact.key, built.artifactBody);
  return AuditEvidenceRepository.seal({
    ...input,
    sealToken: claim.token,
    manifest: built.manifest,
  });
}
