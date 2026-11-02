import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../../features/site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  usesBetterAuthServer: async () => true,
}));
import { ContentService } from "@/server/features/content/services/ContentService";
import {
  getContentReviewTool,
  requestContentReviewTool,
} from "./content-review-tools";
import { makeToolContext } from "./tool-test-support";

beforeEach(testDb.seedProject);
afterAll(testDb.close);

it("requests human review and returns its authenticated link without approving", async () => {
  const actor = {
    userId: "user",
    organizationId: "organization",
    role: "owner",
    surface: "mcp" as const,
  };
  const context = makeToolContext(actor);
  const created = await ContentService.createBrief(actor, {
    projectId: "project",
    mutationId: "brief",
    expectedHeadVersion: 0,
    brief: {
      target: "",
      objective: "",
      audience: "",
      outputKind: "article",
      topic: "Tea",
      locale: { language: "am", country: "ET" },
    },
  });
  if (!created.ok) throw new Error("Brief was not created");
  const read = await ContentService.getRevision(actor, {
    projectId: "project",
    contentId: created.revision.contentId,
  });
  const input = {
    projectId: "project",
    contentId: read.revision.contentId,
    revisionId: read.revision.id,
    mutationId: "request",
    expectedHeadVersion: 1,
    expectedContextVersion: read.revision.contextVersion,
    checkSetId: read.checks.id,
    assigneeUserId: "user",
  };
  const result = await requestContentReviewTool("mcp").handler(input, context);
  expect(result.structuredContent).toMatchObject({
    review: { state: "pending" },
    eventsOmitted: true,
  });
  const links = z
    .object({ downloadUrl: z.string(), meta: z.object({ url: z.string() }) })
    .parse(result.structuredContent);
  expect(links.downloadUrl).toContain("/api/content/");
  expect(links.meta.url).toContain("/content/review");
  expect(
    (
      await getContentReviewTool("mcp").handler(
        { projectId: "project", contentId: input.contentId },
        context,
      )
    ).structuredContent,
  ).toMatchObject({ review: { state: "pending" } });
});
