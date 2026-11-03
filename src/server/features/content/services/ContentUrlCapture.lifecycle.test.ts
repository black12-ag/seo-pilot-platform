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
import { ContentReviewService } from "./ContentReviewService";
import { ContentExportService } from "./contentExport";
const actor = {
  userId: "user",
  organizationId: "organization",
  role: "owner",
  surface: "web",
} as const;
beforeEach(testDb.seedProject);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(testDb.close);
it("persists deadline outcomes for siblings that did not start", async () => {
  vi.stubEnv("CRAWL_GATEWAY_URL", "https://gateway.example/fetch");
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-secret");
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "cloudflare-dns.com")
        return Response.json({ Status: 0, Answer: [] });
      now += 31_000;
      return new Response(`<main>${"evidence ".repeat(30)}</main>`, {
        headers: { "content-type": "text/html" },
      });
    }),
  );
  const result = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [
      { mutationId: "one", url: "https://example.com/one" },
      { mutationId: "two", url: "https://example.com/two" },
    ],
  });
  expect(result.outcomes[1]).toMatchObject({
    state: "captured",
    extractionStatus: "failed",
    extractionReason: "operation_deadline",
    urlCapture: { fetchAttempted: false },
  });
  expect(
    await testDb.execute("select source_id from content_source_url_captures"),
  ).toHaveLength(2);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(
        ([input]) => input === "https://gateway.example/fetch",
      ),
  ).toHaveLength(1);
});

it("rejects a web source erased between revision validation and its write", async () => {
  vi.stubEnv("CRAWL_GATEWAY_URL", "https://gateway.example/fetch");
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "cloudflare-dns.com")
        return Response.json({ Status: 0, Answer: [] });
      return new Response(`<main>${"evidence ".repeat(30)}</main>`, {
        headers: { "content-type": "text/html" },
      });
    }),
  );
  const capture = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [{ mutationId: "source", url: "https://example.com/" }],
  });
  const sourceId = capture.outcomes[0].sourceId;
  const brief = {
    target: "",
    objective: "",
    audience: "",
    outputKind: "article",
    topic: "Tea",
    locale: { language: "en", country: "US" },
  };
  const created = await ContentService.createBrief(actor, {
    projectId: "project",
    mutationId: "create",
    expectedHeadVersion: 0,
    brief,
  });
  if (!created.ok) throw new Error("create failed");
  testDb.beforeNextBatch(async () => {
    await testDb.executeMultiple(
      `DELETE FROM content_source_url_captures WHERE source_id = '${sourceId}'; UPDATE content_sources SET extraction_status = 'erased' WHERE id = '${sourceId}';`,
    );
  });
  await expect(
    ContentService.saveRevision(actor, {
      projectId: "project",
      contentId: created.revision.contentId,
      mutationId: "save",
      expectedHeadVersion: 1,
      expectedContextVersion: created.revision.contextVersion,
      brief,
      markdown: "Evidence",
      metadata: {
        title: "Tea",
        slug: "tea",
        description: "",
        schemaSuggestion: "",
      },
      sourceIds: [sourceId],
      claims: [],
      openQuestions: [],
      omissions: [],
    }),
  ).rejects.toThrow();
  expect(await testDb.execute("select id from content_revisions")).toHaveLength(
    1,
  );
});

it("marks cited partial URL extraction in revision checks and handles later erasure", async () => {
  vi.stubEnv("CRAWL_GATEWAY_URL", "https://gateway.example/fetch");
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-secret");
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(fetch).mockImplementation(async (input) => {
    const parsed = new URL(input instanceof Request ? input.url : input);
    if (parsed.hostname === "cloudflare-dns.com")
      return Response.json({ Status: 0, Answer: [] });
    return new Response("Evidence", {
      headers: { "content-type": "text/plain" },
    });
  });
  const capture = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [{ mutationId: "one", url: "https://example.com/one" }],
  });
  expect(capture.outcomes[0]).toMatchObject({ extractionStatus: "partial" });
  const brief = {
    target: "",
    objective: "",
    audience: "",
    outputKind: "article",
    topic: "Tea",
    locale: { language: "en", country: "US" },
  };
  const created = await ContentService.createBrief(actor, {
    projectId: "project",
    mutationId: "create",
    expectedHeadVersion: 0,
    brief,
  });
  if (!created.ok) throw new Error("create failed");
  const sourceId = capture.outcomes[0].sourceId;
  const saved = await ContentService.saveRevision(actor, {
    projectId: "project",
    contentId: created.revision.contentId,
    mutationId: "save",
    expectedHeadVersion: 1,
    expectedContextVersion: created.revision.contextVersion,
    brief,
    markdown: "Evidence",
    metadata: {
      title: "Tea",
      slug: "tea",
      description: "",
      schemaSuggestion: "",
    },
    sourceIds: [sourceId],
    claims: [
      {
        target: { kind: "markdown", start: 0, end: 8 },
        text: "Evidence",
        kind: "general",
        factual: true,
        evidence: [
          {
            sourceId,
            start: 0,
            end: 8,
            excerpt: "Evidence",
            relation: "supports",
          },
        ],
      },
    ],
    openQuestions: [],
    omissions: [],
  });
  if (!saved.ok) throw new Error("save failed");
  const read = await ContentService.getRevision(actor, {
    projectId: "project",
    contentId: saved.revision.contentId,
  });
  expect(read.checks.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rule: "source_coverage", status: "partial" }),
    ]),
  );
  const review = await ContentReviewService.request(actor, {
    projectId: "project",
    contentId: read.revision.contentId,
    revisionId: read.revision.id,
    mutationId: "review",
    expectedHeadVersion: 2,
    expectedContextVersion: read.revision.contextVersion,
    checkSetId: read.checks.id,
    assigneeUserId: "user",
  });
  await ContentReviewService.decide(actor, {
    projectId: "project",
    contentId: read.revision.contentId,
    requestId: review.id,
    mutationId: "approve",
    expectedRequestVersion: 0,
    expectedHeadVersion: 2,
    decision: "approve",
    claimAssessments: [
      {
        claimId: read.revision.claims[0].id,
        assessment: "supported",
        reason: "Reviewed",
      },
    ],
    assessedRemainingText: true,
    reason: "Reviewed",
  });
  const exportInput = {
    projectId: "project",
    contentId: read.revision.contentId,
    revisionId: read.revision.id,
    format: "json",
  } as const;
  const artifact = await ContentExportService.exportRevision(
    actor,
    exportInput,
  );
  expect(JSON.parse(artifact.content)).toMatchObject({
    payload: {
      sources: [{ urlCapture: { requestedUrl: "https://example.com/one" } }],
    },
  });
  await testDb.execute(
    `UPDATE content_sources SET extraction_status = 'erased' WHERE id = '${sourceId}'`,
  );
  const erased = await ContentService.getRevision(actor, {
    projectId: "project",
    contentId: saved.revision.contentId,
  });
  expect(erased.sources[0]).toMatchObject({
    state: "unavailable",
    source: null,
  });
  const erasedExport = await ContentExportService.exportRevision(
    actor,
    exportInput,
  );
  expect(JSON.parse(erasedExport.content)).toMatchObject({
    payload: {
      sources: [],
      unavailableSourceIds: [sourceId],
      eligibility: { eligible: false },
    },
  });
});
