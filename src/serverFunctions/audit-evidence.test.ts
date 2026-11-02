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
  getAuditEvidence,
  compareAuditEvidence,
  exportAuditEvidence,
} from "./audit-evidence";
const projectId = "project";
beforeEach(async () => {
  await testDb.seedProject();
  request.context.userId = "user";
  request.context.projectId = projectId;
  vi.stubEnv("AUTH_MODE", "password");
  await testDb.executeMultiple(`INSERT INTO audits(id,project_id,started_by_user_id,start_url,status) VALUES
    ('legacy','project','user','https://example.com/','completed'),
    ('other','foreign-project','user','https://other.com/','completed');
    INSERT INTO audit_pages(id,audit_id,url,title,status_code) VALUES ('page','legacy','https://example.com/','Actual stored page',200);`);
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
describe(`audit evidence server functions (${testDb.provider})`, () => {
  it("preserves unknown legacy coverage and exports actual scoped rows", async () => {
    const data = { projectId, auditId: "legacy" };
    expect(await getAuditEvidence({ data })).toMatchObject({
      state: "legacy_unknown",
      manifest: null,
    });
    const exported = await exportAuditEvidence({ data });
    expect(JSON.parse(exported.content)).toMatchObject({
      state: "legacy_unknown",
      manifest: null,
      pages: [{ id: "page", title: "Actual stored page" }],
      issues: [],
      lighthouse: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects cross-project evidence even within an authorized project context", async () => {
    await expect(
      getAuditEvidence({ data: { projectId, auditId: "other" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      compareAuditEvidence({
        data: { projectId, auditId: "legacy", baselineAuditId: "other" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      exportAuditEvidence({
        data: { projectId: "foreign-project", auditId: "other" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("supports member reads but rechecks removed membership before export", async () => {
    await testDb.execute("UPDATE member SET role='member'");
    expect(
      await getAuditEvidence({ data: { projectId, auditId: "legacy" } }),
    ).toMatchObject({ state: "legacy_unknown" });
    await testDb.execute("DELETE FROM member");
    await expect(
      exportAuditEvidence({ data: { projectId, auditId: "legacy" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("does not turn unavailable evidence into zero improvement", async () => {
    expect(
      await compareAuditEvidence({
        data: { projectId, auditId: "legacy", baselineAuditId: "legacy" },
      }),
    ).toMatchObject({ comparable: false, reason: "evidence_unavailable" });
    const forged = { projectId, auditId: "legacy", organizationId: "foreign" };
    await expect(exportAuditEvidence({ data: forged })).rejects.toThrow();
  });
});
