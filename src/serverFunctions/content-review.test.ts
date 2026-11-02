import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { z } from "zod";
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
        projectId: "project",
      },
    },
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  usesBetterAuthServer: async () => true,
}));
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
import { ContentService } from "@/server/features/content/services/ContentService";
import { requestContentReview, decideContentReview } from "./content-review";

beforeEach(testDb.seedProject);
afterAll(testDb.close);

it("requires current review permission and rejects a forged actor at the decision entry", async () => {
  const actor = {
    userId: "user",
    organizationId: "organization",
    role: "owner",
    surface: "web" as const,
  };
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
  const review = await requestContentReview({
    data: {
      projectId: "project",
      contentId: read.revision.contentId,
      revisionId: read.revision.id,
      mutationId: "request",
      expectedHeadVersion: 1,
      expectedContextVersion: read.revision.contextVersion,
      checkSetId: read.checks.id,
      assigneeUserId: "user",
    },
  });
  const decision = {
    projectId: "project",
    contentId: read.revision.contentId,
    requestId: review.id,
    mutationId: "decision",
    expectedRequestVersion: 0,
    expectedHeadVersion: 1,
    decision: "approve" as const,
    claimAssessments: [],
    assessedRemainingText: true,
    reason: "Reviewed",
  };
  const forged = { ...decision, surface: "web", role: "owner" };
  await expect(decideContentReview({ data: forged })).rejects.toThrow();
  await testDb.execute("UPDATE member SET role = 'member'");
  await expect(decideContentReview({ data: decision })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
