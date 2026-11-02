import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// Migrations and provider must be selected before importing the real repository.
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../../site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));
import { AuditRepository } from "./AuditRepository";
import { AuditEvidenceRepository } from "./AuditEvidenceRepository";
import { auditPages } from "@/db/schema";
import { auditResultSelect, writeAuditResults } from "./auditRunWrites";

const config = {
  maxPages: 10,
  lighthouseStrategy: "none",
  renderJavaScript: false,
} as const;
async function insertPage(id = "page", title = "Original") {
  await writeAuditResults("audit", [id], (tx, pageId) =>
    tx
      .insert(auditPages)
      .select(
        auditResultSelect(
          auditPages,
          {
            id: pageId,
            auditId: "audit",
            url: `https://example.com/${pageId}`,
            title,
            fetchedAtMs: 100,
            contentAssessed: true,
          },
          "audit",
        ),
      )
      .onConflictDoUpdate({ target: auditPages.id, set: { title } }),
  );
}
beforeEach(async () => {
  await testDb.seedProject();
  await AuditRepository.createAudit({
    id: "audit",
    projectId: "project",
    startedByUserId: "user",
    startUrl: "https://example.com/",
    workflowInstanceId: "audit",
    config,
    pagesTotal: 10,
    lighthouseTotal: 0,
  });
});
afterAll(testDb.close);

describe(`audit immutable write fence (${testDb.provider})`, () => {
  it("retains more than five unique issues across retries and refuses post-seal additions", async () => {
    await insertPage();
    const issues = Array.from({ length: 12 }, (_, index) => ({
      issueType: "broken-internal-link" as const,
      pageId: "page",
      pageUrl: "https://example.com/page",
      dedupeKey: `https://example.com/missing-${index}`,
      details: { targetUrl: `https://example.com/missing-${index}` },
    }));
    await AuditRepository.insertIssues("audit", issues);
    const initial = await AuditRepository.getIssuesForAudit("audit", {});
    expect(initial).toHaveLength(12);
    expect(new Set(initial.map((issue) => issue.id)).size).toBe(12);
    await AuditRepository.insertIssues("audit", issues);
    expect(await AuditRepository.getIssuesForAudit("audit", {})).toEqual(
      initial,
    );
    await AuditEvidenceRepository.beginSeal({
      auditId: "audit",
      projectId: "project",
      workflowInstanceId: "audit",
      nowMs: 1000,
    });
    await AuditRepository.insertIssues("audit", [
      ...issues,
      { ...issues[0], dedupeKey: "late-addition" },
    ]);
    expect(await AuditRepository.getIssuesForAudit("audit", {})).toEqual(
      initial,
    );
  });

  it("preserves original request while effective target changes", async () => {
    await AuditRepository.updateAuditStart(
      "audit",
      "https://example.com/resolved",
      { ...config, sitePlatform: "shopify" },
    );
    const row = await AuditRepository.getAuditForProject("audit", "project");
    expect(row?.startUrl).toBe("https://example.com/resolved");
    expect(row?.requestedStartUrl).toBe("https://example.com/");
    expect(JSON.parse(row?.requestedConfig ?? "null")).toEqual(config);
  });
  it("serializes page insert/upsert and progress behind a persistent seal", async () => {
    await insertPage();
    const claim = await AuditEvidenceRepository.beginSeal({
      auditId: "audit",
      projectId: "project",
      workflowInstanceId: "audit",
      nowMs: 1000,
    });
    expect(claim?.token).toBeTruthy();
    await insertPage("page", "Late overwrite");
    await insertPage("late");
    await AuditRepository.updateAuditStart(
      "audit",
      "https://example.com/late",
      config,
    );
    await AuditRepository.updateAuditProgress("audit", "audit", {
      pagesCrawled: 999,
    });
    await AuditRepository.insertIssues("audit", [
      {
        issueType: "orphan-page",
        pageId: "page",
        pageUrl: "https://example.com/page",
      },
    ]);
    await AuditRepository.insertLighthouseResults("audit", [
      {
        pageId: "page",
        url: "https://example.com/page",
        strategy: "mobile",
        performanceScore: 95,
        accessibilityScore: 95,
        bestPracticesScore: 95,
        seoScore: 95,
        lcpMs: 1,
        cls: 0,
        inpMs: 1,
        ttfbMs: 1,
      },
    ]);
    expect(await AuditRepository.failAudit("audit", "audit")).toBe(false);
    const results = await AuditRepository.getAuditResultsForProject(
      "audit",
      "project",
    );
    expect(results.pages.map((page) => page.title)).toEqual(["Original"]);
    expect(results.issues).toEqual([]);
    expect(results.lighthouse).toEqual([]);
    expect(results.audit?.pagesCrawled).toBe(0);
    expect(results.audit?.startUrl).toBe("https://example.com/");
    expect(
      await AuditEvidenceRepository.beginSeal({
        auditId: "audit",
        projectId: "project",
        workflowInstanceId: "audit",
        nowMs: 2000,
      }),
    ).toEqual(claim);
  });
  it("rolls back a failed result batch and never reports a failed stale transition", async () => {
    testDb.failNextBatchAt(2);
    await expect(insertPage()).rejects.toThrow();
    expect(
      (await AuditRepository.getAuditResultsForProject("audit", "project"))
        .pages,
    ).toEqual([]);
    await AuditRepository.completeAudit("audit", "audit", {
      pagesCrawled: 0,
      pagesTotal: 0,
    });
    expect(await AuditRepository.failAudit("audit", "audit")).toBe(false);
    await insertPage();
    expect(
      (await AuditRepository.getAuditResultsForProject("audit", "project"))
        .pages,
    ).toEqual([]);
  });
  it("does not acquire a seal through a foreign project or workflow identity", async () => {
    expect(
      await AuditEvidenceRepository.beginSeal({
        auditId: "audit",
        projectId: "foreign-project",
        workflowInstanceId: "audit",
        nowMs: 1000,
      }),
    ).toBeNull();
    expect(
      await AuditEvidenceRepository.beginSeal({
        auditId: "audit",
        projectId: "project",
        workflowInstanceId: "other",
        nowMs: 1000,
      }),
    ).toBeNull();
    await insertPage();
    expect(
      (await AuditRepository.getAuditResultsForProject("audit", "project"))
        .pages,
    ).toHaveLength(1);
  });
  it.skipIf(!testDb.pg)(
    "serializes a live PostgreSQL seal ahead of a competing result write",
    async () => {
      const pg = testDb.pg;
      if (!pg) return;
      let release!: () => void;
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = pg.begin(async (transaction) => {
        await transaction`select id from audits where id='audit' for update`;
        locked();
        await gate;
      });
      await ready;
      const seal = AuditEvidenceRepository.beginSeal({
        auditId: "audit",
        projectId: "project",
        workflowInstanceId: "audit",
        nowMs: 1000,
      });
      let waiting = false;
      for (let index = 0; index < 100; index++) {
        const rows =
          await pg`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`;
        if (Number(rows[0].count) > 0) {
          waiting = true;
          break;
        }
      }
      if (!waiting) {
        release();
        await blocker;
        await seal;
        throw new Error("Seal did not block on the actual audit lock");
      }
      const lateWrite = insertPage("racing");
      release();
      await blocker;
      await Promise.all([seal, lateWrite]);
      expect(
        (await AuditRepository.getAuditResultsForProject("audit", "project"))
          .pages,
      ).toEqual([]);
    },
  );
});
