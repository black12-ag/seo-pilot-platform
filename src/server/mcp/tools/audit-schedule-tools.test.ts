import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Real schema/migrations and atomic batches precede static entry-point imports.
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../../features/site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
  DurableObject: class {
    kind = "mock";
  },
  waitUntil: (promise: Promise<unknown>) => {
    void promise.catch(() => {});
  },
}));
vi.mock("@/db", () => ({
  db: testDb.db,
  withPgClient: (run: () => unknown) => run(),
}));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
import {
  getAuditScheduleTool,
  estimateAuditScheduleTool,
  saveAuditScheduleTool,
  listAuditAttemptsTool,
} from "./audit-schedule-tools";
import { buildSamMcpTools } from "@/server/features/sam/samChatTools";
import type { AuditScheduleEstimateInput } from "@/types/schemas/audit-schedule";
import { makeToolContext } from "./tool-test-support";
const projectId = "project";
const context = makeToolContext({
  userId: "user",
  organizationId: "organization",
  role: "owner",
  clientId: "api_key",
});
beforeEach(async () => {
  await testDb.seedProject();
  vi.stubEnv("AUTH_MODE", "password");
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

const input: AuditScheduleEstimateInput = {
  projectId,
  state: "paused",
  startUrl: "https://example.com/",
  cadence: "daily",
  timeZone: "UTC",
  hour: 8,
  minute: 0,
  maxPages: 10,
  maxPagesPerUtcDay: 10,
  maxRunsPerUtcDay: 1,
  maxCostMicrosPerRun: 0,
  maxCostMicrosPerUtcDay: 0,
  renderJavaScript: false,
  lighthouseStrategy: "none",
};

describe(`audit schedule MCP and SAM (${testDb.provider})`, () => {
  it("exposes a paused-default workflow and visible policy blockers through shared service tools", async () => {
    expect(
      (await getAuditScheduleTool.handler({ projectId }, context))
        .structuredContent,
    ).toMatchObject({ schedule: null, canManage: true });
    const estimated = await estimateAuditScheduleTool.handler(input, context);
    const estimate = estimateAuditScheduleTool.config.outputSchema.parse(
      estimated.structuredContent,
    );
    expect(estimate.blockedReasons).toContain(
      "recurring_policy_not_configured",
    );
    const saved = await saveAuditScheduleTool.handler(
      {
        ...input,
        expectedVersion: 0,
        estimateFingerprint: estimate.estimateFingerprint,
      },
      context,
    );
    expect(saved.structuredContent).toMatchObject({
      schedule: { state: "paused", version: 1 },
    });
    expect(
      (await listAuditAttemptsTool.handler({ projectId, limit: 25 }, context))
        .structuredContent,
    ).toMatchObject({ attempts: [], nextCursor: null });
    expect(await testDb.execute("SELECT * FROM audits")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      getAuditScheduleTool.config.outputSchema.safeParse({
        ...saved.structuredContent,
        futureField: true,
      }).success,
    ).toBe(true);
  });
  it("rejects a foreign project and current owner demotion through the real MCP authorization", async () => {
    await expect(
      getAuditScheduleTool.handler({ projectId: "foreign-project" }, context),
    ).rejects.toThrow();
    const estimate = estimateAuditScheduleTool.config.outputSchema.parse(
      (await estimateAuditScheduleTool.handler(input, context))
        .structuredContent,
    );
    await testDb.execute("UPDATE member SET role='member'");
    await expect(
      saveAuditScheduleTool.handler(
        {
          ...input,
          expectedVersion: 0,
          estimateFingerprint: estimate.estimateFingerprint,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("binds SAM to the session project and keeps strict union validation", async () => {
    const tools = buildSamMcpTools(context.auth, {
      id: projectId,
      domain: null,
    });
    const output: unknown = await tools.get_audit_schedule.execute?.(
      { projectId: "foreign-project" },
      { toolCallId: "read", messages: [] },
    );
    expect(output).toMatchObject({ data: { schedule: null, canManage: true } });
    const { projectId: _projectId, ...draft } = input;
    const review: unknown = await tools.estimate_audit_schedule.execute?.(
      { ...draft, role: "owner" },
      { toolCallId: "estimate", messages: [] },
    );
    expect(review).toHaveProperty("error");
    expect(await testDb.execute("SELECT * FROM audit_schedules")).toHaveLength(
      0,
    );
  });
  it("does not accept transport-injected identity or paid downgrade", async () => {
    const invalid = { ...input, organizationId: "foreign" };
    await expect(
      estimateAuditScheduleTool.handler(invalid, context),
    ).rejects.toThrow();
    const result = await estimateAuditScheduleTool.handler(
      { ...input, lighthouseStrategy: "auto" },
      context,
    );
    const review = estimateAuditScheduleTool.config.outputSchema.parse(
      result.structuredContent,
    );
    expect(review.paidRecurrenceAvailable).toBe(false);
    expect(review.blockedReasons).toContain("paid_recurrence_unavailable");
  });
});
