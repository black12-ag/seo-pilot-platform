import { AuditScheduleRepository } from "@/server/features/audit/repositories/AuditScheduleRepository";
import { sealAuditEvidence } from "@/server/features/audit/services/auditEvidenceManifest";
import type { WorkflowStep } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { runMultipageChecks } from "@/server/lib/audit/issues/multipage";
import type { DetectedIssue } from "@/server/lib/audit/issues/page-reporters";
import type { AuditConfig } from "@/server/lib/audit/types";
import { normalizeUrl } from "@/server/lib/audit/url-utils";
import { captureServerEvent } from "@/server/lib/posthog";
import type { CrawlPhaseResult } from "./siteAuditWorkflowCrawl";
import { pgStep } from "./pgStep";
import { DB_STEP, MULTIPAGE_CHECKS_STEP } from "./auditStepConfigs";

export async function finalizeAudit(args: {
  step: WorkflowStep;
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
  crawl: CrawlPhaseResult;
}) {
  const {
    step,
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    crawl,
  } = args;

  await pgStep(step, "multipage-checks", MULTIPAGE_CHECKS_STEP, async () => {
    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      currentPhase: "finalizing",
    });

    // Integrity guard: pages are persisted inside crawl-chunk steps. If the
    // crawl claims pages but the DB has none, fail loudly instead of
    // completing with an empty audit.
    if (
      crawl.pagesCrawled > 0 &&
      !(await AuditRepository.hasPagesForAudit(auditId))
    ) {
      throw new Error(
        `Audit ${auditId}: crawl reported ${crawl.pagesCrawled} pages but none were persisted`,
      );
    }

    const checksStartedAt = Date.now();
    console.info("Audit finalization started", { auditId });
    const { issues, hasUnreadShells } = await runMultipageChecks({ auditId });
    console.info("Audit multipage checks completed", {
      auditId,
      durationMs: Date.now() - checksStartedAt,
      issueCount: issues.length,
    });
    const linksStartedAt = Date.now();
    const linkIssues = await runScratchpadLinkChecks(auditId, startUrl, {
      ...crawl,
      completed: crawl.completed && !hasUnreadShells,
    });
    console.info("Audit link checks completed", {
      auditId,
      durationMs: Date.now() - linksStartedAt,
      issueCount: linkIssues.length,
    });
    issues.push(...linkIssues);
    if (crawl.stoppedBy) {
      issues.push({
        issueType: crawl.stoppedBy,
        pageId: null,
        pageUrl: startUrl,
      });
    }
    const persistStartedAt = Date.now();
    await AuditRepository.insertIssues(auditId, issues);
    console.info("Audit finalization issues persisted", {
      auditId,
      durationMs: Date.now() - persistStartedAt,
      issueCount: issues.length,
    });
    return { issueCount: issues.length };
  });

  await pgStep(step, "finalize", DB_STEP, async () => {
    const blockedPages = await AuditRepository.countPagesByFetchClass(
      auditId,
      "blocked",
    );
    const rateLimitedPages = await AuditRepository.countPagesByFetchClass(
      auditId,
      "rate_limited",
    );
    const sealed = await sealAuditEvidence({
      auditId,
      projectId,
      workflowInstanceId,
      status: "completed",
      crawl,
    });
    if (!sealed) {
      const audit = await AuditRepository.getAuditForWorkflow(
        auditId,
        workflowInstanceId,
      );
      const legacyManual =
        audit?.projectId === projectId &&
        !audit.isScheduled &&
        audit.requestedStartUrl === null &&
        audit.requestedConfig === null &&
        (audit.status === "running" || audit.status === "completed") &&
        !(await AuditScheduleRepository.getAttempt(auditId));
      if (!legacyManual) throw new Error("Audit evidence seal did not commit");
      // Old manual runs have no frozen request to seal; preserve legacy-unknown evidence.
      await AuditRepository.completeAudit(auditId, workflowInstanceId, {
        pagesCrawled: crawl.pagesCrawled,
        pagesTotal: crawl.pagesCrawled,
      });
      if (
        (await AuditRepository.getAuditForWorkflow(auditId, workflowInstanceId))
          ?.status !== "completed"
      )
        throw new Error("Legacy audit completion did not commit");
    }
    await captureServerEvent({
      distinctId: billingCustomer.userId,
      event: "site_audit:complete",
      organizationId: billingCustomer.organizationId,
      properties: {
        project_id: projectId,
        status: "completed",
        pages_crawled: crawl.pagesCrawled,
        pages_total: crawl.pagesCrawled,
        crawl_completed: crawl.completed,
        pages_blocked: blockedPages,
        pages_rate_limited: rateLimitedPages,
        run_lighthouse: config.lighthouseStrategy !== "none",
      },
    });
    await AuditProgressKV.clear(auditId);
    // Crawl scratch state (frontier, links, mirror) is no longer needed.
    await getAuditScratchpad(auditId).destroy();
  });
}

/**
 * The two finalize checks that need link edges run as SQL inside the
 * audit's scratchpad DO; map their rows onto DetectedIssue.
 */
async function runScratchpadLinkChecks(
  auditId: string,
  startUrl: string,
  crawl: CrawlPhaseResult,
): Promise<DetectedIssue[]> {
  const scratchpad = getAuditScratchpad(auditId);
  const { brokenLinks, orphanPages } = await scratchpad.runFinalizeChecks({
    // Page rows store normalized URLs; normalize the start URL the same way
    // so the orphan exclusion matches.
    startUrl: normalizeUrl(startUrl) ?? startUrl,
    // Orphan detection only makes sense when the crawl wasn't truncated.
    crawlCompleted: crawl.completed,
  });

  return [
    ...brokenLinks.map((row) => ({
      issueType: "broken-internal-link" as const,
      pageId: row.sourcePageId,
      pageUrl: row.sourceUrl,
      dedupeKey: row.targetUrl,
      details: { targetUrl: row.targetUrl, targetStatus: row.targetStatus },
    })),
    ...orphanPages.map((row) => ({
      issueType: "orphan-page" as const,
      pageId: row.pageId,
      pageUrl: row.url,
    })),
  ];
}
