import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { sortBy } from "remeda";
import type * as RuntimeEnv from "@/server/lib/runtime-env";
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("../site-authority/siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
  waitUntil: (promise: Promise<unknown>) => {
    void promise.catch(() => {});
  },
}));
vi.mock("@/db", () => ({
  db: testDb.db,
  withPgClient: (run: () => unknown) => run(),
}));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEnv>()),
  usesBetterAuthServer: async () => true,
}));
import { makeToolContext } from "@/server/mcp/tools/tool-test-support";
import { contentTools } from "./samContentTools";

beforeEach(testDb.seedProject);
afterAll(testDb.close);

it("exposes the nine shared tools without a model-supplied project ID or decision tool", () => {
  const tools = contentTools(makeToolContext(), "project");
  expect(sortBy(Object.keys(tools), (name) => name)).toEqual([
    "archive_content",
    "capture_content_source",
    "create_content_brief",
    "export_content_revision",
    "get_content_review",
    "get_content_revision",
    "list_content",
    "request_content_review",
    "save_content_revision",
  ]);
  for (const tool of Object.values(tools)) {
    expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
    if (!(tool.inputSchema instanceof z.ZodObject))
      throw new Error("Expected object schema");
    expect(tool.inputSchema.shape).not.toHaveProperty("projectId");
  }
});

it("binds the chat project even if the model supplies a different one", async () => {
  const context = makeToolContext({
    userId: "user",
    organizationId: "organization",
    role: "owner",
    clientId: null,
  });
  const tool = contentTools(context, "project").capture_content_source;
  const result: unknown = await tool.execute?.(
    {
      projectId: "foreign-project",
      mutationId: "sam-capture",
      source: {
        kind: "pasted",
        title: "Source",
        attribution: "Owner",
        text: "evidence",
        publisherDate: null,
        language: null,
        market: null,
      },
    },
    { toolCallId: "capture", messages: [] },
  );
  expect(result).toMatchObject({ data: { source: { projectId: "project" } } });
});

it("records a SAM-authored brief under the bound project", async () => {
  const context = makeToolContext({
    userId: "user",
    organizationId: "organization",
    role: "owner",
    clientId: null,
  });
  const tool = contentTools(context, "project").create_content_brief;
  const result: unknown = await tool.execute?.(
    {
      mutationId: "sam-brief",
      expectedHeadVersion: 0,
      brief: {
        target: "",
        objective: "",
        audience: "",
        outputKind: "article",
        topic: "Example",
        locale: { language: "en", country: "US" },
      },
    },
    { toolCallId: "brief", messages: [] },
  );
  expect(result).toMatchObject({ data: { ok: true, headVersion: 1 } });
  expect(
    await testDb.execute("SELECT surface, project_id FROM content_revisions"),
  ).toMatchObject([{ surface: "sam", project_id: "project" }]);
});
