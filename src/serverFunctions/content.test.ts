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
import {
  captureContentSource,
  createContentBrief,
  saveContentRevision,
} from "./content";

beforeEach(testDb.seedProject);
afterAll(testDb.close);

it("captures under the verified project and rejects forged actor fields", async () => {
  const data = {
    projectId: "project",
    mutationId: "web-capture",
    source: {
      kind: "pasted" as const,
      title: "Source",
      attribution: "Owner",
      text: "evidence",
      publisherDate: null,
      language: null,
      market: null,
    },
  };
  expect(await captureContentSource({ data })).toMatchObject({
    source: { projectId: "project", sourceText: "evidence" },
  });
  const forged = { ...data, surface: "mcp" };
  await expect(captureContentSource({ data: forged })).rejects.toThrow();
  await expect(
    captureContentSource({ data: { ...data, projectId: "foreign-project" } }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("saves with the web surface and returns a conflict without replacing the draft", async () => {
  const brief = {
    target: "",
    objective: "",
    audience: "",
    outputKind: "article",
    topic: "Topic",
    locale: { language: "en", country: "US" },
  };
  const created = await createContentBrief({
    data: {
      projectId: "project",
      mutationId: "web-brief",
      expectedHeadVersion: 0,
      brief,
    },
  });
  if (!created.ok) throw new Error("Brief was not created");
  const data = {
    projectId: "project",
    contentId: created.revision.contentId,
    mutationId: "web-save",
    expectedHeadVersion: 1,
    expectedContextVersion: created.revision.contextVersion,
    brief,
    markdown: "Saved body",
    metadata: created.revision.metadata,
    sourceIds: [],
    claims: [],
    openQuestions: [],
    omissions: [],
  };
  const saved = await saveContentRevision({ data });
  expect(saved).toMatchObject({
    ok: true,
    revision: { markdown: "Saved body", surface: "web" },
  });
  expect(
    await saveContentRevision({
      data: { ...data, mutationId: "stale-save", markdown: "Local draft" },
    }),
  ).toMatchObject({
    ok: false,
    code: "revision_conflict",
    currentHeadVersion: 2,
  });
});
