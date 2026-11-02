import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const { testDb, runtime } = await vi.hoisted(async () => {
  const { createAuditScheduleTestDb } =
    await import("../repositories/auditScheduleTestDb");
  return {
    testDb: await createAuditScheduleTestDb(),
    runtime: { policy: "", account: true, hosted: false },
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  usesBetterAuthServer: async () => runtime.account,
  isHostedServerAuthMode: async () => runtime.hosted,
  getOptionalEnvValue: async () => runtime.policy,
}));
import { billingCustomerStatus } from "@/db/schema";
import { AuditScheduleRepository as schedules } from "../repositories/AuditScheduleRepository";
import { AuditBudgetRepository as budget } from "../repositories/AuditBudgetRepository";
import { testAttempt } from "../repositories/auditScheduleTestDb";
import { AuditScheduleService as service } from "./AuditScheduleService";
import {
  now,
  policy,
  scope,
  scheduleInput,
} from "../repositories/auditScheduleTestDb";
beforeEach(async () => {
  await testDb.seedProject();
  runtime.policy = JSON.stringify(policy);
  runtime.account = true;
  runtime.hosted = false;
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network in schedule review"),
  );
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterAll(testDb.close);
async function savePaused() {
  const input = scheduleInput();
  const estimate = await service.estimate(scope, input);
  const result = await service.save(scope, {
    ...input,
    expectedVersion: 0,
    estimateFingerprint: estimate.estimateFingerprint,
  });
  if (!result.schedule) throw new Error("No saved schedule");
  return result.schedule;
}
describe(`public schedule service (${testDb.provider})`, () => {
  it.each([
    ["completed", null],
    ["failed", null],
    ["skipped", null],
    ["cancelled", null],
    ["pending", now + 5000],
    ["launching", now + 5000],
    ["running", now + 5000],
  ] as const)(
    "reports the correct retry time for %s attempts",
    async (state, expectedRetry) => {
      const attempt = await testAttempt(schedules);
      await testDb.executeMultiple(
        `update audit_schedule_attempts set launch_state='${state}', retry_at_ms=${now + 5000} where id='${attempt.id}'`,
      );
      expect((await schedules.getAttempt(attempt.id))?.retryAtMs).toBe(
        now + 5000,
      );
      const result = await service.listAttempts(scope, {
        projectId: "project",
        limit: 25,
      });
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({
        id: attempt.id,
        launchState: state,
        retryAtMs: expectedRetry,
      });
    },
  );
  it("estimates and saves paused without network; enable is explicit and future", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const saved = await savePaused();
    expect(saved).toMatchObject({
      state: "paused",
      version: 1,
      nextDueAtMs: null,
    });
    const settings = { ...saved.settings, state: "enabled" } as const;
    const estimate = await service.estimate(scope, settings);
    const enabled = await service.save(scope, {
      ...settings,
      expectedVersion: saved.version,
      estimateFingerprint: estimate.estimateFingerprint,
    });
    expect(enabled.schedule?.state).toBe("enabled");
    expect(enabled.schedule?.nextDueAtMs).toBeGreaterThan(now);
    expect(await testDb.execute("select id from audits")).toHaveLength(0);
    expect(network).not.toHaveBeenCalled();
  });
  it("new schedules cannot start enabled", async () => {
    const input = scheduleInput({ state: "enabled" });
    const estimate = await service.estimate(scope, input);
    await expect(
      service.save(scope, {
        ...input,
        expectedVersion: 0,
        estimateFingerprint: estimate.estimateFingerprint,
      }),
    ).rejects.toThrow("paused");
  });
  it("missing policy and unsupported delegated background remain visible", async () => {
    const saved = await savePaused();
    runtime.policy = "not-json";
    const input = { ...saved.settings, state: "enabled" } as const;
    const estimate = await service.estimate(scope, input);
    expect(estimate.blockedReasons).toContain(
      "recurring_policy_not_configured",
    );
    await expect(
      service.save(scope, {
        ...input,
        expectedVersion: 1,
        estimateFingerprint: estimate.estimateFingerprint,
      }),
    ).rejects.toThrow("recurring_policy_not_configured");
    runtime.policy = JSON.stringify(policy);
    runtime.account = false;
    expect((await service.estimate(scope, input)).blockedReasons).toContain(
      "unsupported_background_authority",
    );
  });
  it("paid selection is rejected without silently changing the request", async () => {
    const input = scheduleInput({ renderJavaScript: true });
    const estimate = await service.estimate(scope, input);
    expect(estimate.blockedReasons).toContain("paid_recurrence_unavailable");
    await expect(
      service.save(scope, {
        ...input,
        expectedVersion: 0,
        estimateFingerprint: estimate.estimateFingerprint,
      }),
    ).rejects.toThrow("paid_recurrence_unavailable");
  });
  it("current owner permission is required even with stale owner context", async () => {
    const input = scheduleInput();
    const estimate = await service.estimate(scope, input);
    await testDb.executeMultiple("update member set role='admin'");
    await expect(
      service.save(scope, {
        ...input,
        expectedVersion: 0,
        estimateFingerprint: estimate.estimateFingerprint,
      }),
    ).rejects.toThrow("owner_required");
  });
  it("returns actual scoped daily allowance and outstanding work from prior days", async () => {
    const attempt = await testAttempt(schedules);
    await budget.reserve(attempt.id, attempt.leaseToken, policy, now);
    await testDb.executeMultiple(
      "update audit_schedule_daily_usage set utc_day='2026-11-01'; update audit_schedule_attempts set reserved_day='2026-11-01'; insert into audit_schedule_daily_usage(organization_id,utc_day,consumed_pages) values('foreign','2026-11-02',99)",
    );
    expect(
      (await service.get(scope, { projectId: "project" })).usage,
    ).toMatchObject({
      utcDay: "2026-11-02",
      reservedPages: 0,
      consumedPages: 0,
      outstandingRuns: 1,
      unknownRuns: 0,
      pageAccounting: "admission_units_including_conservative_upper_bounds",
    });
  });
  it("strict wire rejects invalid weekly clocks and client-supplied identity", async () => {
    await expect(
      service.estimate(scope, {
        ...scheduleInput(),
        cadence: "weekly",
        weekday: 7,
      }),
    ).rejects.toThrow();
    const injected = { ...scheduleInput(), organizationId: "foreign" };
    await expect(service.estimate(scope, injected)).rejects.toThrow();
    await expect(
      service.get(scope, { projectId: "foreign-project" }),
    ).rejects.toThrow();
  });
  it("fingerprint reapproval and version CAS refuse stale changes", async () => {
    const saved = await savePaused();
    const input = { ...saved.settings, maxPages: 20 };
    const old = await service.estimate(scope, saved.settings);
    await expect(
      service.save(scope, {
        ...input,
        expectedVersion: 1,
        estimateFingerprint: old.estimateFingerprint,
      }),
    ).rejects.toThrow("budget_reapproval");
    const estimate = await service.estimate(scope, input);
    await expect(
      service.save(scope, {
        ...input,
        expectedVersion: 0,
        estimateFingerprint: estimate.estimateFingerprint,
      }),
    ).rejects.toThrow("version");
  });
});

