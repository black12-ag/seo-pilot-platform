import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const { testDb } = await vi.hoisted(async () => {
  const { createAuditScheduleTestDb } = await import("./auditScheduleTestDb");
  return { testDb: await createAuditScheduleTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
import { AuditScheduleRepository as schedules } from "./AuditScheduleRepository";
import { AuditBudgetRepository as budget } from "./AuditBudgetRepository";
import { now, policy, testAttempt } from "./auditScheduleTestDb";
const day = new Date(now).toISOString().slice(0, 10);
beforeEach(testDb.seedProject);
afterAll(testDb.close);
async function secondAttempt() {
  await testDb.executeMultiple(
    "insert into projects(id,organization_id,name,domain) values('second','organization','Second','example.com')",
  );
  return testAttempt(schedules, "second");
}
describe(`atomic recurring admission (${testDb.provider})`, () => {
  it.each(["completed", "failed", "skipped", "cancelled"] as const)(
    "clears an existing retry time when an attempt becomes %s",
    async (state) => {
      const attempt = await testAttempt(schedules);
      expect(
        await budget.reserve(attempt.id, attempt.leaseToken, policy, now),
      ).toBe(true);
      await testDb.executeMultiple(
        `update audit_schedule_attempts set retry_at_ms=${now + 5000} where id='${attempt.id}'`,
      );
      expect((await schedules.getAttempt(attempt.id))?.retryAtMs).toBe(
        now + 5000,
      );
      expect(
        await budget.finish(attempt.id, {
          token: attempt.leaseToken,
          state,
          reason: "test",
          consumedPages: 4,
          nowMs: now + 1,
        }),
      ).toBe(true);
      expect(await schedules.getAttempt(attempt.id)).toMatchObject({
        launchState: state,
        retryAtMs: null,
        billingState: "settled",
      });
      expect(await budget.getUsage("organization", day)).toMatchObject({
        reservedRuns: 0,
        reservedPages: 0,
        consumedRuns: 1,
        consumedPages: 4,
      });
    },
  );
  it("reserves once across duplicate requests and rejects stale lease receipts", async () => {
    const attempt = await testAttempt(schedules);
    const result = await Promise.all([
      budget.reserve(attempt.id, attempt.leaseToken, policy, now),
      budget.reserve(attempt.id, attempt.leaseToken, policy, now),
    ]);
    expect(result.some(Boolean)).toBe(true);
    expect(await budget.getUsage("organization", day)).toMatchObject({
      reservedRuns: 1,
      reservedPages: 10,
      consumedRuns: 0,
    });
    expect(await budget.reserve(attempt.id, "stale", policy, now)).toBe(false);
  });
  it("enforces a shared org day cap under concurrent project admission", async () => {
    const a = await testAttempt(schedules);
    const b = await secondAttempt();
    // Each schedule can lower the same org cap, never obtain an independent allowance.
    await testDb.executeMultiple(
      `update audit_schedule_daily_usage set reserved_runs=0`,
    );
    await testDb.executeMultiple(
      `insert into audit_schedule_daily_usage(organization_id,utc_day,consumed_runs) values('organization','${day}',1)`,
    );
    const result = await Promise.all([
      budget.reserve(a.id, a.leaseToken, policy, now),
      budget.reserve(b.id, b.leaseToken, policy, now),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(await budget.getUsage("organization", day)).toMatchObject({
      reservedRuns: 1,
      consumedRuns: 1,
    });
  });
  it("a fault after reservation marker rolls back marker and daily counts", async () => {
    const attempt = await testAttempt(schedules);
    testDb.failNextBatchAt(5);
    await expect(
      budget.reserve(attempt.id, attempt.leaseToken, policy, now),
    ).rejects.toThrow();
    expect((await schedules.getAttempt(attempt.id))?.reservedDay).toBeNull();
    expect(await budget.getUsage("organization", day)).toBeNull();
  });
  it("terminal accounting and event are atomic and replay does not refund twice", async () => {
    const attempt = await testAttempt(schedules);
    await budget.reserve(attempt.id, attempt.leaseToken, policy, now);
    const finish = {
      token: attempt.leaseToken,
      state: "failed",
      reason: "interrupted",
      consumedPages: 4,
      nowMs: now + 1,
    } as const;
    testDb.failNextBatchAt(3);
    await expect(budget.finish(attempt.id, finish)).rejects.toThrow();
    expect(await budget.getUsage("organization", day)).toMatchObject({
      reservedRuns: 1,
      consumedPages: 0,
    });
    expect(await budget.finish(attempt.id, finish)).toBe(true);
    expect(await budget.finish(attempt.id, finish)).toBe(false);
    expect(await budget.getUsage("organization", day)).toMatchObject({
      reservedRuns: 0,
      reservedPages: 0,
      consumedRuns: 1,
      consumedPages: 4,
    });
    expect(await testDb.execute("select id from audit_events")).toHaveLength(1);
  });
  it("cross-day concurrency counts prior-day unsettled work", async () => {
    const first = await testAttempt(schedules);
    const second = await secondAttempt();
    await budget.reserve(first.id, first.leaseToken, policy, now);
    await budget.reserve(second.id, second.leaseToken, policy, now);
    await testDb.executeMultiple(
      `insert into projects(id,organization_id,name,domain) values('third','organization','Third','example.com')`,
    );
    const third = await testAttempt(schedules, "third");
    const tomorrow = now + 86_400_000;
    await testDb.executeMultiple(
      `update audit_schedule_attempts set expires_at_ms=${tomorrow + 86_400_000} where id='${third.id}'`,
    );
    const lease = await schedules.claimAttempt(third.id, tomorrow);
    if (!lease?.leaseToken) throw new Error("Lease missing");
    expect(
      await budget.reserve(third.id, lease.leaseToken, policy, tomorrow),
    ).toBe(false);
    expect(
      await budget.getUsage(
        "organization",
        new Date(tomorrow).toISOString().slice(0, 10),
      ),
    ).toMatchObject({ reservedRuns: 0 });
  });
  it("reserve-vs-finish cannot settle a newer reservation from a stale snapshot", async () => {
    const attempt = await testAttempt(schedules);
    testDb.beforeNextBatch(async () => {
      expect(
        await budget.reserve(attempt.id, attempt.leaseToken, policy, now),
      ).toBe(true);
    });
    expect(
      await budget.finish(attempt.id, {
        token: attempt.leaseToken,
        state: "cancelled",
        reason: "cancelled",
        consumedPages: 0,
        nowMs: now + 1,
      }),
    ).toBe(false);
    expect((await schedules.getAttempt(attempt.id))?.billingState).toBe(
      "reserved",
    );
    expect(await budget.getUsage("organization", day)).toMatchObject({
      reservedRuns: 1,
      reservedPages: 10,
    });
  });
  it("changed policy or paid request cannot reserve plain budget", async () => {
    const attempt = await testAttempt(schedules);
    expect(
      await budget.reserve(
        attempt.id,
        attempt.leaseToken,
        { ...policy, maxConcurrentRuns: 10 },
        now,
      ),
    ).toBe(false);
    await testDb.executeMultiple(
      `update audit_schedule_attempts set request_json=replace(request_json,'"renderJavaScript":false','"renderJavaScript":true') where id='${attempt.id}'`,
    );
    expect(
      await budget.reserve(attempt.id, attempt.leaseToken, policy, now),
    ).toBe(false);
  });
});
