import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Real migrations/provider selection precede the statically imported access entry.
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } = await import("../siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
import { siteAuthorityAccess } from "./siteAuthorityAccess";

const actor = { userId: "user", organizationId: "organization", role: "owner" };
beforeEach(async () => {
  await testDb.seedProject();
  vi.stubEnv("AUTH_MODE", "password");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(testDb.close);

describe("current site authority access", () => {
  it("requires identity and current account membership without an owner fallback", async () => {
    await expect(
      siteAuthorityAccess({ ...actor, userId: "" }, "project"),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await testDb.execute("DELETE FROM member");
    await expect(
      siteAuthorityAccess(actor, "project", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(["member", "unknown"])(
    "denies %s management using the live role rather than the caller's stale role",
    async (role) => {
      await testDb.execute(`UPDATE member SET role='${role}'`);
      await expect(
        siteAuthorityAccess(actor, "project", true),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );
  it.each(["owner", "admin", "member,admin"])(
    "allows current %s management through the existing permission helper",
    async (role) => {
      await testDb.execute(`UPDATE member SET role='${role}'`);
      expect(
        await siteAuthorityAccess(
          { ...actor, role: "member" },
          "project",
          true,
        ),
      ).toMatchObject({
        scope: { role, requireMembership: true },
        canManage: true,
      });
    },
  );
  it("does not expose foreign or archived projects", async () => {
    await expect(
      siteAuthorityAccess(actor, "foreign-project"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await testDb.execute(
      "UPDATE projects SET archived_at=CURRENT_TIMESTAMP WHERE id='project'",
    );
    await expect(siteAuthorityAccess(actor, "project")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("retains the verified delegated identity's role and has no account-membership requirement in delegated mode", async () => {
    vi.stubEnv("AUTH_MODE", "cloudflare_access");
    await testDb.execute("DELETE FROM member");
    expect(await siteAuthorityAccess(actor, "project", true)).toMatchObject({
      scope: { role: "owner", requireMembership: false },
    });
    await expect(
      siteAuthorityAccess({ ...actor, role: "unknown" }, "project", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
