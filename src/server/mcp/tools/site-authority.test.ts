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
  getSiteAuthorityTool,
  issueSiteAuthorityChallengeTool,
  checkSiteAuthorityChallengeTool,
  revokeSiteAuthorityTool,
} from "./site-authority";
import { makeToolContext, textContent } from "./tool-test-support";
import { buildSamMcpTools } from "@/server/features/sam/samChatTools";

const projectId = "10000000-0000-4000-8000-000000000001";
const foreignId = "20000000-0000-4000-8000-000000000002";
const origin = "https://example.com";
const context = makeToolContext({
  userId: "user",
  organizationId: "organization",
  role: "owner",
  clientId: "api_key",
});
let proof = "";
beforeEach(async () => {
  await testDb.seedProject();
  await testDb.execute(
    `UPDATE projects SET id='${projectId}' WHERE id='project'`,
  );
  await testDb.execute(
    `UPDATE projects SET id='${foreignId}' WHERE id='foreign-project'`,
  );
  proof = "";
  vi.stubEnv("AUTH_MODE", "password");
  vi.stubEnv("CRAWL_GATEWAY_URL", "https://gateway.example/fetch");
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-gateway-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== "cloudflare-dns.com") return new Response(proof);
      const kind = url.searchParams.get("type");
      const type = kind === "TXT" ? 16 : kind === "AAAA" ? 28 : 1;
      const name = url.searchParams.get("name");
      return Response.json({
        Status: 0,
        Question: [{ name, type }],
        Answer:
          kind === "AAAA"
            ? []
            : [
                {
                  name,
                  type,
                  TTL: 60,
                  data:
                    kind === "TXT" ? JSON.stringify(proof) : "93.184.216.34",
                },
              ],
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(testDb.close);

describe(`public site authority MCP and SAM (${testDb.provider})`, () => {
  it.each(["http_file", "dns_txt"] as const)(
    "issues and verifies %s through the real service and SQL with output schemas/deep links",
    async (method) => {
      const issued = await issueSiteAuthorityChallengeTool.handler(
        { projectId, origin, method, expectedVersion: 0 },
        context,
      );
      const data = issueSiteAuthorityChallengeTool.config.outputSchema.parse(
        issued.structuredContent,
      );
      if (!data.ok || !data.instructions || !data.authority.challenge)
        throw new Error("Issue failed");
      proof =
        data.instructions.method === "http_file"
          ? data.instructions.content
          : data.instructions.value;
      expect(textContent(issued)).toContain(proof);
      expect(issued.isError).toBe(false);
      const checked = await checkSiteAuthorityChallengeTool.handler(
        {
          projectId,
          challengeId: data.authority.challenge.id,
          expectedVersion: 1,
        },
        context,
      );
      expect(checked.isError).toBe(false);
      const checkedData =
        checkSiteAuthorityChallengeTool.config.outputSchema.parse(
          checked.structuredContent,
        );
      expect(checkedData).toMatchObject({
        ok: true,
        authority: {
          status: "verified",
          origin,
          verifiedMethod: method,
          version: 1,
        },
        meta: {
          url: `https://open-seo.test/p/${projectId}/settings/integrations#site-authority`,
        },
      });
      expect(textContent(checked)).toContain("does not connect a publisher");
      const calls = vi.mocked(fetch).mock.calls.length;
      await checkSiteAuthorityChallengeTool.handler(
        {
          projectId,
          challengeId: data.authority.challenge.id,
          expectedVersion: 1,
        },
        context,
      );
      expect(fetch).toHaveBeenCalledTimes(calls);
      const revoked = await revokeSiteAuthorityTool.handler(
        { projectId, expectedVersion: 1 },
        context,
      );
      expect(
        revokeSiteAuthorityTool.config.outputSchema.parse(
          revoked.structuredContent,
        ),
      ).toMatchObject({
        ok: true,
        authority: { status: "revoked", version: 2 },
      });
    },
  );

  it("marks pending proof failures and typed refusals as MCP errors", async () => {
    const issued = await issueSiteAuthorityChallengeTool.handler(
      { projectId, origin, method: "http_file", expectedVersion: 0 },
      context,
    );
    const data = issueSiteAuthorityChallengeTool.config.outputSchema.parse(
      issued.structuredContent,
    );
    if (!data.authority.challenge) throw new Error("Missing challenge");
    proof = "wrong value";
    const input = {
      projectId,
      challengeId: data.authority.challenge.id,
      expectedVersion: 1,
    };
    const result = await checkSiteAuthorityChallengeTool.handler(
      input,
      context,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: true,
        authority: {
          status: "pending",
          challenge: { lastFailure: "mismatch" },
        },
      },
    });
    const refused = await checkSiteAuthorityChallengeTool.handler(
      input,
      context,
    );
    expect(refused).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "rate_limited" },
    });
  });

  it("protects foreign and removed API-key callers, and gives members status without proof values", async () => {
    await issueSiteAuthorityChallengeTool.handler(
      { projectId, origin, method: "dns_txt", expectedVersion: 0 },
      context,
    );
    await expect(
      getSiteAuthorityTool.handler({ projectId: foreignId }, context),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await testDb.execute("UPDATE member SET role='member'");
    const status = await getSiteAuthorityTool.handler({ projectId }, context);
    expect(status.structuredContent).toMatchObject({
      authority: { canManage: false, status: "pending" },
    });
    expect(status.structuredContent).not.toHaveProperty("instructions");
    expect(textContent(status)).not.toContain("seo-pilot-site-verification=");
    await expect(
      revokeSiteAuthorityTool.handler(
        { projectId, expectedVersion: 1 },
        context,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await testDb.execute("DELETE FROM member");
    await expect(
      getSiteAuthorityTool.handler({ projectId }, context),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("binds SAM authority calls to the session project and rechecks a demoted user during the turn", async () => {
    const sam = buildSamMcpTools(
      { ...context.auth, clientId: null },
      { id: projectId, domain: null },
    );
    const options = { toolCallId: "authority", messages: [] };
    const issue = sam.issue_site_authority_challenge;
    const result: unknown = await issue.execute?.(
      { projectId: foreignId, origin, method: "http_file", expectedVersion: 0 },
      options,
    );
    expect(result).toMatchObject({
      data: { authority: { projectId, status: "pending", version: 1 } },
    });
    expect(
      await testDb.execute(
        `SELECT * FROM project_site_authority WHERE project_id='${foreignId}'`,
      ),
    ).toHaveLength(0);
    await testDb.execute("UPDATE member SET role='member'");
    const revoke = sam.revoke_site_authority;
    const denied: unknown = await revoke.execute?.(
      { expectedVersion: 1 },
      options,
    );
    expect(denied).toHaveProperty(
      "error",
      "Your organization role does not allow this action.",
    );
    expect(
      await testDb.execute("SELECT status FROM project_site_authority"),
    ).toMatchObject([{ status: "pending" }]);
  });

  it("rejects forged identity and TTL fields rather than using them", async () => {
    const input = {
      projectId,
      origin,
      method: "http_file" as const,
      expectedVersion: 0,
      organizationId: "foreign",
      ttl: 1,
    };
    await expect(
      issueSiteAuthorityChallengeTool.handler(input, context),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      await testDb.execute("SELECT * FROM project_site_authority"),
    ).toHaveLength(0);
  });
});
