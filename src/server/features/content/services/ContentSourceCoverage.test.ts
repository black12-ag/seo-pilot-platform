import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as RuntimeEnv from "@/server/lib/runtime-env";

const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../../site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", async (original) => ({
  ...(await original<typeof RuntimeEnv>()),
  usesBetterAuthServer: async () => true,
  getWorkersEnv: async () => null,
}));
import { ContentSourceService } from "./ContentSourceService";
import { ContentService } from "./ContentService";

const actor = {
  userId: "user",
  organizationId: "organization",
  role: "owner",
  surface: "web",
} as const;
const brief = {
  target: "",
  objective: "",
  audience: "",
  outputKind: "article",
  topic: "Tea",
  locale: { language: "en", country: "US" },
};
beforeEach(async () => {
  await testDb.seedProject();
  vi.stubEnv("CRAWL_GATEWAY_URL", "https://gateway.example/fetch");
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "cloudflare-dns.com")
        return Response.json({ Status: 0, Answer: [] });
      return new Response("Evidence", {
        headers: { "content-type": "text/plain" },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(testDb.close);

it("persists source coverage for attached partial pages even without claims", async () => {
  const partial = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [{ mutationId: "partial", url: "https://example.com/partial" }],
  });
  expect(partial.outcomes[0]).toMatchObject({ extractionStatus: "partial" });
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "cloudflare-dns.com")
      return Response.json({ Status: 0, Answer: [] });
    return new Response(`<main>${"source text ".repeat(30)}</main>`, {
      headers: { "content-type": "text/html" },
    });
  });
  const usable = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [{ mutationId: "usable", url: "https://example.com/usable" }],
  });
  expect(usable.outcomes[0]).toMatchObject({ extractionStatus: "usable" });
  const created = await ContentService.createBrief(actor, {
    projectId: "project",
    mutationId: "create",
    expectedHeadVersion: 0,
    brief,
  });
  if (!created.ok) throw new Error("create failed");
  const contentId = created.revision.contentId;
  const revision = {
    projectId: "project",
    contentId,
    brief,
    markdown: "Evidence",
    metadata: {
      title: "Tea",
      slug: "tea",
      description: "",
      schemaSuggestion: "",
    },
    openQuestions: [],
    omissions: [],
  };
  const saved = await ContentService.saveRevision(actor, {
    ...revision,
    mutationId: "save-partial",
    expectedHeadVersion: 1,
    expectedContextVersion: created.revision.contextVersion,
    sourceIds: [partial.outcomes[0].sourceId],
    claims: [],
  });
  if (!saved.ok) throw new Error("save failed");
  const read = await ContentService.getRevision(actor, {
    projectId: "project",
    contentId,
  });
  expect(read.checks.ruleVersion).toBe("manual-v2");
  expect(
    read.checks.checks.filter((check) => check.rule === "source_coverage"),
  ).toEqual([
    expect.objectContaining({
      claimId: null,
      field: null,
      rule: "source_coverage",
      status: "partial",
      severity: "warning",
      explanation: "Source extraction is incomplete or unavailable.",
    }),
  ]);
  const usableRevision = await ContentService.saveRevision(actor, {
    ...revision,
    mutationId: "save-usable",
    expectedHeadVersion: 2,
    expectedContextVersion: read.revision.contextVersion,
    sourceIds: [usable.outcomes[0].sourceId],
    claims: [],
  });
  if (!usableRevision.ok) throw new Error("save failed");
  const usableRead = await ContentService.getRevision(actor, {
    projectId: "project",
    contentId,
  });
  expect(
    usableRead.checks.checks.some((check) => check.rule === "source_coverage"),
  ).toBe(false);
  const cited = await ContentService.saveRevision(actor, {
    ...revision,
    mutationId: "save-cited",
    expectedHeadVersion: 3,
    expectedContextVersion: usableRead.revision.contextVersion,
    sourceIds: [partial.outcomes[0].sourceId],
    claims: [
      {
        target: { kind: "markdown", start: 0, end: 8 },
        text: "Evidence",
        kind: "general",
        factual: true,
        evidence: [
          {
            sourceId: partial.outcomes[0].sourceId,
            start: 0,
            end: 8,
            excerpt: "Evidence",
            relation: "supports",
          },
        ],
      },
    ],
  });
  if (!cited.ok) throw new Error("save failed");
  const citedRead = await ContentService.getRevision(actor, {
    projectId: "project",
    contentId,
  });
  expect(
    citedRead.checks.checks.filter((check) => check.rule === "source_coverage"),
  ).toEqual([
    expect.objectContaining({
      claimId: null,
      status: "partial",
      severity: "warning",
    }),
    expect.objectContaining({
      claimId: citedRead.revision.claims[0].id,
      status: "partial",
      severity: "warning",
    }),
  ]);
});
