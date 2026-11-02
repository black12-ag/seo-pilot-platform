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
import { AuditScheduleRepository as repository } from "./AuditScheduleRepository";
import {
  now,
  scope,
  scheduleInput,
  testSchedule,
  testAttempt,
} from "./auditScheduleTestDb";
const slot = {
  dueAtMs: now,
  nextDueAtMs: now + 86_400_000,
  firstMissedAtMs: now,
  lastMissedAtMs: now,
  missedCount: 1,
};
beforeEach(testDb.seedProject);
afterAll(testDb.close);
describe(`schedule SQL (${testDb.provider})`, () => {
  it("CAS returns an actual mutation receipt and foreign rows remain inaccessible", async () => {
    const schedule = await testSchedule(repository);
    const edit = {
      ...scheduleInput(),
      expectedVersion: schedule.version,
      estimateFingerprint: "a".repeat(64),
    };
    const approved = {
      fingerprint: "a".repeat(64),
      policyFingerprint: schedule.policyFingerprint,
      nextDueAtMs: null,
      nowMs: now,
      domain: "example.com",
    };
    const results = await Promise.all([
      repository.save(scope, edit, approved),
      repository.save(scope, edit, approved),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await repository.get({ ...scope, organizationId: "foreign" }, "project"),
    ).toBeNull();
    expect(
      await repository.save(
        scope,
        { ...edit, projectId: "foreign-project", expectedVersion: 0 },
        approved,
      ),
    ).toBeNull();
  });
  it("duplicate due ticks have one stable attempt and one next-due advance", async () => {
    const schedule = await testSchedule(repository);
    const rows = await Promise.all([
      repository.admitSlot(schedule, slot, now),
      repository.admitSlot(schedule, slot, now),
    ]);
    expect(rows[0]?.id).toBe(rows[1]?.id);
    expect(
      await testDb.execute("select id from audit_schedule_attempts"),
    ).toHaveLength(1);
    expect((await repository.get(scope, "project"))?.nextDueAtMs).toBe(
      slot.nextDueAtMs,
    );
  });
  it("fault between insert and advance rolls back both; retry claims original slot", async () => {
    const schedule = await testSchedule(repository);
    testDb.failNextBatchAt(4);
    await expect(repository.admitSlot(schedule, slot, now)).rejects.toThrow();
    expect(
      await testDb.execute("select id from audit_schedule_attempts"),
    ).toHaveLength(0);
    expect((await repository.get(scope, "project"))?.nextDueAtMs).toBe(now);
    expect(await repository.admitSlot(schedule, slot, now)).not.toBeNull();
  });
  it("role loss after service read cannot admit a slot", async () => {
    const schedule = await testSchedule(repository);
    testDb.beforeNextBatch(() =>
      testDb.executeMultiple("update member set role='admin'"),
    );
    expect(await repository.admitSlot(schedule, slot, now)).toBeNull();
    expect((await repository.get(scope, "project"))?.nextDueAtMs).toBe(now);
  });
  it("membership loss inside the batch rolls back partial admission", async () => {
    const schedule = await testSchedule(repository);
    testDb.mutateMembershipInNextBatchAt(4, "admin");
    await expect(repository.admitSlot(schedule, slot, now)).rejects.toThrow();
    expect(
      await testDb.execute("select id from audit_schedule_attempts"),
    ).toHaveLength(0);
    expect((await repository.get(scope, "project"))?.nextDueAtMs).toBe(now);
  });
  it("lease replacement returns a new receipt and fences the delayed owner", async () => {
    const first = await testAttempt(repository);
    expect(await repository.claimAttempt(first.id, now + 1)).toBeNull();
    const next = await repository.claimAttempt(first.id, now + 120_001);
    expect(next?.leaseToken).not.toBe(first.leaseToken);
    expect(
      await repository.revoke(
        first.id,
        "stale_recovery",
        now + 120_002,
        first.leaseToken,
      ),
    ).toBe(false);
    expect(
      await repository.renewLease(first.id, first.leaseToken, now + 120_002),
    ).toBe(false);
    expect(
      await repository.deferAttempt(
        first.id,
        first.leaseToken,
        "stale",
        now + 200_000,
        now + 120_002,
      ),
    ).toBe(false);
  });
  it("enforces one active attempt across schedule revisions", async () => {
    await testAttempt(repository);
    const schedule = await repository.get(scope, "project");
    if (!schedule) throw new Error("Missing fixture");
    await testDb.executeMultiple(
      `update audit_schedules set next_due_at_ms=${now}, version=version+1`,
    );
    const revised = await repository.get(scope, "project");
    if (!revised) throw new Error("Missing fixture");
    expect(await repository.admitSlot(revised, slot, now)).toBeNull();
    expect(
      await testDb.execute("select id from audit_schedule_attempts"),
    ).toHaveLength(1);
  });
  it("blocked sponsor rows and active projects cannot starve a later eligible due slot", async () => {
    for (let index = 0; index < 51; index++) {
      const id = `blocked-${index}`;
      await testDb.executeMultiple(
        `insert into projects(id,organization_id,name,domain) values('${id}','organization','Blocked','example.com')`,
      );
      await testSchedule(repository, id);
    }
    await testDb.executeMultiple(
      "update audit_schedules set sponsor_user_id=null where project_id like 'blocked-%'",
    );
    await testSchedule(repository);
    expect(
      (await repository.listDue(now, 50)).map((row) => row.projectId),
    ).toEqual(["project"]);
  });
  it("deferred recovery rows rotate behind attempts not yet examined", async () => {
    const first = await testAttempt(repository);
    await repository.deferAttempt(
      first.id,
      first.leaseToken,
      "workflow_status_unknown",
      now + 300_000,
      now,
    );
    await testDb.executeMultiple(
      "insert into projects(id,organization_id,name,domain) values('second','organization','Second','example.com')",
    );
    const second = await testAttempt(repository, "second");
    const recoverable = await repository.listRecoverable(now + 300_001, 1);
    expect(recoverable[0].id).toBe(second.id);
  });
  it("foreign-project audit references are rejected by the database", async () => {
    const attempt = await testAttempt(repository);
    await testDb.executeMultiple(
      "insert into audits(id,project_id,started_by_user_id,start_url) values('foreign-audit','foreign-project','user','https://other.com')",
    );
    await expect(
      testDb.executeMultiple(
        `update audit_schedule_attempts set audit_id='foreign-audit' where id='${attempt.id}'`,
      ),
    ).rejects.toThrow();
  });
});
