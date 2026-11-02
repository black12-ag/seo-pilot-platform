import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const { testDb, engine, network, onboarding, artifacts } = await vi.hoisted(
  async () => {
    const { createAuditScheduleTestDb } =
      await import("../repositories/auditScheduleTestDb");
    return {
      testDb: await createAuditScheduleTestDb(),
      engine: {
        state: "missing",
        created:
          vi.fn<(input: WorkflowInstanceCreateOptions) => Promise<void>>(),
        terminate: vi.fn(),
      },
      network: vi.fn(),
      onboarding: vi.fn(),
      artifacts: new Map<string, string>(),
    };
  },
);
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx = {};
  },
  env: {
    DATABASE_PROVIDER: testDb.provider,
    R2: {
      put: async (key: string, value: string) => {
        artifacts.set(key, value);
      },
    },
    SITE_AUDIT_WORKFLOW: {
      create: engine.created,
      get: async () => {
        if (engine.state === "missing")
          throw new Error("WORKFLOW_ERROR: instance does not exist");
        if (engine.state === "unknown")
          throw new Error("control plane unavailable");
        return {
          status: async () => ({ status: engine.state }),
          terminate: engine.terminate,
        };
      },
    },
    AUDIT_ENGINE: {
      getStats: async () => ({ seen: 0, pending: 0, attempted: 0 }),
    },
  },
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class extends Error {},
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));
vi.mock("@/server/lib/runtime-env", () => ({
  usesBetterAuthServer: async () => true,
  isHostedServerAuthMode: async () => false,
  getOptionalEnvValue: async (name: string) =>
    name === "AUDIT_RECURRING_POLICY" ? JSON.stringify(policy) : undefined,
}));
vi.mock("@/server/lib/public-dns", () => ({
  resolvePublicDnsRecords: network,
}));
vi.mock("@/server/billing/subscription", () => ({
  customerHasPaidPlan: vi.fn(),
  getOrCreateOrganizationCustomer: vi.fn(),
}));
vi.mock("@/server/lib/audit/rendering-billing", () => ({
  lockRenderingCredits: vi.fn(),
  releaseRenderingLocks: vi.fn(),
}));
vi.mock("@/server/email/onboarding-drip", () => ({
  markOnboardingMilestone: onboarding,
}));
vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));
import { now, policy, testSchedule } from "../repositories/auditScheduleTestDb";
import { AuditScheduleRepository } from "../repositories/AuditScheduleRepository";
import { AuditBudgetRepository } from "../repositories/AuditBudgetRepository";
import { AuditService } from "./AuditService";
import { AuditEvidenceService } from "./AuditEvidenceService";
import { getAuditsCompletedSince } from "../repositories/auditSummaryQueries";
import { runScheduledAudits } from "./scheduledAudits";
import { recoverScheduledAudit } from "./scheduledAuditRecovery";
import { assertAuditExecutionAllowed } from "./auditExecutionFence";

