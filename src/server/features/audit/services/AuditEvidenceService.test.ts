import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const { testDb, storage, scratch, runtime } = await vi.hoisted(async () => {
  const { createAuditScheduleTestDb } =
    await import("../repositories/auditScheduleTestDb");
  return {
    testDb: await createAuditScheduleTestDb(),
    storage: new Map<string, string>(),
    scratch: { seen: 1, pending: 0, attempted: 1 },
    runtime: { failStorage: false },
  };
});
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx = {};
  },
  env: {
    DATABASE_PROVIDER: testDb.provider,
    AUTH_MODE: "cloudflare_access",
    SITE_AUDIT_WORKFLOW: {
      get: async () => ({ status: async () => ({ status: "errored" }) }),
    },
    AUDIT_SCRATCHPAD: {
      idFromName: (id: string) => id,
      get: () => ({ getStats: async () => scratch }),
    },
    R2: {
      put: async (key: string, body: string) => {
        if (runtime.failStorage) throw new Error("storage unavailable");
        storage.set(key, body);
      },
      get: async (key: string) =>
        storage.has(key) ? { text: async () => storage.get(key) } : null,
    },
  },
}));
vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));
vi.mock("@/server/lib/runtime-env", () => ({
  usesBetterAuthServer: async () => true,
}));
import { auditPages } from "@/db/schema";
import { AuditRepository } from "../repositories/AuditRepository";
import { AuditEvidenceRepository } from "../repositories/AuditEvidenceRepository";
import { AuditEvidenceService } from "./AuditEvidenceService";
import { sealAuditEvidence } from "./auditEvidenceManifest";
import { WorkspaceMergeService } from "@/server/auth/workspace-merge";
import {
  getAuditsCompletedSince,
  hasCompletedAuditBefore,
} from "../repositories/auditSummaryQueries";
import { now, scope } from "../repositories/auditScheduleTestDb";

