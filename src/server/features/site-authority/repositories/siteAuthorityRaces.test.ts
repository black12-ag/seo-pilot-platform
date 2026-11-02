import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// The provider and migration-applied fixture must exist before static repository imports.
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } = await import("../siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
import {
  SiteAuthorityRepository as repository,
  type AuthorityScope,
} from "./SiteAuthorityRepository";

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
beforeEach(testDb.seedProject);
afterAll(testDb.close);

describe(`site authority authorization races (${testDb.provider})`, () => {
  it("serializes two first issues into one live generation", async () => {
    const results = await Promise.all([
      issue().catch(() => null),
      issue().catch(() => null),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await testDb.execute("select id from site_authority_challenges"),
    ).toHaveLength(1);
    expect((await repository.get(scope, "project"))?.authority?.version).toBe(
      1,
    );
  });
  it("consumes one lease for concurrent claims", async () => {
    const input = await issue();
    const results = await Promise.all([
      repository.claim(scope, input, now),
      repository.claim(scope, input, now),
    ]);
    expect(results.filter((result) => result.claimToken)).toHaveLength(1);
    expect(results.some((result) => !result.ok && result.code === "busy")).toBe(
      true,
    );
    expect(
      (await repository.get(scope, "project"))?.challenge?.attemptsUsed,
    ).toBe(1);
  });

  it("removes only an exact unreferenced candidate when membership disappears between issue insert and CAS", async () => {
    testDb.mutateMembershipInNextBatchAt(3, null);
    expect(
      await repository.issue(
        scope,
        {
          projectId: "project",
          origin,
          method: "http_file",
          expectedVersion: 0,
        },
        now,
      ),
    ).toMatchObject({ ok: false, state: null });
    expect(
      await testDb.execute("select * from site_authority_challenges"),
    ).toHaveLength(0);
    await testDb.execute(
      `insert into member (id,organization_id,user_id,role,created_at) values ('replacement','organization','user','admin',${testDb.provider === "postgres" ? "now()" : "0"})`,
    );
    expect(
      (
        await repository.issue(
          { ...scope, role: "admin" },
          {
            projectId: "project",
            origin,
            method: "http_file",
            expectedVersion: 0,
          },
          now,
        )
      ).ok,
    ).toBe(true);
    expect(
      await testDb.execute("select * from site_authority_challenges"),
    ).toHaveLength(1);
  });
  it.each([2, 3])(
    "membership removal before terminal statement %i cannot leave usable authority",
    async (index) => {
      const input = await claimed();
      testDb.mutateMembershipInNextBatchAt(index, null);
      expect(
        await repository.complete(scope, input, observation, now + 1),
      ).toBeNull();
      expect(
        await repository.getVerifiedGrant(scope, "project", 1, now + 2),
      ).toBeNull();
      // Even a delegated-mode read cannot accept a partially finalized grant.
      expect(
        await repository.getVerifiedGrant(
          { ...scope, requireMembership: false },
          "project",
          1,
          now + 2,
        ),
      ).toBeNull();
    },
  );
  it("stale completion with identical failed observation cannot change another claim's receipt", async () => {
    const old = await claimed();
    const current = await repository.claim(scope, old, now + 15_000);
    const failure = {
      matched: false,
      observedAtMs: now + 15_001,
      failure: "mismatch",
      httpStatus: 200,
    } as const;
    await repository.complete(
      scope,
      { ...old, claimToken: current.claimToken ?? "" },
      failure,
      now + 15_001,
    );
    const before = await repository.get(scope, "project");
    expect(before?.authority?.completionClaimToken).toBe(current.claimToken);
    await repository.complete(scope, old, failure, now + 15_002);
    expect(await repository.get(scope, "project")).toEqual(before);
  });
  it("stale completion with identical success cannot extend the current grant", async () => {
    const old = await claimed();
    const current = await repository.claim(scope, old, now + 15_000);
    await repository.complete(
      scope,
      { ...old, claimToken: current.claimToken ?? "" },
      observation,
      now + 15_001,
    );
    const before = await repository.getVerifiedGrant(
      scope,
      "project",
      1,
      now + 15_002,
    );
    await repository.complete(scope, old, observation, now + 15_003);
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 15_004),
    ).toEqual(before);
    expect(
      (await repository.get(scope, "project"))?.authority?.completionClaimToken,
    ).toBe(current.claimToken);
  });
  it("concurrent revoke versus check completion cannot reactivate a revoked generation", async () => {
    const input = await claimed();
    await Promise.all([
      repository.complete(scope, input, observation, now + 1),
      repository.revoke(
        scope,
        { projectId: "project", expectedVersion: 1 },
        now + 1,
      ),
    ]);
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 2),
    ).toBeNull();
    expect((await repository.get(scope, "project"))?.authority).toMatchObject({
      version: 2,
      status: "revoked",
    });
  });
  it("requires current exact role while allowing valid combined roles", async () => {
    await testDb.execute("update member set role='member,admin'");
    expect(
      (
        await repository.issue(
          { ...scope, role: "member,admin" },
          {
            projectId: "project",
            origin,
            method: "http_file",
            expectedVersion: 0,
          },
          now,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await repository.claim(
          scope,
          {
            projectId: "project",
            challengeId: crypto.randomUUID(),
            expectedVersion: 1,
          },
          now,
        )
      ).ok,
    ).toBe(false);
    const state = await repository.get(
      { ...scope, role: "member,admin" },
      "project",
    );
    await testDb.execute("update member set role='member'");
    expect(
      await repository.get({ ...scope, role: "member,admin" }, "project"),
    ).toBeNull();
    expect(
      (
        await repository.revoke(
          { ...scope, role: "member" },
          {
            projectId: "project",
            expectedVersion: state?.authority?.version ?? 0,
          },
          now + 1,
        )
      ).ok,
    ).toBe(false);
  });
  it.skipIf(testDb.provider !== "postgres")(
    "organization key lock blocks a second connection's FK insert through deletion",
    async () => {
      const pg = testDb.pg;
      if (!pg) throw new Error("PostgreSQL prerequisite missing");
      const writer = await pg.reserve();
      const [identity] = await writer<
        { pid: number }[]
      >`select pg_backend_pid() as pid`;
      if (!identity) throw new Error("Writer connection missing");
      let insert: Promise<boolean> = Promise.resolve(false);
      let wasBlocked = false;
      try {
        await pg.begin(async (tx) => {
          await tx`select id from organization where id='organization' for update`;
          insert =
            writer`insert into projects (id,organization_id,name) values ('late-project','organization','Late')`.then(
              () => false,
              (error: unknown) =>
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "23503",
            );
          for (let attempt = 0; attempt < 100; attempt++) {
            const [waiting] = await pg<
              { wait_event_type: string }[]
            >`select wait_event_type from pg_stat_activity where pid=${identity.pid}`;
            if (waiting?.wait_event_type === "Lock") {
              wasBlocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(wasBlocked).toBe(true);
          await tx`update projects set organization_id='foreign' where organization_id='organization'`;
          await tx`delete from organization where id='organization'`;
        });
        expect(await insert).toBe(true);
        expect(
          await testDb.execute(
            "select id from projects where id='late-project'",
          ),
        ).toHaveLength(0);
        expect(
          await testDb.execute("select id from projects where id='project'"),
        ).toHaveLength(1);
      } finally {
        await insert;
        writer.release();
      }
    },
  );
});
