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
  authorityLimits,
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
async function verified() {
  const input = await claimed();
  await repository.complete(scope, input, observation, now + 1);
  return input;
}
beforeEach(testDb.seedProject);
afterAll(testDb.close);

describe(`site authority persistence (${testDb.provider})`, () => {
  it("reads absent authority and never exposes foreign tenant state", async () => {
    expect((await repository.get(scope, "project"))?.authority).toBeNull();
    expect(await repository.get(scope, "foreign-project")).toBeNull();
    expect(
      (
        await repository.issue(
          scope,
          {
            projectId: "foreign-project",
            origin,
            method: "http_file",
            expectedVersion: 0,
          },
          now,
        )
      ).ok,
    ).toBe(false);
    expect(
      await testDb.execute("select * from site_authority_challenges"),
    ).toHaveLength(0);
  });
  it("persists a finite grant; replay neither consumes attempts nor extends expiry", async () => {
    const input = await verified();
    const grant = await repository.getVerifiedGrant(
      scope,
      "project",
      1,
      now + 2,
    );
    expect(grant).toMatchObject({
      origin,
      version: 1,
      method: "http_file",
      verifiedUntilMs: now + 1 + authorityLimits.grantMs,
    });
    const replay = await repository.claim(scope, input, now + 5000);
    expect(replay.ok).toBe(true);
    expect(replay.claimToken).toBeUndefined();
    await repository.complete(scope, input, observation, now + 10_000);
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 10_001),
    ).toEqual(grant);
    expect(
      await repository.getVerifiedGrant(
        scope,
        "project",
        1,
        now + 1 + authorityLimits.grantMs,
      ),
    ).toBeNull();
  });
  it("reclaims expired leases and fences the old completion", async () => {
    const old = await claimed();
    const replacement = await repository.claim(
      scope,
      old,
      now + authorityLimits.claimMs,
    );
    expect(replacement.claimToken).toBeTruthy();
    expect(replacement.claimToken).not.toBe(old.claimToken);
    await repository.complete(
      scope,
      old,
      observation,
      now + authorityLimits.claimMs + 1,
    );
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 20_000),
    ).toBeNull();
    expect(
      (await repository.get(scope, "project"))?.challenge?.claimToken,
    ).toBe(replacement.claimToken);
  });
  it("cannot complete at lease deadline equality", async () => {
    const input = await claimed();
    await repository.complete(
      scope,
      input,
      observation,
      now + authorityLimits.claimMs,
    );
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 20_000),
    ).toBeNull();
  });
  it("immediately suspends the old grant on explicit reissue", async () => {
    await verified();
    const next = await issue(1, now + 60_000);
    expect(next.expectedVersion).toBe(2);
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 60_001),
    ).toBeNull();
    expect(
      (await repository.get(scope, "project"))?.authority?.verifiedUntilMs,
    ).toBeNull();
  });
  it("supersedes an outstanding claim when reissued", async () => {
    const old = await claimed();
    await issue(1, now + 60_000);
    await repository.complete(scope, old, observation, now + 60_001);
    expect((await repository.get(scope, "project"))?.authority).toMatchObject({
      version: 2,
      status: "pending",
    });
    expect(
      (
        await testDb.execute(
          `select status,claim_token from site_authority_challenges where id = '${old.challengeId}'`,
        )
      )[0],
    ).toMatchObject({ status: "superseded", claim_token: null });
  });
  it("preserves issue cooldown and fixed hourly counters across revoke", async () => {
    await issue();
    expect(
      await repository.issue(
        scope,
        {
          projectId: "project",
          origin,
          method: "http_file",
          expectedVersion: 1,
        },
        now + 59_999,
      ),
    ).toMatchObject({
      ok: false,
      code: "rate_limited",
      retryAtMs: now + 60_000,
    });
    await repository.revoke(
      scope,
      { projectId: "project", expectedVersion: 1 },
      now + 1,
    );
    await issue(2, now + 60_000);
    for (let i = 2; i < 10; i++) await issue(i + 1, now + i * 60_000);
    expect(
      await repository.issue(
        scope,
        {
          projectId: "project",
          origin,
          method: "dns_txt",
          expectedVersion: 11,
        },
        now + 10 * 60_000,
      ),
    ).toMatchObject({
      ok: false,
      code: "rate_limited",
      retryAtMs: now + authorityLimits.issueWindowMs,
    });
    expect(
      (await issue(11, now + authorityLimits.issueWindowMs)).expectedVersion,
    ).toBe(12);
    expect(
      (await repository.get(scope, "project"))?.authority?.issuedInWindow,
    ).toBe(1);
  });
  it("challenge expiry equality cannot verify or consume another check", async () => {
    const input = await issue();
    expect(
      await repository.claim(
        scope,
        input,
        now + authorityLimits.httpChallengeMs,
      ),
    ).toMatchObject({ ok: false, code: "expired" });
    expect(
      (await repository.get(scope, "project"))?.challenge?.attemptsUsed,
    ).toBe(0);
  });
  it("exhausts five failed checks and enforces check cooldown", async () => {
    const input = await issue();
    for (let i = 0; i < 5; i++) {
      const at = now + i * 10_000;
      const result = await repository.claim(scope, input, at);
      expect(result.claimToken).toBeTruthy();
      await repository.complete(
        scope,
        { ...input, claimToken: result.claimToken ?? "" },
        {
          matched: false,
          observedAtMs: at + 1,
          failure: "mismatch",
          httpStatus: 200,
        },
        at + 1,
      );
      if (i === 0)
        expect(await repository.claim(scope, input, at + 2)).toMatchObject({
          ok: false,
          code: "rate_limited",
        });
    }
    expect(await repository.claim(scope, input, now + 50_000)).toMatchObject({
      ok: false,
      code: "exhausted",
    });
    expect((await repository.get(scope, "project"))?.authority?.status).toBe(
      "unverified",
    );
  });
  it("exhausts five abandoned leases", async () => {
    const input = await issue();
    for (let i = 0; i < 5; i++)
      expect(
        (
          await repository.claim(
            scope,
            input,
            now + i * authorityLimits.claimMs,
          )
        ).claimToken,
      ).toBeTruthy();
    expect(
      await repository.claim(scope, input, now + 5 * authorityLimits.claimMs),
    ).toMatchObject({ ok: false, code: "exhausted" });
  });
  it("revocation fences held checks and stale versions", async () => {
    const input = await claimed();
    expect(
      (
        await repository.revoke(
          scope,
          { projectId: "project", expectedVersion: 1 },
          now + 2,
        )
      ).ok,
    ).toBe(true);
    await repository.complete(scope, input, observation, now + 3);
    expect(
      await repository.getVerifiedGrant(scope, "project", 2, now + 4),
    ).toBeNull();
    expect(
      (
        await repository.revoke(
          scope,
          { projectId: "project", expectedVersion: 1 },
          now + 4,
        )
      ).ok,
    ).toBe(true);
    await issue(2, now + 60_000);
    expect(
      await repository.revoke(
        scope,
        { projectId: "project", expectedVersion: 1 },
        now + 60_001,
      ),
    ).toMatchObject({ ok: false, code: "stale" });
    expect((await repository.get(scope, "project"))?.authority?.version).toBe(
      3,
    );
  });
  it("does not mint a grant after current membership removal", async () => {
    const input = await claimed();
    await testDb.execute("delete from member");
    expect(
      await repository.complete(scope, input, observation, now + 1),
    ).toBeNull();
    expect(
      (await testDb.execute("select status from project_site_authority"))[0]
        ?.status,
    ).toBe("pending");
    expect(
      await repository.getVerifiedGrant(scope, "project", 1, now + 2),
    ).toBeNull();
  });
  it("scopes challenge IDs and grants independently of supplied foreign IDs", async () => {
    const input = await verified();
    expect(
      await repository.claim(
        scope,
        { ...input, projectId: "foreign-project" },
        now + 1,
      ),
    ).toMatchObject({ ok: false, state: null });
    expect(
      await repository.getVerifiedGrant(
        { ...scope, organizationId: "foreign" },
        "project",
        1,
        now + 1,
      ),
    ).toBeNull();
    expect(
      await repository.getVerifiedGrant(scope, "project", 0, now + 1),
    ).toBeNull();
  });
});