const config = {
  maxPages: 10,
  lighthouseStrategy: "none",
  renderJavaScript: false,
} as const;
async function audit(id: string, isScheduled = false) {
  await AuditRepository.createAudit({
    isScheduled,
    id,
    projectId: "project",
    workflowInstanceId: id,
    startedByUserId: "user",
    startUrl: "https://example.com/",
    config,
    pagesTotal: 10,
    lighthouseTotal: 0,
  });
}
async function page(auditId: string, path: string, assessed = true) {
  const id = `${auditId}-${path}`;
  await testDb.db.insert(auditPages).values({
    id,
    auditId,
    url: `https://example.com/${path}`,
    title: path,
    statusCode: assessed ? 200 : 403,
    fetchClass: assessed ? "ok" : "blocked",
    contentAssessed: assessed,
    fetchedAtMs: now,
    isHtml: assessed,
    isLikelyJsShell: false,
    renderingMode: "plain",
    contentHash: assessed ? "a".repeat(64) : null,
  });
  return id;
}
async function seal(
  auditId: string,
  status: "completed" | "failed" = "completed",
) {
  return sealAuditEvidence({
    auditId,
    projectId: "project",
    workflowInstanceId: auditId,
    status,
    crawl: { completed: scratch.pending === 0 },
  });
}
const lighthouseCheck = (
  pageId: string,
  strategy: "mobile" | "desktop",
  performanceScore: number,
) => ({
  pageId,
  url: "https://example.com/same",
  strategy,
  performanceScore,
  accessibilityScore: 90,
  bestPracticesScore: 90,
  seoScore: 90,
  lcpMs: 100,
  cls: 0,
  inpMs: 10,
  ttfbMs: 10,
});
beforeEach(async () => {
  await testDb.seedProject();
  storage.clear();
  runtime.failStorage = false;
  scratch.seen = 1;
  scratch.pending = 0;
  scratch.attempted = 1;
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterAll(testDb.close);

describe(`public audit evidence (${testDb.provider})`, () => {
  it.each([
    ["before", "failed", "db_error"],
    ["after", "failed", "unknown"],
    ["after", "completed", "db_error"],
  ] as const)(
    "refuses incomplete issue persistence in %s (%s/%s) without hiding rows",
    async (failed, status, errorCode) => {
      const healthy = failed === "before" ? "after" : "before";
      for (const id of ["before", "after"]) {
        await audit(id);
        await page(id, "matched");
      }
      const issue = {
        issueType: "thin-content" as const,
        pageUrl: "https://example.com/matched",
      };
      await AuditRepository.insertIssues(healthy, [
        { ...issue, pageId: `${healthy}-matched` },
      ]);
      testDb.failNextBatchAt(1);
      await expect(
        AuditRepository.insertIssues(failed, [
          { ...issue, pageId: `${failed}-matched` },
        ]),
      ).rejects.toThrow();
      await sealAuditEvidence({
        auditId: failed,
        projectId: "project",
        workflowInstanceId: failed,
        status,
        errorCode,
        crawl: { completed: false },
      });
      await seal(healthy);
      expect(
        await AuditEvidenceService.compare(scope, {
          projectId: "project",
          baselineAuditId: "before",
          auditId: "after",
        }),
      ).toMatchObject({
        comparable: false,
        reason: "result_persistence_uncertain",
        issues: [],
        matchedPages: 0,
      });
      const exported: unknown = JSON.parse(
        (
          await AuditEvidenceService.export(scope, {
            projectId: "project",
            auditId: failed,
          })
        ).content,
      );
      expect(exported).toMatchObject({
        pages: [{ id: `${failed}-matched` }],
        issues: [],
      });
    },
  );

  it("compares only assessed URL intersection and never calls a blocked page fixed", async () => {
    for (const id of ["before", "after"]) await audit(id);
    const a = await page("before", "matched");
    const vanished = await page("before", "blocked-later");
    await page("after", "matched");
    await page("after", "blocked-later", false);
    await page("after", "new");
    await AuditRepository.insertIssues("before", [
      {
        issueType: "missing-title",
        pageId: a,
        pageUrl: "https://example.com/matched",
      },
      {
        issueType: "missing-meta-description",
        pageId: vanished,
        pageUrl: "https://example.com/blocked-later",
      },
      {
        issueType: "broken-internal-link",
        pageId: a,
        pageUrl: "https://example.com/matched",
        details: {
          targetUrl: "https://example.com/blocked-later",
          targetStatus: 404,
        },
      },
      {
        issueType: "orphan-page",
        pageId: a,
        pageUrl: "https://example.com/matched",
      },
    ]);
    scratch.seen = 2;
    await seal("before");
    scratch.seen = 3;
    await seal("after");
    const result = await AuditEvidenceService.compare(scope, {
      projectId: "project",
      baselineAuditId: "before",
      auditId: "after",
    });
    expect(result).toMatchObject({
      comparable: true,
      matchedPages: 1,
      enteredUrls: ["https://example.com/new"],
      crossPageIssueReason: "partial_scope_cannot_prove_cross_page_resolution",
    });
    expect(result.issues).toEqual([
      { issueType: "missing-title", baseline: 1, current: 0 },
    ]);
    expect(result.unassessedUrls).toContain(
      "https://example.com/blocked-later",
    );
  });
  it("refuses incompatible configurations and a zero-intersection comparison", async () => {
    await audit("before");
    await audit("after");
    await page("before", "a");
    await page("after", "b");
    await seal("before");
    await seal("after");
    expect(
      (
        await AuditEvidenceService.compare(scope, {
          projectId: "project",
          baselineAuditId: "before",
          auditId: "after",
        })
      ).reason,
    ).toBe("no_matched_assessed_pages");
    await audit("changed");
    await page("changed", "a");
    await AuditRepository.updateAuditStart(
      "changed",
      "https://example.com/different",
      config,
    );
    await seal("changed");
    expect(
      (
        await AuditEvidenceService.compare(scope, {
          projectId: "project",
          baselineAuditId: "before",
          auditId: "changed",
        })
      ).reason,
    ).toBe("configuration_changed");
  });
  it("checks current membership and project scope for every public evidence operation", async () => {
    await audit("private");
    await page("private", "a");
    await seal("private");
    await expect(
      AuditEvidenceService.get(
        { ...scope, organizationId: "foreign" },
        { projectId: "project", auditId: "private" },
      ),
    ).rejects.toThrow();
    await expect(
      AuditEvidenceService.export(scope, {
        projectId: "foreign-project",
        auditId: "private",
      }),
    ).rejects.toThrow();
    await testDb.executeMultiple("delete from member");
    await expect(
      AuditEvidenceService.get(scope, {
        projectId: "project",
        auditId: "private",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      AuditEvidenceService.compare(scope, {
        projectId: "project",
        baselineAuditId: "private",
        auditId: "private",
      }),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("keeps legacy coverage unknown and detects a modified sealed artifact", async () => {
    await audit("legacy");
    await page("legacy", "a");
    await testDb.executeMultiple(
      "update audits set requested_config=null, requested_start_url=null, status='completed' where id='legacy'",
    );
    expect(
      await AuditEvidenceService.get(scope, {
        projectId: "project",
        auditId: "legacy",
      }),
    ).toMatchObject({ state: "legacy_unknown", manifest: null });
    const legacyExport: unknown = JSON.parse(
      (
        await AuditEvidenceService.export(scope, {
          projectId: "project",
          auditId: "legacy",
        })
      ).content,
    );
    expect(legacyExport).toMatchObject({ pages: [{ id: "legacy-a" }] });
    await audit("sealed");
    await page("sealed", "a");
    await seal("sealed");
    const stored = await AuditEvidenceRepository.getForProject(
      "project",
      "organization",
      "sealed",
    );
    if (!stored) throw new Error("No evidence");
    storage.set(stored.artifactKey, "tampered");
    await expect(
      AuditEvidenceService.export(scope, {
        projectId: "project",
        auditId: "sealed",
      }),
    ).rejects.toThrow("integrity");
  });
  it("preserves scheduled mail exclusion after actual workspace transfer without an attempt row", async () => {
    await audit("scheduled", true);
    await page("scheduled", "a");
    await seal("scheduled");
    await testDb.executeMultiple(
      `insert into organization(id,name,slug,created_at) values ('delegated-old','Old workspace','old',${testDb.provider === "postgres" ? "now()" : "0"}),('shared-workspace','Shared','shared',${testDb.provider === "postgres" ? "now()" : "0"}); update projects set organization_id='delegated-old' where id='project'`,
    );
    expect(await WorkspaceMergeService.mergeLegacyWorkspaces()).toMatchObject({
      mergedWorkspaces: 1,
    });
    expect(
      (await AuditRepository.getAuditForProject("scheduled", "project"))
        ?.isScheduled,
    ).toBe(true);
    expect(await getAuditsCompletedSince("2026-11-02T11:00:00.000Z")).toEqual(
      [],
    );
    expect(
      await hasCompletedAuditBefore("user", "2026-11-02T13:00:00.000Z"),
    ).toBe(false);
  });
  it("compares Lighthouse only on matched successfully measured URL and device pairs", async () => {
    await audit("before");
    await audit("after");
    const before = await page("before", "same");
    const after = await page("after", "same");
    await AuditRepository.insertLighthouseResults("before", [
      lighthouseCheck(before, "mobile", 70),
      lighthouseCheck(before, "desktop", 95),
    ]);
    await AuditRepository.insertLighthouseResults("after", [
      lighthouseCheck(after, "mobile", 80),
    ]);
    await seal("before");
    await seal("after");
    const result = await AuditEvidenceService.compare(scope, {
      projectId: "project",
      baselineAuditId: "before",
      auditId: "after",
    });
    expect(result.matchedLighthouseChecks).toBe(1);
    expect(result.lighthouse).toMatchObject([
      {
        url: "https://example.com/same",
        strategy: "mobile",
        baseline: { performanceScore: 70 },
        current: { performanceScore: 80 },
      },
    ]);
  });
});
