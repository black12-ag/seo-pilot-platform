import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
const { testDb, storage, destroy, runtime } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../features/site-authority/siteAuthorityTestDb");
  return {
    testDb: await createSiteAuthorityTestDb(),
    storage: new Map<string, string>(),
    destroy: vi.fn(),
    runtime: { storageUnavailable: false },
  };
});
vi.mock("cloudflare:workers", () => ({
  DurableObject: vi.fn(),
  env: {
    DATABASE_PROVIDER: testDb.provider,
    AUTH_MODE: "password",
    AUDIT_SCRATCHPAD: {
      idFromName: (id: string) => id,
      get: () => ({
        getStats: async () => ({ seen: 1, pending: 0, attempted: 1 }),
        runFinalizeChecks: async () => ({ brokenLinks: [], orphanPages: [] }),
        destroy,
      }),
    },
    R2: {
      put: async (key: string, value: string) => {
        if (runtime.storageUnavailable) throw new Error("Storage unavailable");
        storage.set(key, value);
      },
    },
    KV: { delete: async () => {} },
  },
}));
vi.mock("@/db", () => ({
  db: testDb.db,
  withPgClient: (fn: () => unknown) => fn(),
}));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));
vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { AuditEvidenceService } from "@/server/features/audit/services/AuditEvidenceService";
import { audits, auditPages } from "@/db/schema";
import { finalizeAudit } from "./siteAuditFinalize";
const now = Date.parse("2026-11-02T12:00:00Z");
const config = {
  maxPages: 10,
  lighthouseStrategy: "none",
  renderJavaScript: false,
} as const;
const actor = { organizationId: "organization", userId: "user", role: "owner" };
beforeEach(async () => {
  await testDb.seedProject();
  storage.clear();
  runtime.storageUnavailable = false;
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterAll(testDb.close);
async function create(isScheduled = false) {
  await AuditRepository.createAudit({
    id: "audit",
    projectId: "project",
    startedByUserId: "user",
    workflowInstanceId: "audit",
    startUrl: "https://example.com/",
    config,
    pagesTotal: 10,
    lighthouseTotal: 0,
    isScheduled,
  });
  await testDb.db.insert(auditPages).values({
    id: "page",
    auditId: "audit",
    url: "https://example.com/",
    statusCode: 200,
    fetchClass: "ok",
    fetchedAtMs: now,
    contentAssessed: true,
    isHtml: true,
    isLikelyJsShell: false,
    renderingMode: "plain",
  });
}
function finalize(workflowInstanceId = "audit") {
  return finalizeAudit({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime step boundary only; callbacks and SQL are real
    step: {
      do: async (_name: string, _config: unknown, fn: () => Promise<unknown>) =>
        fn(),
    } as unknown as WorkflowStep,
    auditId: "audit",
    workflowInstanceId,
    projectId: "project",
    startUrl: "https://example.com/",
    config,
    billingCustomer: {
      userId: "user",
      userEmail: "authority@example.com",
      organizationId: "organization",
      projectId: "project",
    },
    crawl: { pagesCrawled: 1, completed: true },
  });
}
describe(`manual finalization compatibility (${testDb.provider})`, () => {
  it("completes a genuine pre-migration manual run while preserving unknown evidence", async () => {
    await create();
    await testDb.executeMultiple(
      "update audits set requested_config=null, requested_start_url=null",
    );
    await finalize();
    expect(
      await AuditRepository.getAuditForProject("audit", "project"),
    ).toMatchObject({
      status: "completed",
      requestedStartUrl: null,
      requestedConfig: null,
      isScheduled: false,
    });
    expect(
      await AuditEvidenceService.get(actor, {
        projectId: "project",
        auditId: "audit",
      }),
    ).toMatchObject({ state: "legacy_unknown", manifest: null });
    expect(storage.size).toBe(0);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("new manual runs still commit immutable evidence before cleanup", async () => {
    await create();
    await finalize();
    expect(
      await AuditEvidenceService.get(actor, {
        projectId: "project",
        auditId: "audit",
      }),
    ).toMatchObject({ state: "sealed" });
    expect(storage.size).toBe(1);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("storage failure on a new manual run never falls back to legacy completion", async () => {
    await create();
    runtime.storageUnavailable = true;
    await expect(finalize()).rejects.toThrow("Storage unavailable");
    expect(
      (await AuditRepository.getAuditForProject("audit", "project"))?.status,
    ).toBe("running");
    expect(destroy).not.toHaveBeenCalled();
  });
  it("cannot treat a scheduled run with absent requested metadata as legacy", async () => {
    await create(true);
    await testDb.executeMultiple(
      "update audits set requested_config=null, requested_start_url=null",
    );
    await expect(finalize()).rejects.toThrow(
      "Audit evidence seal did not commit",
    );
    expect(
      (await AuditRepository.getAuditForProject("audit", "project"))?.status,
    ).toBe("running");
    expect(destroy).not.toHaveBeenCalled();
  });
  it.each([null, "invalid-json"])(
    "cannot bypass sealing for incomplete or malformed new metadata: %s",
    async (requestedConfig) => {
      await create();
      await testDb.db.update(audits).set({ requestedConfig });
      await expect(finalize()).rejects.toThrow(
        "Audit evidence seal did not commit",
      );
      expect(destroy).not.toHaveBeenCalled();
    },
  );
  it("legacy completion remains bound to the exact workflow identity", async () => {
    await create();
    await testDb.executeMultiple(
      "update audits set requested_config=null, requested_start_url=null",
    );
    await expect(finalize("different-workflow")).rejects.toThrow(
      "Audit evidence seal did not commit",
    );
    expect(
      (await AuditRepository.getAuditForProject("audit", "project"))?.status,
    ).toBe("running");
    expect(destroy).not.toHaveBeenCalled();
  });
});
