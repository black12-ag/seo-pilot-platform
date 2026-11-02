import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const { testDb } = await vi.hoisted(async () => {
  const { createAuditScheduleTestDb } = await import("./auditScheduleTestDb");
  return { testDb: await createAuditScheduleTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider, AUTH_MODE: "cloudflare_access" },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
import {
  AuditScheduleRepository as schedules,
  scheduleSettings,
} from "./AuditScheduleRepository";
import { AuditEvidenceRepository as evidence } from "./AuditEvidenceRepository";
import { testEvidenceManifest } from "./auditScheduleTestDb";
import { AuditBudgetRepository as budget } from "./AuditBudgetRepository";
import { ProjectRepository } from "../../projects/repositories/ProjectRepository";
import { WorkspaceMergeService } from "@/server/auth/workspace-merge";
import { now, policy, scope, testAttempt } from "./auditScheduleTestDb";
beforeEach(testDb.seedProject);
afterAll(testDb.close);
async function running() {
  const attempt = await testAttempt(schedules);
  await budget.reserve(attempt.id, attempt.leaseToken, policy, now);
  await testDb.executeMultiple(
    `insert into audits(id,project_id,started_by_user_id,start_url,workflow_instance_id) values('${attempt.id}','project','user','https://example.com','${attempt.id}')`,
  );
  await schedules.attachAudit(attempt.id, attempt.leaseToken, now);
  await schedules.markRunning(attempt.id, attempt.leaseToken, now);
  return attempt;
}
describe(`schedule lifecycle (${testDb.provider})`, () => {
  it("domain away-and-back never revives old execution authority", async () => {
    const attempt = await running();
    await ProjectRepository.updateProject("project", "organization", {
      name: "P",
      domain: "changed.com",
    });
    await ProjectRepository.updateProject("project", "organization", {
      name: "P",
      domain: "example.com",
    });
    expect(await schedules.executionAllowed(attempt.id, now + 1)).toBe(false);
    expect(await schedules.get(scope, "project")).toMatchObject({
      state: "paused",
      nextDueAtMs: null,
    });
  });
  it("archive remains recoverable and restore cannot resurrect launch", async () => {
    const attempt = await running();
    await ProjectRepository.archiveProject("project", "organization");
    expect(await schedules.executionAllowed(attempt.id, now + 1)).toBe(false);
    expect(
      (await schedules.listRecoverable(now + 120_001)).map((row) => row.id),
    ).toContain(attempt.id);
    await ProjectRepository.restoreProject("project", "organization");
    expect(await schedules.executionAllowed(attempt.id, now + 2)).toBe(false);
  });
  it("ordinary pause keeps running frozen work but fences unstarted intent", async () => {
    const attempt = await running();
    const schedule = await schedules.get(scope, "project");
    if (!schedule) throw new Error("No schedule");
    await schedules.save(
      scope,
      {
        ...scheduleSettings(schedule),
        state: "paused",
        expectedVersion: schedule.version,
        estimateFingerprint: schedule.estimateFingerprint,
      },
      {
        fingerprint: schedule.estimateFingerprint,
        policyFingerprint: schedule.policyFingerprint,
        nextDueAtMs: null,
        nowMs: now + 1,
        domain: schedule.domain,
      },
    );
    expect(await schedules.executionAllowed(attempt.id, now + 2)).toBe(true);
    await testDb.executeMultiple("update member set role='admin'");
    expect(await schedules.executionAllowed(attempt.id, now + 3)).toBe(false);
  });
  it("lifecycle invalidation rolls back with the existing project write", async () => {
    const attempt = await running();
    testDb.failNextBatchAt(4);
    await expect(
      ProjectRepository.archiveProject("project", "organization"),
    ).rejects.toThrow();
    expect(await schedules.executionAllowed(attempt.id, now + 1)).toBe(true);
  });
  it("merge preserves settled history, immutable source org and scheduled audit origin", async () => {
    await testDb.executeMultiple(`insert into organization(id,name,slug,created_at) values('delegated-legacy','Legacy','legacy',${testDb.provider === "postgres" ? "now()" : "0"}),('shared-workspace','Shared','shared',${testDb.provider === "postgres" ? "now()" : "0"});
      update projects set organization_id='delegated-legacy' where id='project';
      update member set organization_id='delegated-legacy';
      insert into member(id,organization_id,user_id,role,created_at) values('shared-member','shared-workspace','user','owner',${testDb.provider === "postgres" ? "now()" : "0"});`);
    const attempt = await testAttempt(schedules, "project", {
      ...scope,
      organizationId: "delegated-legacy",
    });
    await budget.reserve(attempt.id, attempt.leaseToken, policy, now);
    await testDb.executeMultiple(
      `insert into audits(id,project_id,started_by_user_id,start_url,workflow_instance_id,is_scheduled) values('${attempt.id}','project','user','https://example.com','${attempt.id}',true)`,
    );
    await schedules.attachAudit(attempt.id, attempt.leaseToken, now);
    await schedules.markRunning(attempt.id, attempt.leaseToken, now);
    const seal = await evidence.beginSeal({
      auditId: attempt.id,
      projectId: "project",
      workflowInstanceId: attempt.id,
      nowMs: now + 1,
    });
    if (!seal) throw new Error("Missing seal");
    await evidence.seal({
      auditId: attempt.id,
      projectId: "project",
      sealToken: seal.token,
      status: "completed",
      manifest: testEvidenceManifest(attempt.id, seal.finalizedAtMs),
    });
    expect(await WorkspaceMergeService.mergeLegacyWorkspaces()).toEqual({
      mergedWorkspaces: 1,
    });
    const moved = await schedules.getAttempt(attempt.id);
    expect(moved).toMatchObject({
      organizationId: "shared-workspace",
      originalOrganizationId: "delegated-legacy",
      reservedDay: "2026-11-02",
      launchState: "completed",
      billingState: "settled",
    });
    expect(
      await schedules.get(
        { ...scope, organizationId: "shared-workspace" },
        "project",
      ),
    ).toMatchObject({ state: "paused", nextDueAtMs: null });
    expect(await schedules.get(scope, "project")).toBeNull();
    expect(
      await evidence.getForProject("project", "shared-workspace", attempt.id),
    ).not.toBeNull();
    expect(
      await evidence.getForProject("project", "delegated-legacy", attempt.id),
    ).toBeNull();
    expect(await testDb.execute("select id from audit_events")).toHaveLength(1);
    expect(await testDb.execute("select is_scheduled from audits")).toEqual([
      expect.objectContaining({
        is_scheduled: testDb.provider === "postgres" ? true : 1,
      }),
    ]);
    expect(
      await testDb.execute(
        "select id from organization where id='delegated-legacy'",
      ),
    ).toHaveLength(0);
  });
  it("renaming or changing market with the same domain preserves execution", async () => {
    const attempt = await running();
    await ProjectRepository.updateProject("project", "organization", {
      name: "Renamed",
      domain: "example.com",
      market: { locationCode: 2840, languageCode: "en" },
    });
    expect(await schedules.executionAllowed(attempt.id, now + 1)).toBe(true);
  });
  it("workspace merge refuses active or unknown work before any transfer", async () => {
    const attempt = await running();
    await testDb.executeMultiple(
      `insert into organization(id,name,slug,created_at) values('delegated-legacy','Legacy','delegated-legacy',${testDb.provider === "postgres" ? "now()" : "0"}); update projects set organization_id='delegated-legacy' where id='project'; update audit_schedule_attempts set organization_id='delegated-legacy' where id='${attempt.id}'`,
    );
    await expect(
      WorkspaceMergeService.mergeLegacyWorkspaces(),
    ).rejects.toThrow();
    expect(
      await testDb.execute(
        "select organization_id from projects where id='project'",
      ),
    ).toEqual([
      expect.objectContaining({ organization_id: "delegated-legacy" }),
    ]);
  });
});