beforeEach(async () => {
  await testDb.seedProject();
  artifacts.clear();
  engine.state = "missing";
  engine.created.mockImplementation(async () => {
    engine.state = "running";
  });
  engine.terminate.mockImplementation(async () => {
    engine.state = "terminated";
  });
  network.mockResolvedValue({
    Status: 0,
    Answer: [{ type: 1, data: "93.184.216.34" }],
  });
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterAll(testDb.close);
async function attemptRow() {
  const rows = await AuditScheduleRepository.listAttempts(
    {
      organizationId: "organization",
      userId: "user",
      role: "owner",
      requireMembership: true,
    },
    "project",
    25,
  );
  if (!rows[0]) throw new Error("No attempt");
  return rows[0];
}
async function nextTick(minutes = 5) {
  vi.spyOn(Date, "now").mockReturnValue(now + minutes * 60_000);
  return runScheduledAudits();
}

describe(`public scheduled audit recovery (${testDb.provider})`, () => {
  it("launches plain HTTP with no DataForSEO or mail and one stable audit ID", async () => {
    await testSchedule(AuditScheduleRepository);
    expect(await runScheduledAudits()).toMatchObject({
      admitted: 1,
      running: 1,
    });
    const attempt = await attemptRow();
    expect(attempt.launchState).toBe("running");
    expect(attempt.auditId).toBe(attempt.id);
    expect(engine.created.mock.calls[0][0]).toMatchObject({
      id: attempt.id,
      retention: { successRetention: "1 day", errorRetention: "1 day" },
      params: {
        auditId: attempt.id,
        scheduledAttemptId: attempt.id,
        config: { renderJavaScript: false, lighthouseStrategy: "none" },
      },
    });
    expect(onboarding).not.toHaveBeenCalled();
    await nextTick();
    expect(engine.created).toHaveBeenCalledTimes(1);
    expect(
      (await AuditBudgetRepository.getUsage("organization", "2026-11-02"))
        ?.reservedRuns,
    ).toBe(1);
  });
  it("recovers durable slot intent after admission committed before launch", async () => {
    const schedule = await testSchedule(AuditScheduleRepository);
    await AuditScheduleRepository.admitSlot(
      schedule,
      {
        dueAtMs: now,
        nextDueAtMs: now + 86400000,
        firstMissedAtMs: now,
        lastMissedAtMs: now,
        missedCount: 1,
      },
      now,
    );
    expect(await runScheduledAudits()).toMatchObject({
      recovered: 1,
      admitted: 0,
      running: 1,
    });
    expect(engine.created).toHaveBeenCalledTimes(1);
  });
  it("attaches a fast terminal instance after a lost create reply without replay", async () => {
    await testSchedule(AuditScheduleRepository);
    engine.created.mockImplementation(async () => {
      engine.state = "complete";
      throw new Error("reply lost");
    });
    expect(await runScheduledAudits()).toMatchObject({ terminal: 1 });
    const attempt = await attemptRow();
    expect(attempt.launchState).toBe("failed");
    expect(attempt.reason).toContain("workflow_failed");
    await nextTick();
    expect(engine.created).toHaveBeenCalledTimes(1);
    expect(
      (await AuditBudgetRepository.getUsage("organization", "2026-11-02"))
        ?.consumedPages,
    ).toBe(10);
  });
  it("keeps unknown create outcome reserved and never treats status failure as absence", async () => {
    await testSchedule(AuditScheduleRepository);
    engine.created.mockImplementation(async () => {
      engine.state = "unknown";
      throw new Error("reply lost");
    });
    expect(await runScheduledAudits()).toMatchObject({ deferred: 1 });
    await nextTick(20);
    expect(engine.created).toHaveBeenCalledTimes(1);
    const attempt = await attemptRow();
    expect(attempt.billingState).toBe("reserved");
    expect(attempt.reason).toBe("workflow_status_unknown");
  });
  it("retries the same unobserved ID at most three times inside its retention window", async () => {
    await testSchedule(AuditScheduleRepository);
    engine.created.mockImplementation(async () => {
      throw new Error("definitive refusal");
    });
    await runScheduledAudits();
    await nextTick(5);
    await nextTick(10);
    await nextTick(15);
    expect(engine.created).toHaveBeenCalledTimes(3);
    expect(
      new Set(engine.created.mock.calls.map((call) => call[0].id)).size,
    ).toBe(1);
    expect((await attemptRow()).launchState).toBe("failed");
  });
  it("does not recreate an observed or expired-retention instance", async () => {
    await testSchedule(AuditScheduleRepository);
    await runScheduledAudits();
    const original = await attemptRow();
    engine.state = "missing";
    vi.spyOn(Date, "now").mockReturnValue(now + 48 * 60 * 60_000);
    await recoverScheduledAudit(original.id);
    expect(engine.created).toHaveBeenCalledTimes(1);
    expect((await attemptRow()).launchState).toBe("failed");
  });
  it("rechecks sponsor between execution chunks and recovers archived work", async () => {
    await testSchedule(AuditScheduleRepository);
    await runScheduledAudits();
    const attempt = await attemptRow();
    await testDb.executeMultiple(
      "update member set role='admin'; update projects set archived_at='2026-11-02T12:00:00Z' where id='project'",
    );
    await expect(
      assertAuditExecutionAllowed(attempt.id, attempt.id),
    ).rejects.toThrow("no longer authorized");
    await nextTick();
    expect(engine.terminate).toHaveBeenCalledTimes(1);
    expect(
      (await AuditScheduleRepository.getAttempt(attempt.id))?.launchState,
    ).toBe("failed");
  });
  it("stale lease cannot start a second audit and frozen inputs reject client fields", async () => {
    const schedule = await testSchedule(AuditScheduleRepository);
    const attempt = await AuditScheduleRepository.admitSlot(
      schedule,
      {
        dueAtMs: now,
        nextDueAtMs: now + 86400000,
        firstMissedAtMs: now,
        lastMissedAtMs: now,
        missedCount: 1,
      },
      now,
    );
    if (!attempt) throw new Error("Admission failed");
    await expect(
      AuditService.startAudit({
        scheduledAttemptId: attempt.id,
        leaseToken: "stale",
      }),
    ).rejects.toThrow("launch_lease_lost");
    expect(engine.created).not.toHaveBeenCalled();
    expect(await recoverScheduledAudit(attempt.id)).toBe("running");
  });
  it("concurrent public ticks share one admission and one workflow create", async () => {
    await testSchedule(AuditScheduleRepository);
    await Promise.all([runScheduledAudits(), runScheduledAudits()]);
    expect(engine.created).toHaveBeenCalledTimes(1);
    expect(
      await testDb.execute("select id from audit_schedule_attempts"),
    ).toHaveLength(1);
    expect(
      (await AuditBudgetRepository.getUsage("organization", "2026-11-02"))
        ?.reservedRuns,
    ).toBe(1);
  });
  it("keeps an explicit deletion tombstone and never relaunches the deleted result", async () => {
    await testSchedule(AuditScheduleRepository);
    await runScheduledAudits();
    const attempt = await attemptRow();
    await AuditService.remove(attempt.id, "project");
    expect(
      await AuditEvidenceService.get(
        { organizationId: "organization", userId: "user", role: "owner" },
        { projectId: "project", auditId: attempt.id },
      ),
    ).toMatchObject({ state: "deleted" });
    await nextTick();
    expect(engine.created).toHaveBeenCalledTimes(1);
    expect(
      (await AuditBudgetRepository.getUsage("organization", "2026-11-02"))
        ?.reservedRuns,
    ).toBe(0);
  });
  it("excludes scheduled results from first-audit mail while preserving manual candidates", async () => {
    await testSchedule(AuditScheduleRepository);
    await runScheduledAudits();
    await testDb.executeMultiple(
      "update audits set status='completed', completed_at='2026-11-02T12:01:00.000Z'; insert into audits(id,project_id,started_by_user_id,start_url,status,config,completed_at) values ('manual','project','user','https://example.com/','completed','{}','2026-11-02T12:01:00.000Z')",
    );
    expect(
      (await getAuditsCompletedSince("2026-11-02T12:00:00.000Z")).map(
        (row) => row.id,
      ),
    ).toEqual(["manual"]);
  });
});
