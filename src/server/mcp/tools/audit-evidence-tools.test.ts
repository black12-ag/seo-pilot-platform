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
  getAuditEvidenceTool,
  compareAuditEvidenceTool,
  exportAuditEvidenceTool,
} from "./audit-evidence-tools";
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

beforeEach(async () => {
  await testDb.executeMultiple(`INSERT INTO audits(id,project_id,started_by_user_id,start_url,status) VALUES ('audit','project','user','https://example.com/','completed'),('foreign-audit','foreign-project','user','https://other.com/','completed');
  INSERT INTO audit_pages(id,audit_id,url,title) VALUES ('page','audit','https://example.com/','Stored observation');`);
});
describe(`audit evidence MCP (${testDb.provider})`, () => {
  it("returns unknown legacy evidence and the actual rows on export", async () => {
    const input = { projectId, auditId: "audit" };
    const result = await getAuditEvidenceTool.handler(input, context);
    expect(
      getAuditEvidenceTool.config.outputSchema.parse(result.structuredContent),
    ).toMatchObject({ state: "legacy_unknown", manifest: null });
    const exported = exportAuditEvidenceTool.config.outputSchema.parse(
      (await exportAuditEvidenceTool.handler(input, context)).structuredContent,
    );
    expect(JSON.parse(exported.content)).toMatchObject({
      pages: [{ id: "page", title: "Stored observation" }],
      manifest: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not expose foreign IDs through read, compare or export", async () => {
    await expect(
      getAuditEvidenceTool.handler(
        { projectId, auditId: "foreign-audit" },
        context,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      compareAuditEvidenceTool.handler(
        { projectId, auditId: "audit", baselineAuditId: "foreign-audit" },
        context,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      exportAuditEvidenceTool.handler(
        { projectId: "foreign-project", auditId: "foreign-audit" },
        context,
      ),
    ).rejects.toThrow();
  });
  it("refuses fabricated comparison certainty and removed-member exports", async () => {
    const compared = await compareAuditEvidenceTool.handler(
      { projectId, auditId: "audit", baselineAuditId: "audit" },
      context,
    );
    expect(
      compareAuditEvidenceTool.config.outputSchema.parse(
        compared.structuredContent,
      ),
    ).toMatchObject({ comparable: false, reason: "evidence_unavailable" });
    await testDb.execute("DELETE FROM member");
    await expect(
      exportAuditEvidenceTool.handler({ projectId, auditId: "audit" }, context),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