async function storedBilling(
  isPaying: boolean,
  paidPlanStatus: string | null,
  organizationId = "organization",
) {
  await testDb.db.insert(billingCustomerStatus).values({
    organizationId,
    isPaying,
    paidPlanStatus,
    paidPlanId: "paid-plan",
    customerJson: "{}",
    syncedAt: new Date(now).toISOString(),
  });
}
describe(`zero-network tier review (${testDb.provider})`, () => {
  it("missing hosted status ignores foreign paid projection and refuses over-limit enable", async () => {
    runtime.hosted = true;
    await storedBilling(true, "active", "foreign");
    const input = scheduleInput({ maxPages: 100 });
    const review = await service.estimate(scope, input);
    expect(review).toMatchObject({
      maxPagesPerRun: 50,
      blockedReasons: ["page_limit"],
    });
    const saved = await service.save(scope, {
      ...input,
      expectedVersion: 0,
      estimateFingerprint: review.estimateFingerprint,
    });
    expect(saved.schedule?.settings.maxPages).toBe(100);
    await expect(
      service.save(scope, {
        ...input,
        state: "enabled",
        expectedVersion: 1,
        estimateFingerprint: review.estimateFingerprint,
      }),
    ).rejects.toThrow("page_limit");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each([
    [false, null],
    [false, "active"],
    [true, "past_due"],
    [true, null],
  ] as const)(
    "unconfirmed status %s/%s remains on the free ceiling",
    async (isPaying, status) => {
      runtime.hosted = true;
      await storedBilling(isPaying, status);
      expect(
        await service.estimate(scope, scheduleInput({ maxPages: 100 })),
      ).toMatchObject({ maxPagesPerRun: 50, blockedReasons: ["page_limit"] });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );
  it("confirmed paid projection enables within its ceiling and downgrade is visible on get", async () => {
    runtime.hosted = true;
    await storedBilling(true, "active");
    const input = scheduleInput({ maxPages: 100 });
    const review = await service.estimate(scope, input);
    expect(review).toMatchObject({
      maxPagesPerRun: 100,
      pageLimitPerRun: 10000,
      blockedReasons: [],
    });
    await service.save(scope, {
      ...input,
      expectedVersion: 0,
      estimateFingerprint: review.estimateFingerprint,
    });
    expect(
      (
        await service.save(scope, {
          ...input,
          state: "enabled",
          expectedVersion: 1,
          estimateFingerprint: review.estimateFingerprint,
        })
      ).schedule?.state,
    ).toBe("enabled");
    await testDb.executeMultiple(
      "update billing_customer_status set is_paying=false, paid_plan_status='expired'",
    );
    const changed = await service.get(scope, { projectId: "project" });
    expect(changed).toMatchObject({
      pageLimitPerRun: 50,
      schedule: {
        state: "blocked",
        blockedReasons: ["page_limit"],
        settings: { maxPages: 100 },
      },
    });
    const downgraded = await service.estimate(scope, input);
    expect(downgraded.estimateFingerprint).not.toBe(review.estimateFingerprint);
    await expect(
      service.save(scope, {
        ...input,
        state: "enabled",
        expectedVersion: 2,
        estimateFingerprint: review.estimateFingerprint,
      }),
    ).rejects.toThrow("page_limit");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("self-hosted review uses the existing self-hosted ceiling with no billing row", async () => {
    const input = scheduleInput({ maxPages: 100 });
    expect(await service.estimate(scope, input)).toMatchObject({
      maxPagesPerRun: 100,
      pageLimitPerRun: 10000,
      blockedReasons: [],
    });
    expect(await service.get(scope, { projectId: "project" })).toMatchObject({
      pageLimitPerRun: 10000,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
