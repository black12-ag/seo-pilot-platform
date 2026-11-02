import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// The provider and migration-applied fixture must exist before static repository imports.
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } = await import("./siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider, AUTH_MODE: "cloudflare_access" },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
import {
  SiteAuthorityRepository as repository,
  type AuthorityScope,
} from "./repositories/SiteAuthorityRepository";
import {
  issueAuthorityInputSchema,
  authorityMutationResultSchema,
} from "@/types/schemas/siteAuthority";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { saveWebsiteSetup } from "@/server/features/projects/repositories/ProjectWebsiteRepository";
import { WorkspaceMergeService } from "@/server/auth/workspace-merge";

const scope: AuthorityScope = {
  organizationId: "organization",
  userId: "user",
  role: "owner",
  requireMembership: true,
};
const origin = "https://example.com";
const now = 1_800_000_000_000;
const observation = {
  matched: true,
  observedAtMs: now + 1,
  evidenceSha256: "a".repeat(64),
  httpStatus: 200,
} as const;
async function issue(expectedVersion = 0, at = now) {
  const result = await repository.issue(
    scope,
    { projectId: "project", origin, method: "http_file", expectedVersion },
    at,
  );
  if (!result.ok || !result.state.challenge) throw new Error("Issue failed");
  return {
    projectId: "project",
    challengeId: result.state.challenge.id,
    expectedVersion: result.state.authority?.version ?? 0,
  };
}
async function claimed() {
  const input = await issue();
  const result = await repository.claim(scope, input, now);
  if (!result.ok || !result.claimToken) throw new Error("Claim failed");
  return { ...input, claimToken: result.claimToken };
}
async function verified() {
  const input = await claimed();
  await repository.complete(scope, input, observation, now + 1);
  return input;
}
beforeEach(testDb.seedProject);
afterAll(testDb.close);

describe(`site authority lifecycle (${testDb.provider})`, () => {
  it("rolls back issue candidate and pointer when a statement fails", async () => {
    testDb.failNextBatchAt(3);
    await expect(issue()).rejects.toThrow();
    expect(
      await testDb.execute("select * from site_authority_challenges"),
    ).toHaveLength(0);
    expect(
      await testDb.execute("select * from project_site_authority"),
    ).toHaveLength(0);
  });
  it("rolls back successful challenge if authority transition fails", async () => {
    const input = await claimed();
    testDb.failNextBatchAt(2);
    await expect(
      repository.complete(scope, input, observation, now + 1),
    ).rejects.toThrow();
    expect((await repository.get(scope, "project"))?.challenge).toMatchObject({
      status: "checking",
      claimToken: input.claimToken,
    });
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 2),
    ).toBeNull();
  });
  it("enforces composite project FK, state constraints, attribution nulling and deletion", async () => {
    await verified();
    await expect(
      testDb.execute("update site_authority_challenges set attempts_used=6"),
    ).rejects.toThrow();
    await expect(
      testDb.execute("update site_authority_challenges set nonce='x'"),
    ).rejects.toThrow();
    await expect(
      testDb.execute("update site_authority_challenges set claim_token='bad'"),
    ).rejects.toThrow();
    await expect(
      testDb.execute(
        "update project_site_authority set verified_until_ms=verified_at_ms",
      ),
    ).rejects.toThrow();
    await expect(
      testDb.execute(
        "update project_site_authority set verified_until_ms=null",
      ),
    ).rejects.toThrow();
    await expect(
      testDb.execute(
        "update site_authority_challenges set status='checking',claim_token='00000000-0000-4000-8000-000000000000',claim_until_ms=null",
      ),
    ).rejects.toThrow();
    await expect(
      testDb.execute("update site_authority_challenges set method='unknown'"),
    ).rejects.toThrow();
    await expect(
      testDb.execute(
        "insert into project_site_authority (project_id,version,status,current_challenge_id,updated_at_ms) select 'foreign-project',0,'pending',id,0 from site_authority_challenges",
      ),
    ).rejects.toThrow();
    await testDb.execute('delete from "user"');
    expect(
      (
        await testDb.execute(
          "select issued_by_user_id from site_authority_challenges",
        )
      )[0]?.issued_by_user_id,
    ).toBeNull();
    expect(
      await repository.getVerifiedGrant(
        { ...scope, requireMembership: false },
        "project",
        1,
        now + 2,
      ),
    ).toBeTruthy();
    await testDb.execute("delete from projects where id='project'");
    expect(
      await testDb.execute("select * from project_site_authority"),
    ).toHaveLength(0);
    expect(
      await testDb.execute("select * from site_authority_challenges"),
    ).toHaveLength(0);
    expect(await testDb.execute("select id from projects")).toHaveLength(1);
  });
  it("keeps every mutation below D1 parameters and rejects unknown wire fields", async () => {
    await verified();
    expect(testDb.maxParameters()).toBeLessThanOrEqual(100);
    expect(
      issueAuthorityInputSchema.safeParse({
        projectId: crypto.randomUUID(),
        origin,
        method: "http_file",
        expectedVersion: 0,
        role: "owner",
      }).success,
    ).toBe(false);
    expect(
      authorityMutationResultSchema.safeParse({ ok: true, claimToken: "leak" })
        .success,
    ).toBe(false);
  });
});
describe(`project lifecycle invalidation (${testDb.provider})`, () => {
  it("invalidates actual domain changes away and back, while preserving renames and market edits", async () => {
    await verified();
    await ProjectRepository.updateProject("project", "organization", {
      name: "Renamed",
      domain: "example.com",
      market: { locationCode: 2840, languageCode: "en" },
    });
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 2),
    ).toBeTruthy();
    await ProjectRepository.updateProjectWebsite(
      "project",
      "organization",
      "away.com",
      { locationCode: 2840, languageCode: "en" },
    );
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 2),
    ).toBeNull();
    await ProjectRepository.updateProjectWebsite(
      "project",
      "organization",
      "example.com",
      { locationCode: 2840, languageCode: "en" },
    );
    expect((await repository.get(scope, "project"))?.authority).toMatchObject({
      version: 3,
      status: "revoked",
      revocationReason: "website_changed",
    });
  });
  it("invalidates initial website domain fill; competitor edits alone preserve authority", async () => {
    await testDb.execute("update projects set domain=null where id='project'");
    await verified();
    const input = {
      projectId: "project",
      name: "Ignored",
      domain: "example.com",
      overview: "Business",
      competitors: [],
    };
    await saveWebsiteSetup("organization", input, "user", null);
    expect((await repository.get(scope, "project"))?.authority?.version).toBe(
      2,
    );
    await testDb.seedProject();
    await verified();
    await saveWebsiteSetup(
      "organization",
      {
        ...input,
        competitors: [{ name: "Rival", domain: "rival.com", notes: "" }],
      },
      "user",
      null,
    );
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 2),
    ).toBeTruthy();
  });
  it("archive and restoration require fresh proof and fence held claims", async () => {
    const input = await claimed();
    await ProjectRepository.archiveProject("project", "organization");
    await repository.complete(scope, input, observation, now + 2);
    expect(await repository.get(scope, "project")).toBeNull();
    await ProjectRepository.restoreProject("project", "organization");
    expect((await repository.get(scope, "project"))?.authority).toMatchObject({
      version: 3,
      status: "revoked",
      revocationReason: "project_archived",
    });
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 2),
    ).toBeNull();
  });
  it("rolls back invalidation and domain together on project write failure", async () => {
    await verified();
    testDb.failNextBatchAt(3);
    await expect(
      ProjectRepository.updateProjectWebsite(
        "project",
        "organization",
        "away.com",
        { locationCode: 2840, languageCode: "en" },
      ),
    ).rejects.toThrow();
    expect(
      (
        await testDb.execute("select domain from projects where id='project'")
      )[0]?.domain,
    ).toBe("example.com");
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 2),
    ).toBeTruthy();
  });
  it("workspace transfer revokes without moving usable grants into the new tenant", async () => {
    await verified();
    await testDb.executeMultiple(
      `insert into organization (id,name,slug,created_at) values ('delegated-old','Old workspace','old',${testDb.provider === "postgres" ? "now()" : "0"}),('shared-workspace','Shared','shared',${testDb.provider === "postgres" ? "now()" : "0"}); update projects set organization_id='delegated-old' where id='project';`,
    );
    await WorkspaceMergeService.mergeLegacyWorkspaces();
    const [row] = await testDb.execute(
      "select version,status,revocation_reason from project_site_authority",
    );
    expect(row).toMatchObject({
      version: 2,
      status: "revoked",
      revocation_reason: "organization_changed",
    });
    expect(
      await testDb.execute("select * from site_authority_challenges"),
    ).toHaveLength(1);
    expect(
      await repository.getVerifiedGrant(
        {
          ...scope,
          organizationId: "shared-workspace",
          requireMembership: false,
        },
        "project",
        2,
        now + 2,
      ),
    ).toBeNull();
  });
  it("aborts captured workspace merge atomically when a new project appears before locks", async () => {
    await verified();
    const timestamp = testDb.provider === "postgres" ? "now()" : "0";
    await testDb.executeMultiple(
      `insert into organization (id,name,slug,created_at) values ('delegated-old','Old workspace','old',${timestamp}),('shared-workspace','Shared','shared',${timestamp}); update projects set organization_id='delegated-old' where id='project'; insert into user_onboarding_answers (user_id,organization_id) values ('user','delegated-old');`,
    );
    testDb.beforeNextBatch(() =>
      testDb.executeMultiple(
        "insert into projects (id,organization_id,name) values ('concurrent-project','delegated-old','Concurrent')",
      ),
    );
    await expect(
      WorkspaceMergeService.mergeLegacyWorkspaces(),
    ).rejects.toThrow();
    expect(
      (
        await testDb.execute(
          "select organization_id from projects where id='project'",
        )
      )[0]?.organization_id,
    ).toBe("delegated-old");
    expect(
      (
        await testDb.execute(
          "select organization_id from user_onboarding_answers",
        )
      )[0]?.organization_id,
    ).toBe("delegated-old");
    expect(
      (
        await testDb.execute(
          "select version,status from project_site_authority",
        )
      )[0],
    ).toMatchObject({ version: 1, status: "verified" });
    expect(
      await testDb.execute(
        "select id from projects where id='concurrent-project'",
      ),
    ).toHaveLength(1);
  });
  it("leaves a concurrently created organization and its data outside captured merge scope", async () => {
    const timestamp = testDb.provider === "postgres" ? "now()" : "0";
    await testDb.executeMultiple(
      `insert into organization (id,name,slug,created_at) values ('delegated-old','Old workspace','old',${timestamp}),('shared-workspace','Shared','shared',${timestamp}); update projects set organization_id='delegated-old' where id='project';`,
    );
    testDb.beforeNextBatch(() =>
      testDb.executeMultiple(
        `insert into organization (id,name,slug,created_at) values ('delegated-new','New workspace','new',${timestamp}); insert into projects (id,organization_id,name) values ('new-project','delegated-new','New project'); insert into user_onboarding_answers (user_id,organization_id) values ('user','delegated-new');`,
      ),
    );
    expect(await WorkspaceMergeService.mergeLegacyWorkspaces()).toMatchObject({
      mergedWorkspaces: 1,
    });
    expect(
      (
        await testDb.execute(
          "select organization_id from projects where id='new-project'",
        )
      )[0]?.organization_id,
    ).toBe("delegated-new");
    expect(
      (
        await testDb.execute(
          "select organization_id from user_onboarding_answers",
        )
      )[0]?.organization_id,
    ).toBe("delegated-new");
    expect(
      await testDb.execute(
        "select id from organization where id='delegated-new'",
      ),
    ).toHaveLength(1);
  });
  it("preserves an owner rename between workspace enumeration and project lock", async () => {
    const timestamp = testDb.provider === "postgres" ? "now()" : "0";
    await testDb.executeMultiple(
      `insert into organization (id,name,slug,created_at) values ('delegated-old','Old workspace','old',${timestamp}),('shared-workspace','Shared','shared',${timestamp}); update projects set organization_id='delegated-old',name='Default',domain=null where id='project';`,
    );
    testDb.beforeNextBatch(() =>
      testDb.executeMultiple(
        "update projects set name='Owner rename',domain='owner.com' where id='project'",
      ),
    );
    await WorkspaceMergeService.mergeLegacyWorkspaces();
    expect(
      (
        await testDb.execute(
          "select name,domain,organization_id from projects where id='project'",
        )
      )[0],
    ).toMatchObject({
      name: "Owner rename",
      domain: "owner.com",
      organization_id: "shared-workspace",
    });
  });
});
