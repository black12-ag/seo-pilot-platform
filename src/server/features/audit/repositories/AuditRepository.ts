import { runBatch } from "@/db/runBatch";
import { markResultDeletedWrites } from "./AuditEvidenceRepository";
/**
 * Data access layer for site audit tables.
 * Provider-aware (D1 or Postgres) via the `@/db` handle. Covers audits,
 * audit_pages, audit_issues, and stored Lighthouse results. Link edges live
 * in the per-audit scratchpad Durable Object, not here.
 */
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  audits,
  auditIssues,
  auditLighthouseResults,
  auditPages,
  projects,
} from "@/db/schema";

import {
  auditResultSelect,
  writeAuditResults,
  createAudit,
  updateAuditStart,
  updateAuditProgress,
  completeAudit,
  failAudit,
} from "./auditRunWrites";
import { insertIssues } from "./auditIssueWrites";
import { deterministicAuditRowId } from "@/server/lib/audit/ids";
import type { DetectedIssue } from "@/server/lib/audit/issues/page-reporters";
import type {
  CrawledPageResult,
  LighthouseResult,
} from "@/server/lib/audit/types";
import type { PageFetchClass } from "@/shared/audit-fetch-class";

async function getAuditForWorkflow(
  auditId: string,
  workflowInstanceId: string,
) {
  return db.query.audits.findFirst({
    where: and(
      eq(audits.id, auditId),
      eq(audits.workflowInstanceId, workflowInstanceId),
    ),
  });
}

/**
 * Persist one crawled sub-batch (pages + per-page issues). Called inside the
 * crawl-chunk Workflow step so results land in the app DB incrementally
 * instead of accumulating in memory until finalize. Link edges go to the
 * audit's scratchpad DO, not here.
 *
 * Idempotent on step retry: callers assign deterministic page ids
 * (deterministicAuditRowId) and issue ids are derived from stable content.
 * Page rows upsert (a retried fetch may legitimately differ — last attempt
 * wins); issues are insert-or-ignore.
 */
async function insertCrawledBatch(
  auditId: string,
  pages: CrawledPageResult[],
  issues: DetectedIssue[],
) {
  await writeAuditResults(auditId, pages, (tx, page) => {
    const dataColumns = {
      url: page.url,
      statusCode: page.statusCode,
      redirectUrl: page.redirectUrl,
      title: page.title,
      metaDescription: page.metaDescription,
      canonicalUrl: page.canonicalUrl,
      robotsMeta: page.robotsMeta,
      xRobotsTag: page.xRobotsTag,
      headerCanonicalUrl: page.headerCanonicalUrl,
      ogTitle: page.ogTitle,
      ogDescription: page.ogDescription,
      ogImage: page.ogImage,
      h1Count: page.h1Count,
      h2Count: page.h2Count,
      h3Count: page.h3Count,
      h4Count: page.h4Count,
      h5Count: page.h5Count,
      h6Count: page.h6Count,
      wordCount: page.wordCount,
      contentHash: page.contentHash,
      imagesTotal: page.imagesTotal,
      imagesMissingAlt: page.imagesMissingAlt,
      internalLinkCount: page.links.filter((l) => l.isInternal).length,
      externalLinkCount: page.links.filter((l) => !l.isInternal).length,
      hasStructuredData: page.hasStructuredData,
      isIndexable: page.isIndexable,
      fetchClass: page.fetchClass,
      crawlDepth: page.crawlDepth,
      inSitemap: page.inSitemap,
      responseTimeMs: page.responseTimeMs,
      fetchedAtMs: page.fetchedAtMs ?? null,
      contentAssessed: page.contentAssessed ?? null,
      isHtml: page.isHtml,
      isLikelyJsShell: page.javascriptShell ?? null,
      renderingMode: page.renderingMode ?? null,
    };
    return tx
      .insert(auditPages)
      .select(
        auditResultSelect(
          auditPages,
          { id: page.id, auditId, ...dataColumns },
          auditId,
        ),
      )
      .onConflictDoUpdate({ target: auditPages.id, set: dataColumns });
  });

  await insertIssues(auditId, issues);
}

async function insertLighthouseResults(
  auditId: string,
  lighthouseResults: LighthouseResult[],
) {
  const rows = await Promise.all(
    lighthouseResults.map(async (result) => ({
      id: await deterministicAuditRowId(
        auditId,
        result.pageId,
        result.strategy,
      ),
      auditId,
      pageId: result.pageId,
      strategy: result.strategy,
      performanceScore: result.performanceScore,
      accessibilityScore: result.accessibilityScore,
      bestPracticesScore: result.bestPracticesScore,
      seoScore: result.seoScore,
      lcpMs: result.lcpMs,
      cls: result.cls,
      inpMs: result.inpMs,
      ttfbMs: result.ttfbMs,
      errorMessage: result.errorMessage ?? null,
      r2Key: result.r2Key ?? null,
      payloadSizeBytes: result.payloadSizeBytes ?? null,
    })),
  );
  // The persistence step is retryable after its paid provider result has been
  // checkpointed, so repeated writes must stay idempotent.
  await writeAuditResults(auditId, rows, (tx, row) => {
    const { id: _id, auditId: _auditId, ...dataColumns } = row;
    return tx
      .insert(auditLighthouseResults)
      .select(auditResultSelect(auditLighthouseResults, row, auditId))
      .onConflictDoUpdate({
        target: auditLighthouseResults.id,
        set: dataColumns,
      });
  });
}

async function getAuditForProject(auditId: string, projectId: string) {
  return db.query.audits.findFirst({
    where: and(eq(audits.id, auditId), eq(audits.projectId, projectId)),
  });
}

