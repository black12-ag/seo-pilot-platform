import { sort } from "remeda";
import type { z } from "zod";
import { AuditRepository } from "../repositories/AuditRepository";
import { AuditEvidenceRepository } from "../repositories/AuditEvidenceRepository";
import {
  auditScheduleAccess,
  type AuditScheduleActor,
} from "./auditScheduleAccess";
import { AppError } from "@/server/lib/errors";
import { sha256Hex } from "@/server/lib/audit/ids";
import { getJsonFromR2 } from "@/server/lib/r2";
import {
  auditEvidenceInputSchema,
  auditEvidenceCompareInputSchema,
  auditEvidenceManifestSchema,
  type AuditEvidenceResult,
  type AuditEvidenceManifest,
  type AuditEvidenceCompareResult,
  type AuditEvidenceExportResult,
} from "@/types/schemas/audit-evidence";

type Input = z.infer<typeof auditEvidenceInputSchema>;
type CompareInput = z.infer<typeof auditEvidenceCompareInputSchema>;
type Rows = Awaited<
  ReturnType<typeof AuditRepository.getAuditResultsForProject>
>;

async function get(
  actor: AuditScheduleActor,
  raw: Input,
): Promise<AuditEvidenceResult> {
  const input = auditEvidenceInputSchema.parse(raw);
  await auditScheduleAccess(actor, input.projectId);
  const stored = await AuditEvidenceRepository.getForProject(
    input.projectId,
    actor.organizationId,
    input.auditId,
  );
  const base = { projectId: input.projectId, auditId: input.auditId };
  if (stored) {
    const manifest = auditEvidenceManifestSchema.parse(
      JSON.parse(stored.manifestJson),
    );
    if (
      manifest.projectId !== input.projectId ||
      manifest.auditId !== input.auditId ||
      manifest.artifact.key !== stored.artifactKey ||
      manifest.artifact.sha256 !== stored.artifactSha256
    ) {
      throw new AppError(
        "CONFLICT",
        "Evidence manifest integrity check failed.",
      );
    }
    return { ...base, state: "sealed", manifest };
  }
  const audit = await AuditRepository.getAuditForProject(
    input.auditId,
    input.projectId,
  );
  if (audit)
    return {
      ...base,
      state: audit.status === "running" ? "pending" : "legacy_unknown",
      manifest: null,
    };
  if (
    await AuditEvidenceRepository.getDeletedAttempt(
      input.projectId,
      actor.organizationId,
      input.auditId,
    )
  ) {
    return { ...base, state: "deleted", manifest: null };
  }
  throw new AppError("NOT_FOUND");
}

async function rowsFor(result: AuditEvidenceResult) {
  const rows = await AuditRepository.getAuditResultsForProject(
    result.auditId,
    result.projectId,
  );
  const sorted = {
    pages: sort(rows.pages, (a, b) => a.id.localeCompare(b.id)),
    issues: sort(rows.issues, (a, b) => a.id.localeCompare(b.id)),
    lighthouse: sort(rows.lighthouse, (a, b) => a.id.localeCompare(b.id)),
  };
  if (
    result.manifest &&
    (await sha256Hex(JSON.stringify(sorted))) !== result.manifest.rowsHash
  ) {
    throw new AppError(
      "CONFLICT",
      "Evidence rows no longer match the immutable manifest.",
    );
  }
  return sorted;
}

