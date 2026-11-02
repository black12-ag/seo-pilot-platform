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
  getSiteAuthority,
  issueSiteAuthorityChallenge,
  checkSiteAuthorityChallenge,
  revokeSiteAuthority,
} from "./siteAuthority";

const projectId = "10000000-0000-4000-8000-000000000001";
const foreignId = "20000000-0000-4000-8000-000000000002";
beforeEach(async () => {
  await testDb.seedProject();
  await testDb.execute(
    `UPDATE projects SET id='${projectId}' WHERE id='project'`,
  );
  await testDb.execute(
    `UPDATE projects SET id='${foreignId}' WHERE id='foreign-project'`,
  );
  request.context.userId = "user";
  request.context.projectId = projectId;
  vi.stubEnv("AUTH_MODE", "password");
  vi.stubEnv("CRAWL_GATEWAY_URL", "https://gateway.example/fetch");
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-gateway-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      new URL(input instanceof Request ? input.url : input).hostname ===
      "cloudflare-dns.com"
        ? Response.json({ Status: 0, Question: [], Answer: [] })
        : new Response("missing", { status: 404 }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(testDb.close);

describe("site authority server functions with SQL", () => {
  it("reads, issues, checks missing public proof and revokes through the public functions", async () => {
    expect(await getSiteAuthority({ data: { projectId } })).toMatchObject({
      authority: { status: "unverified", version: 0 },
    });
    const issued = await issueSiteAuthorityChallenge({
      data: {
        projectId,
        origin: "https://example.com",
        method: "http_file",
        expectedVersion: 0,
      },
    });
    if (!issued.authority.challenge) throw new Error("Missing challenge");
    expect(
      await checkSiteAuthorityChallenge({
        data: {
          projectId,
          challengeId: issued.authority.challenge.id,
          expectedVersion: 1,
        },
      }),
    ).toMatchObject({
      ok: true,
      authority: { status: "pending", challenge: { lastFailure: "not_found" } },
    });
    expect(
      await revokeSiteAuthority({ data: { projectId, expectedVersion: 1 } }),
    ).toMatchObject({ ok: true, authority: { status: "revoked", version: 2 } });
  });
  it("rejects a project that differs from middleware's project before any fetch or write", async () => {
    await expect(
      issueSiteAuthorityChallenge({
        data: {
          projectId: foreignId,
          origin: "https://example.com",
          method: "http_file",
          expectedVersion: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await testDb.execute("SELECT * FROM project_site_authority"),
    ).toHaveLength(0);
  });
  it("reauthorizes foreign middleware project IDs instead of trusting their presence", async () => {
    request.context.projectId = foreignId;
    await expect(
      getSiteAuthority({ data: { projectId: foreignId } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejects anonymous, removed and demoted accounts", async () => {
    request.context.userId = "";
    await expect(
      getSiteAuthority({ data: { projectId } }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    request.context.userId = "user";
    await testDb.execute("UPDATE member SET role='member'");
    await expect(
      issueSiteAuthorityChallenge({
        data: {
          projectId,
          origin: "https://example.com",
          method: "dns_txt",
          expectedVersion: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await testDb.execute("DELETE FROM member");
    await expect(
      getSiteAuthority({ data: { projectId } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects forged body identity and TTL fields through the actual shared validator", async () => {
    const data = {
      projectId,
      origin: "https://example.com",
      method: "http_file" as const,
      expectedVersion: 0,
      role: "owner",
      ttl: 1,
    };
    await expect(issueSiteAuthorityChallenge({ data })).rejects.toThrow();
    expect(
      await testDb.execute("SELECT * FROM project_site_authority"),
    ).toHaveLength(0);
  });
});
