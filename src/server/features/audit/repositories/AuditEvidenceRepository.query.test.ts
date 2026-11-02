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
import {
  AuditEvidenceRepository as evidence,
  markResultDeletedWrites,
} from "./AuditEvidenceRepository";
import { now, policy, testAttempt } from "./auditScheduleTestDb";
import { testEvidenceManifest as manifest } from "./auditScheduleTestDb";
beforeEach(testDb.seedProject);
afterAll(testDb.close);
async function running() {
  const attempt = await testAttempt(schedules);
  await budget.reserve(attempt.id, attempt.leaseToken, policy, now);
  await testDb.executeMultiple(
    `insert into audits(id,project_id,started_by_user_id,start_url,workflow_instance_id) values('${attempt.id}','project','user','https://example.com','${attempt.id}')`,
  );
  expect(await schedules.attachAudit(attempt.id, attempt.leaseToken, now)).toBe(
    true,
  );
  expect(await schedules.markRunning(attempt.id, attempt.leaseToken, now)).toBe(
    true,
  );
  return attempt;
}

describe(`immutable evidence SQL (${testDb.provider})`, () => {
  it("beginSeal recovers the same token/time and fences execution before snapshot", async () => {
    const attempt = await running();
    expect(await schedules.executionAllowed(attempt.id, now)).toBe(true);
    const input = {
      auditId: attempt.id,
      projectId: "project",
      workflowInstanceId: attempt.id,
      nowMs: now + 10,
    };
    const seal = await evidence.beginSeal(input);
    expect(seal?.finalizedAtMs).toBe(now + 10);
    expect(await evidence.beginSeal({ ...input, nowMs: now + 20 })).toEqual(
      seal,
    );
    expect(await schedules.executionAllowed(attempt.id, now + 20)).toBe(false);
    expect(
      await evidence.beginSeal({ ...input, projectId: "foreign-project" }),
    ).toBeNull();
  });
  it("seal settles counts, terminal audit/attempt and one event atomically", async () => {
    const attempt = await running();
    const seal = await evidence.beginSeal({
      auditId: attempt.id,
      projectId: "project",
      workflowInstanceId: attempt.id,
      nowMs: now + 10,
    });
    if (!seal) throw new Error("No seal");
    const input = {
      auditId: attempt.id,
      projectId: "project",
      sealToken: seal.token,
      manifest: manifest(attempt.id, seal.finalizedAtMs),
      status: "completed",
    } as const;
    testDb.failNextBatchAt(5);
    await expect(evidence.seal(input)).rejects.toThrow();
    expect(
      await evidence.getForProject("project", "organization", attempt.id),
    ).toBeNull();
    expect((await schedules.getAttempt(attempt.id))?.launchState).toBe(
      "running",
    );
    expect(await evidence.seal(input)).toBe(true);
    expect(await evidence.seal(input)).toBe(true);
    await testDb.executeMultiple(
      "update projects set archived_at='2026-11-02' where id='project'",
    );
    expect(
      await evidence.getForWorkflow(attempt.id, "project", attempt.id),
    ).not.toBeNull();
    expect(
      await evidence.getForWorkflow(attempt.id, "project", "foreign-workflow"),
    ).toBeNull();
    expect(
      await evidence.getForProject("project", "foreign", attempt.id),
    ).toBeNull();
    expect(await budget.getUsage("organization", "2026-11-02")).toMatchObject({
      reservedPages: 0,
      consumedPages: 2,
      reservedRuns: 0,
      consumedRuns: 1,
    });
    expect((await schedules.getAttempt(attempt.id))?.coverageState).toBe(
      "partial",
    );
    expect(await testDb.execute("select id from audit_events")).toHaveLength(1);
    expect(
      await evidence.seal({
        ...input,
        manifest: {
          ...input.manifest,
          artifact: { ...input.manifest.artifact, sha256: "d".repeat(64) },
        },
      }),
    ).toBe(false);
    expect(await evidence.seal({ ...input, status: "failed" })).toBe(false);
  });
  it("failed evidence consumes the reserved upper bound for possibly unpersisted fetches", async () => {
    const attempt = await running();
    const seal = await evidence.beginSeal({
      auditId: attempt.id,
      projectId: "project",
      workflowInstanceId: attempt.id,
      nowMs: now + 10,
    });
    if (!seal) throw new Error("Missing seal");
    await evidence.seal({
      auditId: attempt.id,
      projectId: "project",
      sealToken: seal.token,
      status: "failed",
      manifest: {
        ...manifest(attempt.id, seal.finalizedAtMs),
        terminalStatus: "failed",
      },
    });
    expect(await budget.getUsage("organization", "2026-11-02")).toMatchObject({
      consumedPages: 10,
      reservedPages: 0,
    });
    const events = await testDb.execute(
      "select summary_json from audit_events",
    );
    expect(JSON.parse(String(events[0].summary_json))).toMatchObject({
      consumedPages: 10,
      observedPagesLowerBound: 2,
      pageUsageKnown: false,
      accountingMode: "reserved_upper_bound",
    });
  });
  it("seal rolls back if a newer reservation defeats its terminal snapshot", async () => {
    const attempt = await testAttempt(schedules);
    await testDb.executeMultiple(
      `insert into audits(id,project_id,started_by_user_id,start_url,workflow_instance_id) values('${attempt.id}','project','user','https://example.com','${attempt.id}')`,
    );
    const seal = await evidence.beginSeal({
      auditId: attempt.id,
      projectId: "project",
      workflowInstanceId: attempt.id,
      nowMs: now + 10,
    });
    if (!seal) throw new Error("Missing seal");
    testDb.beforeNextBatch(async () => {
      expect(
        await budget.reserve(attempt.id, attempt.leaseToken, policy, now),
      ).toBe(true);
    });
    await expect(
      evidence.seal({
        auditId: attempt.id,
        projectId: "project",
        sealToken: seal.token,
        status: "failed",
        manifest: {
          ...manifest(attempt.id, seal.finalizedAtMs),
          terminalStatus: "failed",
        },
      }),
    ).rejects.toThrow();
    expect(
      await evidence.getForProject("project", "organization", attempt.id),
    ).toBeNull();
    expect((await schedules.getAttempt(attempt.id))?.billingState).toBe(
      "reserved",
    );
    expect(await testDb.execute("select status from audits")).toEqual([
      expect.objectContaining({ status: "running" }),
    ]);
  });
  it("pre-attach deletion has an explicit tombstone", async () => {
    const attempt = await testAttempt(schedules);
    await testDb.executeMultiple(
      `insert into audits(id,project_id,started_by_user_id,start_url,workflow_instance_id) values('${attempt.id}','project','user','https://example.com','${attempt.id}')`,
    );
    await testDb.runBatch((tx) =>
      markResultDeletedWrites(tx, attempt.id, "project"),
    );
    await testDb.executeMultiple(`delete from audits where id='${attempt.id}'`);
    expect(
      await evidence.getDeletedAttempt("project", "organization", attempt.id),
    ).toMatchObject({ resultDeleted: true, startedAtMs: null });
    expect(await schedules.executionAllowed(attempt.id, now)).toBe(false);
  });
  it("evidence cannot be cross-linked to another project audit", async () => {
    await testDb.executeMultiple(
      "insert into audits(id,project_id,started_by_user_id,start_url) values('foreign-audit','foreign-project','user','https://other.com')",
    );
    await expect(
      testDb.executeMultiple(
        `insert into audit_run_evidence(audit_id,project_id,manifest_json,artifact_key,artifact_sha256,coverage_state,finalized_at_ms,seal_token) values('foreign-audit','project','{}','key','${"a".repeat(64)}','unassessed',${now},'token')`,
      ),
    ).rejects.toThrow();
  });
  it("deleting a finished result retains the slot tombstone and settled usage", async () => {
    const attempt = await running();
    await budget.finish(attempt.id, {
      token: attempt.leaseToken,
      state: "failed",
      reason: "stopped",
      consumedPages: 2,
      nowMs: now + 1,
    });
    await testDb.runBatch((tx) =>
      markResultDeletedWrites(tx, attempt.id, "project"),
    );
    await testDb.executeMultiple(`delete from audits where id='${attempt.id}'`);
    expect(
      await evidence.getDeletedAttempt("project", "organization", attempt.id),
    ).not.toBeNull();
    expect((await schedules.getAttempt(attempt.id))?.auditId).toBeNull();
    expect(await budget.getUsage("organization", "2026-11-02")).toMatchObject({
      consumedPages: 10,
    });
  });
});
