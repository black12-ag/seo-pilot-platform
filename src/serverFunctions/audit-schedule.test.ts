import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { z } from "zod";

// Only TanStack's request plumbing is replaced; the service, permissions and SQL are real.
const { testDb, request } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../server/features/site-authority/siteAuthorityTestDb");
  return {
    testDb: await createSiteAuthorityTestDb(),
    request: {
      context: {
        userId: "user",
        organizationId: "organization",
        role: "owner",
        projectId: "10000000-0000-4000-8000-000000000001",
      },
    },
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/serverFunctions/middleware", () => ({ requireProjectContext: [] }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      validator: (schema: z.ZodType) => ({
        handler:
          (
            handler: (input: {
              data: unknown;
              context: typeof request.context;
            }) => unknown,
          ) =>
          async ({ data }: { data: unknown }) =>
            handler({ data: schema.parse(data), context: request.context }),
      }),
    }),
  }),
}));
import {
  getAuditSchedule,
  estimateAuditSchedule,
  saveAuditSchedule,
  listAuditAttempts,
} from "./audit-schedule";
import type { AuditScheduleEstimateInput } from "@/types/schemas/audit-schedule";
const projectId = "project";
const foreignId = "foreign-project";
const input: AuditScheduleEstimateInput = {
  projectId,
  state: "paused",
  startUrl: "https://example.com/",
  cadence: "daily",
  timeZone: "Africa/Addis_Ababa",
  hour: 8,
  minute: 0,
  maxPages: 10,
  maxPagesPerUtcDay: 20,
  maxRunsPerUtcDay: 2,
  maxCostMicrosPerRun: 0,
  maxCostMicrosPerUtcDay: 0,
  renderJavaScript: false,
  lighthouseStrategy: "none",
};
const policy = {
  version: 1,
  maxRunsPerUtcDay: 3,
  maxPagesPerUtcDay: 100,
  maxCostMicrosPerUtcDay: 0,
  maxConcurrentRuns: 1,
  providers: {},
};
beforeEach(async () => {
  await testDb.seedProject();
  request.context.userId = "user";
  request.context.projectId = projectId;
  vi.stubEnv("AUTH_MODE", "password");
  vi.stubEnv("AUDIT_RECURRING_POLICY", JSON.stringify(policy));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request");
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(testDb.close);

async function savePaused() {
  const review = await estimateAuditSchedule({ data: input });
  return saveAuditSchedule({
    data: {
      ...input,
      expectedVersion: 0,
      estimateFingerprint: review.estimateFingerprint,
    },
  });
}

describe(`audit schedule server functions (${testDb.provider})`, () => {
  it("starts off, saves paused and enables only a reviewed next slot without starting an audit", async () => {
    expect(await getAuditSchedule({ data: { projectId } })).toMatchObject({
      schedule: null,
      canManage: true,
    });
    const saved = await savePaused();
    expect(saved.schedule).toMatchObject({
      state: "paused",
      version: 1,
      nextDueAtMs: null,
    });
    const enabled = { ...input, state: "enabled" as const };
    const review = await estimateAuditSchedule({ data: enabled });
    expect(review.nextOccurrences).toHaveLength(3);
    const result = await saveAuditSchedule({
      data: {
        ...enabled,
        expectedVersion: 1,
        estimateFingerprint: review.estimateFingerprint,
      },
    });
    expect(result.schedule).toMatchObject({ state: "enabled", version: 2 });
    expect(result.schedule?.nextDueAtMs).toBeGreaterThan(Date.now());
    expect(await listAuditAttempts({ data: { projectId } })).toEqual({
      attempts: [],
      nextCursor: null,
    });
    expect(await testDb.execute("SELECT * FROM audits")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires fresh owner permission even when middleware cached owner", async () => {
    await savePaused();
    await testDb.execute("UPDATE member SET role='member'");
    expect(await getAuditSchedule({ data: { projectId } })).toMatchObject({
      canManage: false,
    });
    await expect(savePaused()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await testDb.execute("DELETE FROM member");
    await expect(
      getAuditSchedule({ data: { projectId } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects foreign middleware scope and forged identity at the public entry", async () => {
    await expect(
      getAuditSchedule({ data: { projectId: foreignId } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    request.context.projectId = foreignId;
    await expect(
      getAuditSchedule({ data: { projectId: foreignId } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const forged = {
      ...input,
      organizationId: "foreign",
      userId: "user",
      role: "owner",
    };
    await expect(estimateAuditSchedule({ data: forged })).rejects.toThrow();
    expect(await testDb.execute("SELECT * FROM audit_schedules")).toHaveLength(
      0,
    );
  });
  it("rejects stale concurrent saves and rolls back a failed transaction", async () => {
    const review = await estimateAuditSchedule({ data: input });
    const data = {
      ...input,
      expectedVersion: 0,
      estimateFingerprint: review.estimateFingerprint,
    };
    testDb.failNextBatchAt(1);
    await expect(saveAuditSchedule({ data })).rejects.toThrow();
    expect(await testDb.execute("SELECT * FROM audit_schedules")).toHaveLength(
      0,
    );
    const results = await Promise.allSettled([
      saveAuditSchedule({ data }),
      saveAuditSchedule({ data }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
  it("keeps unsupported paid options visible in the estimate and refuses saving them", async () => {
    const paid = { ...input, renderJavaScript: true };
    const review = await estimateAuditSchedule({ data: paid });
    expect(review.blockedReasons).toContain("paid_recurrence_unavailable");
    await expect(
      saveAuditSchedule({
        data: {
          ...paid,
          expectedVersion: 0,
          estimateFingerprint: review.estimateFingerprint,
        },
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
