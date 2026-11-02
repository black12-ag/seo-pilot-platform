import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const { testDb, mockEnv } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../features/site-authority/siteAuthorityTestDb");
  const database = await createSiteAuthorityTestDb();
  return {
    testDb: database,
    mockEnv: {
      DATABASE_PROVIDER: database.provider,
      AUTH_MODE: "cloudflare_access",
    },
  };
});
vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
import { WorkspaceMergeService } from "./workspace-merge";
const rows = testDb.execute;
afterAll(testDb.close);
beforeEach(async () => {
  mockEnv.AUTH_MODE = "cloudflare_access";
  await testDb.executeMultiple('DELETE FROM organization; DELETE FROM "user";');
});

async function seedLegacyWorkspaces() {
  await testDb.executeMultiple(`
    INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES ('u1','User','merge@example.com',${testDb.provider === "postgres" ? "now(),now()" : "0,0"});
    INSERT INTO organization (id, name, slug, created_at) VALUES
      ('shared-workspace', 'Shared workspace', 'shared-workspace',${testDb.provider === "postgres" ? "now()" : "0"}),
      ('delegated-u1', 'ben workspace', 'delegated-ben-1',${testDb.provider === "postgres" ? "now()" : "0"}),
      ('delegated-u2', 'sam workspace', 'delegated-sam-2',${testDb.provider === "postgres" ? "now()" : "0"}),
      ('org_hosted', 'Hosted org', 'hosted',${testDb.provider === "postgres" ? "now()" : "0"});
    INSERT INTO projects (id, organization_id, name, domain, archived_at) VALUES
      ('p-shared', 'shared-workspace', 'Default', NULL, NULL),
      ('p1-default', 'delegated-u1', 'Default', NULL, NULL),
      ('p1-acme', 'delegated-u1', 'Acme', 'acme.com', NULL),
      ('p2-default', 'delegated-u2', 'Default', NULL, NULL),
      ('p-hosted', 'org_hosted', 'Default', NULL, NULL);
    INSERT INTO user_onboarding_answers (user_id, organization_id) VALUES
      ('u1', 'delegated-u1');
    INSERT INTO organization_activation_state
      (organization_id, first_mcp_authorized_at, first_mcp_tool_call_at) VALUES
      ('delegated-u1', '2026-03-01 09:00:00', '2026-03-02 09:00:00'),
      ('delegated-u2', '2026-01-02 09:00:00', NULL);
    INSERT INTO gsc_connections
      (id, project_id, organization_id, site_url, connected_by_user_id) VALUES
      ('gsc1', 'p1-acme', 'delegated-u1', 'sc-domain:acme.com', 'u1');
  `);
}

describe("WorkspaceMergeService", () => {
  it("folds legacy workspaces into the shared workspace and leaves other orgs alone", async () => {
    await seedLegacyWorkspaces();

    await expect(WorkspaceMergeService.countLegacyWorkspaces()).resolves.toBe(
      2,
    );
    await expect(
      WorkspaceMergeService.mergeLegacyWorkspaces(),
    ).resolves.toEqual({ mergedWorkspaces: 2 });

    expect(
      await rows("SELECT id, organization_id, name FROM projects ORDER BY id"),
    ).toEqual([
      expect.objectContaining({
        id: "p-hosted",
        organization_id: "org_hosted",
      }),
      expect.objectContaining({
        id: "p-shared",
        organization_id: "shared-workspace",
        name: "Default",
      }),
      expect.objectContaining({
        id: "p1-acme",
        organization_id: "shared-workspace",
        name: "Acme",
      }),
      expect.objectContaining({
        id: "p1-default",
        organization_id: "shared-workspace",
        name: "Default (ben)",
      }),
      expect.objectContaining({
        id: "p2-default",
        organization_id: "shared-workspace",
        name: "Default (sam)",
      }),
    ]);

    expect(
      await rows(
        "SELECT project_id, context_version FROM content_project_state ORDER BY project_id",
      ),
    ).toEqual([
      expect.objectContaining({ project_id: "p1-acme", context_version: 1 }),
      expect.objectContaining({ project_id: "p1-default", context_version: 1 }),
      expect.objectContaining({ project_id: "p2-default", context_version: 1 }),
    ]);

    // Legacy orgs are gone; their activation rows cascaded away after the
    // earliest milestones were folded into the shared row.
    expect(await rows("SELECT id FROM organization ORDER BY id")).toEqual([
      expect.objectContaining({ id: "org_hosted" }),
      expect.objectContaining({ id: "shared-workspace" }),
    ]);
    expect(await rows("SELECT * FROM organization_activation_state")).toEqual([
      expect.objectContaining({
        organization_id: "shared-workspace",
        first_mcp_authorized_at: "2026-01-02 09:00:00",
        first_mcp_tool_call_at: "2026-03-02 09:00:00",
      }),
    ]);
    expect(await rows("SELECT organization_id FROM gsc_connections")).toEqual([
      expect.objectContaining({ organization_id: "shared-workspace" }),
    ]);
    expect(
      await rows("SELECT organization_id FROM user_onboarding_answers"),
    ).toEqual([
      expect.objectContaining({ organization_id: "shared-workspace" }),
    ]);
  });

  it("refuses to run outside cloudflare_access mode", async () => {
    await seedLegacyWorkspaces();
    mockEnv.AUTH_MODE = "local_noauth";

    await expect(
      WorkspaceMergeService.mergeLegacyWorkspaces(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nothing was touched.
    expect(
      await rows("SELECT cast(count(*) as integer) AS n FROM organization"),
    ).toEqual([expect.objectContaining({ n: 4 })]);
  });
});