async function exportEvidence(
  actor: AuditScheduleActor,
  raw: Input,
): Promise<AuditEvidenceExportResult> {
  const input = auditEvidenceInputSchema.parse(raw);
  const result = await get(actor, input);
  if (result.state === "pending")
    throw new AppError("CONFLICT", "Evidence is not finalized.");
  const rows = await rowsFor(result);
  if (result.manifest) {
    const artifact = await getJsonFromR2(result.manifest.artifact.key);
    if ((await sha256Hex(artifact)) !== result.manifest.artifact.sha256) {
      throw new AppError(
        "CONFLICT",
        "Evidence artifact integrity check failed.",
      );
    }
  }
  // Recheck membership after storage I/O before returning private project observations.
  await auditScheduleAccess(actor, input.projectId);
  return {
    filename: `audit-evidence-${input.auditId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
    contentType: "application/json",
    content: JSON.stringify({ ...result, ...rows }),
  };
}

function comparisonKey(manifest: AuditEvidenceManifest) {
  return JSON.stringify({
    target: manifest.effective.startUrl,
    requested: manifest.requested,
    config: manifest.effective.config,
    engine: manifest.engineVersion,
    ruleset: manifest.rulesetVersion,
    normalization: manifest.normalizationVersion,
    scope: manifest.sourceScope,
  });
}

const crossPageTypes = new Set([
  "duplicate-title",
  "duplicate-meta-description",
  "duplicate-content",
  "orphan-page",
  "broken-internal-link",
  "redirect-loop",
  "redirect-chain",
]);

function issueCounts(
  issues: Rows["issues"],
  matched: Set<string>,
  includeCrossPage: boolean,
) {
  const counts = new Map<string, Set<string>>();
  for (const issue of issues) {
    if (
      !matched.has(issue.pageUrl) ||
      (!includeCrossPage && crossPageTypes.has(issue.issueType))
    )
      continue;
    const urls = counts.get(issue.issueType) ?? new Set<string>();
    urls.add(issue.pageUrl);
    counts.set(issue.issueType, urls);
  }
  return counts;
}

function lighthouseCohort(
  rows: Awaited<ReturnType<typeof rowsFor>>,
  matched: Set<string>,
) {
  const pageUrls = new Map(rows.pages.map((page) => [page.id, page.url]));
  return new Map(
    rows.lighthouse.flatMap((row) => {
      const url = pageUrls.get(row.pageId);
      if (
        !url ||
        !matched.has(url) ||
        row.errorMessage ||
        row.performanceScore === null
      )
        return [];
      return [
        [
          `${url}\n${row.strategy}`,
          {
            url,
            strategy: row.strategy,
            scores: {
              performanceScore: row.performanceScore,
              accessibilityScore: row.accessibilityScore,
              bestPracticesScore: row.bestPracticesScore,
              seoScore: row.seoScore,
            },
          },
        ] as const,
      ];
    }),
  );
}

async function compare(
  actor: AuditScheduleActor,
  raw: CompareInput,
): Promise<AuditEvidenceCompareResult> {
  const input = auditEvidenceCompareInputSchema.parse(raw);
  const [baseline, current] = await Promise.all([
    get(actor, { projectId: input.projectId, auditId: input.baselineAuditId }),
    get(actor, { projectId: input.projectId, auditId: input.auditId }),
  ]);
  const result: AuditEvidenceCompareResult = {
    comparable: false,
    reason: null,
    baseline,
    current,
    matchedPages: 0,
    enteredUrls: [],
    exitedUrls: [],
    unassessedUrls: [],
    issues: [],
    matchedLighthouseChecks: 0,
    lighthouse: [],
    crossPageIssueReason: null,
  };
  if (!baseline.manifest || !current.manifest)
    return { ...result, reason: "evidence_unavailable" };
  // Pages can commit before issue persistence fails, so absent findings are unknown.
  if (
    [baseline.manifest, current.manifest].some(
      (manifest) =>
        manifest.terminalStatus === "failed" ||
        manifest.coverage.stopReasons.some(
          (reason) => reason === "workflow_failed" || reason === "db_error",
        ),
    )
  )
    return { ...result, reason: "result_persistence_uncertain" };
  if (comparisonKey(baseline.manifest) !== comparisonKey(current.manifest))
    return { ...result, reason: "configuration_changed" };
  const [before, after] = await Promise.all([
    rowsFor(baseline),
    rowsFor(current),
  ]);
  const beforeUrls = new Set(before.pages.map((page) => page.url));
  const afterUrls = new Set(after.pages.map((page) => page.url));
  const beforeAssessed = new Set(
    before.pages
      .filter((page) => page.contentAssessed === true)
      .map((page) => page.url),
  );
  const afterAssessed = new Set(
    after.pages
      .filter((page) => page.contentAssessed === true)
      .map((page) => page.url),
  );
  const matched = new Set(
    [...beforeAssessed].filter((url) => afterAssessed.has(url)),
  );
  result.matchedPages = matched.size;
  result.enteredUrls = sort(
    [...afterUrls].filter((url) => !beforeUrls.has(url)),
    (a, b) => a.localeCompare(b),
  );
  result.exitedUrls = sort(
    [...beforeUrls].filter((url) => !afterUrls.has(url)),
    (a, b) => a.localeCompare(b),
  );
  result.unassessedUrls = sort(
    [...new Set([...beforeUrls, ...afterUrls])].filter(
      (url) => !matched.has(url),
    ),
    (a, b) => a.localeCompare(b),
  );
  if (!matched.size) return { ...result, reason: "no_matched_assessed_pages" };
  const complete =
    baseline.manifest.coverage.state === "complete" &&
    current.manifest.coverage.state === "complete";
  result.crossPageIssueReason = complete
    ? null
    : "partial_scope_cannot_prove_cross_page_resolution";
  const beforeIssues = issueCounts(before.issues, matched, complete);
  const afterIssues = issueCounts(after.issues, matched, complete);
  result.issues = sort(
    [...new Set([...beforeIssues.keys(), ...afterIssues.keys()])],
    (a, b) => a.localeCompare(b),
  ).map((issueType) => ({
    issueType,
    baseline: beforeIssues.get(issueType)?.size ?? 0,
    current: afterIssues.get(issueType)?.size ?? 0,
  }));
  const beforeLighthouse = lighthouseCohort(before, matched);
  for (const [key, check] of lighthouseCohort(after, matched)) {
    const previous = beforeLighthouse.get(key);
    if (previous)
      result.lighthouse.push({
        url: check.url,
        strategy: check.strategy,
        baseline: previous.scores,
        current: check.scores,
      });
  }
  result.matchedLighthouseChecks = result.lighthouse.length;
  await auditScheduleAccess(actor, input.projectId);
  return { ...result, comparable: true };
}

export const AuditEvidenceService = {
  get,
  compare,
  export: exportEvidence,
} as const;