async function getLatestAuditForProject(projectId: string) {
  return db.query.audits.findFirst({
    where: eq(audits.projectId, projectId),
    orderBy: desc(audits.startedAt),
  });
}

async function getIssuesForAudit(
  auditId: string,
  filters: { severity?: "critical" | "warning" | "info"; issueType?: string },
) {
  return db.query.auditIssues.findMany({
    where: and(
      eq(auditIssues.auditId, auditId),
      filters.severity ? eq(auditIssues.severity, filters.severity) : undefined,
      filters.issueType
        ? eq(auditIssues.issueType, filters.issueType)
        : undefined,
    ),
  });
}

async function getPagesForAudit(auditId: string) {
  return db
    .select({
      id: auditPages.id,
      url: auditPages.url,
      statusCode: auditPages.statusCode,
      fetchClass: auditPages.fetchClass,
      redirectUrl: auditPages.redirectUrl,
      title: auditPages.title,
      metaDescription: auditPages.metaDescription,
      wordCount: auditPages.wordCount,
      isIndexable: auditPages.isIndexable,
      crawlDepth: auditPages.crawlDepth,
      inSitemap: auditPages.inSitemap,
      internalLinkCount: auditPages.internalLinkCount,
      responseTimeMs: auditPages.responseTimeMs,
    })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId));
}

async function countPagesByFetchClass(
  auditId: string,
  fetchClass: PageFetchClass,
): Promise<number> {
  const rows = await db
    .select({ pages: count() })
    .from(auditPages)
    .where(
      and(
        eq(auditPages.auditId, auditId),
        eq(auditPages.fetchClass, fetchClass),
      ),
    );
  return rows[0]?.pages ?? 0;
}

async function hasPagesForAudit(auditId: string): Promise<boolean> {
  const rows = await db
    .select({ id: auditPages.id })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId))
    .limit(1);
  return rows.length > 0;
}

async function getAuditsByProject(projectId: string) {
  const rows = await db
    .select({ audit: audits })
    .from(audits)
    .where(eq(audits.projectId, projectId))
    .orderBy(desc(audits.startedAt));

  return rows.map(({ audit }) => audit);
}

// Org-scoped: the free-plan quota belongs to the org (the Autumn customer),
// so usage must aggregate across every member — counting per starting user
// would multiply the free ceiling by the member count.
async function getAuditUsageForOrganization(organizationId: string) {
  const rows = await db
    .select({
      status: audits.status,
      pagesTotal: audits.pagesTotal,
      lighthouseTotal: audits.lighthouseTotal,
    })
    .from(audits)
    .innerJoin(projects, eq(audits.projectId, projects.id))
    .where(eq(projects.organizationId, organizationId));

  return {
    capacityUnits: rows.reduce(
      (total, row) => total + row.pagesTotal + row.lighthouseTotal,
      0,
    ),
    runningCount: rows.filter((row) => row.status === "running").length,
  };
}

async function hasAuditInOrganization(organizationId: string) {
  const rows = await db
    .select({ id: audits.id })
    .from(audits)
    .innerJoin(projects, eq(audits.projectId, projects.id))
    .where(eq(projects.organizationId, organizationId))
    .limit(1);
  return rows.length > 0;
}

async function getAuditResultsForProject(auditId: string, projectId: string) {
  const audit = await getAuditForProject(auditId, projectId);
  if (!audit) {
    return { audit: null, pages: [], lighthouse: [], issues: [] };
  }

  const [pages, lighthouse, issues] = await Promise.all([
    db.query.auditPages.findMany({
      where: eq(auditPages.auditId, auditId),
    }),
    db.query.auditLighthouseResults.findMany({
      where: eq(auditLighthouseResults.auditId, auditId),
    }),
    db.query.auditIssues.findMany({
      where: eq(auditIssues.auditId, auditId),
    }),
  ]);

  return { audit, pages, lighthouse, issues };
}

async function getLighthouseResultById(input: {
  lighthouseResultId: string;
  projectId: string;
}) {
  const lighthouse = await db.query.auditLighthouseResults.findFirst({
    where: eq(auditLighthouseResults.id, input.lighthouseResultId),
  });

  if (!lighthouse) {
    return null;
  }

  const [parentAudit, page] = await Promise.all([
    db.query.audits.findFirst({
      where: and(
        eq(audits.id, lighthouse.auditId),
        eq(audits.projectId, input.projectId),
      ),
    }),
    db.query.auditPages.findFirst({
      where: eq(auditPages.id, lighthouse.pageId),
    }),
  ]);

  if (!parentAudit) {
    return null;
  }

  return {
    lighthouse,
    page,
    audit: parentAudit,
  };
}

async function deleteAuditForProject(auditId: string, projectId: string) {
  await runBatch((tx) => [
    ...markResultDeletedWrites(tx, auditId, projectId),
    tx
      .delete(audits)
      .where(and(eq(audits.id, auditId), eq(audits.projectId, projectId))),
  ]);
}

export const AuditRepository = {
  createAudit,
  updateAuditStart,
  updateAuditProgress,
  completeAudit,
  failAudit,
  getAuditForWorkflow,
  insertCrawledBatch,
  insertIssues,
  insertLighthouseResults,
  getAuditForProject,
  getLatestAuditForProject,
  getIssuesForAudit,
  getPagesForAudit,
  countPagesByFetchClass,
  hasPagesForAudit,
  getAuditsByProject,
  getAuditUsageForOrganization,
  hasAuditInOrganization,
  getAuditResultsForProject,
  getLighthouseResultById,
  deleteAuditForProject,
} as const;
