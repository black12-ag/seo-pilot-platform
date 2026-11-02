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
import { AuditEvidenceService } from "./AuditEvidenceService";
import { reconcileRunningAudit } from "./auditReconciler";
import { sealAuditEvidence } from "./auditEvidenceManifest";
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

describe(`audit manifest recovery (${testDb.provider})`, () => {
  it("seals actual observations and exports rows with verified storage hashes", async () => {
    await audit("one");
    const pageId = await page("one", "a");
    await AuditRepository.insertIssues("one", [
      { issueType: "missing-title", pageId, pageUrl: "https://example.com/a" },
    ]);
    expect(await seal("one")).toBe(true);
    const evidence = await AuditEvidenceService.get(scope, {
      projectId: "project",
      auditId: "one",
    });
    expect(evidence.manifest).toMatchObject({
      coverage: { state: "complete", attempted: 1, assessed: 1, pending: 0 },
      observedStartAtMs: now,
      observedEndAtMs: now,
      terminalStatus: "completed",
    });
    const exported = await AuditEvidenceService.export(scope, {
      projectId: "project",
      auditId: "one",
    });
    const content: unknown = JSON.parse(exported.content);
    expect(content).toMatchObject({
      pages: [{ id: pageId, url: "https://example.com/a", fetchedAtMs: now }],
      issues: [{ issueType: "missing-title" }],
      manifest: evidence.manifest,
    });
    expect(evidence.manifest?.artifact.sha256).toHaveLength(64);
    expect(evidence.manifest?.requestedHash).toHaveLength(64);
  });
  it("records partial and failed coverage instead of equating rows with assessed pages", async () => {
    await audit("partial");
    await page("partial", "a");
    await page("partial", "blocked", false);
    scratch.seen = 12;
    scratch.pending = 10;
    expect(await seal("partial", "failed")).toBe(true);
    const result = await AuditEvidenceService.get(scope, {
      projectId: "project",
      auditId: "partial",
    });
    expect(result.manifest?.coverage).toMatchObject({
      state: "partial",
      attempted: 2,
      assessed: 1,
      blocked: 1,
      discoveredLowerBound: 12,
      pending: 10,
    });
    expect(result.manifest?.coverage.stopReasons).toEqual(
      expect.arrayContaining([
        "workflow_failed",
        "frontier_remaining",
        "blocked_pages",
        "unassessed_pages",
      ]),
    );
  });
  it("recovers after storage failure with the same seal timestamp and frozen rows", async () => {
    await audit("crash");
    await page("crash", "a");
    runtime.failStorage = true;
    await expect(seal("crash")).rejects.toThrow("storage unavailable");
    const before = await AuditRepository.getAuditForProject("crash", "project");
    expect(before?.status).toBe("running");
    expect(before?.evidenceSealToken).toBeTruthy();
    await AuditRepository.updateAuditProgress("crash", "crash", {
      pagesCrawled: 99,
    });
    runtime.failStorage = false;
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    expect(
      await reconcileRunningAudit({
        id: "crash",
        workflowInstanceId: "crash",
        startedAt: new Date(now).toISOString(),
        currentPhase: "finalizing",
      }),
    ).toBeTruthy();
    const result = await AuditEvidenceService.get(scope, {
      projectId: "project",
      auditId: "crash",
    });
    expect(result.manifest?.finalizedAtMs).toBe(now);
    expect(await seal("crash", "completed")).toBe(true);
    expect(
      (await AuditRepository.getAuditForProject("crash", "project"))?.status,
    ).toBe("failed");
  });
});
