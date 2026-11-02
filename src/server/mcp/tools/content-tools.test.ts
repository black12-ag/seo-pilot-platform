import {
  getContentRevisionTool,
  exportContentRevisionTool,
} from "@/server/mcp/tools/content-read-tools";
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
vi.mock("@/db", () => ({
  db: testDb.db,
  withPgClient: (run: () => unknown) => run(),
}));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  usesBetterAuthServer: async () => true,
}));
import {
  captureContentSourceTool,
  createContentBriefTool,
  listContentTool,
} from "./content-tools";
import { makeToolContext } from "./tool-test-support";
import { ContentService } from "@/server/features/content/services/ContentService";

beforeEach(testDb.seedProject);
afterAll(testDb.close);

it("captures project-scoped source without exposing the source text in tool output", async () => {
  const context = makeToolContext({
    userId: "user",
    organizationId: "organization",
    role: "owner",
  });
  const input = {
    projectId: "project",
    mutationId: "tool-capture",
    source: {
      kind: "pasted" as const,
      title: "Source",
      attribution: "Owner",
      text: "private evidence",
      publisherDate: null,
      language: null,
      market: null,
    },
  };
  const result = await captureContentSourceTool("mcp").handler(input, context);
  expect(result.structuredContent).toMatchObject({
    source: { title: "Source", extractionStatus: "usable" },
    replayed: false,
  });
  expect(JSON.stringify(result)).not.toContain("private evidence");
  await expect(
    captureContentSourceTool("mcp").handler(
      { ...input, projectId: "foreign-project" },
      context,
    ),
  ).rejects.toThrow();
});

it("lists saved content for the authorized project with recorded workflow state", async () => {
  const context = makeToolContext({
    userId: "user",
    organizationId: "organization",
    role: "owner",
  });
  await createContentBriefTool("mcp").handler(
    {
      projectId: "project",
      mutationId: "list-brief",
      expectedHeadVersion: 0,
      brief: {
        target: "",
        objective: "",
        audience: "",
        outputKind: "article",
        topic: "Tea",
        locale: { language: "am", country: "ET" },
      },
    },
    context,
  );
  const result = await listContentTool("mcp").handler(
    { projectId: "project" },
    context,
  );
  expect(result.structuredContent).toMatchObject({
    items: [{ topic: "Tea", state: "brief" }],
    nextCursor: null,
  });
});

it("marks bounded revision and export previews incomplete and links to the authenticated download", async () => {
  const actor = {
    userId: "user",
    organizationId: "organization",
    role: "owner",
    surface: "mcp" as const,
  };
  const context = makeToolContext(actor);
  const created = await ContentService.createBrief(actor, {
    projectId: "project",
    mutationId: "preview-brief",
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
  const saved = await ContentService.saveRevision(actor, {
    projectId: "project",
    contentId: created.revision.contentId,
    mutationId: "preview-save",
    expectedHeadVersion: 1,
    expectedContextVersion: created.revision.contextVersion,
    brief: created.revision.brief,
    markdown: "x".repeat(2101),
    metadata: created.revision.metadata,
    sourceIds: [],
    claims: [],
    openQuestions: [],
    omissions: [],
  });
  if (!saved.ok) throw new Error("Revision was not saved");
  const ids = {
    projectId: "project",
    contentId: saved.revision.contentId,
    revisionId: saved.revision.id,
  };
  const revision = await getContentRevisionTool("mcp").handler(ids, context);
  expect(revision.structuredContent).toMatchObject({
    complete: false,
    truncated: true,
    bodyTruncated: true,
  });
  expect(
    z.object({ downloadUrl: z.string() }).parse(revision.structuredContent)
      .downloadUrl,
  ).toContain("/api/content/");
  const exported = await exportContentRevisionTool("mcp").handler(
    { ...ids, format: "json" },
    context,
  );
  expect(exported.structuredContent).toMatchObject({
    complete: false,
    truncated: true,
  });
  expect(
    z.object({ downloadUrl: z.string() }).parse(exported.structuredContent)
      .downloadUrl,
  ).toContain("format=json");
  await testDb.execute(
    `UPDATE content_revisions SET redacted_at_ms = 1 WHERE id = '${saved.revision.id}'`,
  );
  const erased = await getContentRevisionTool("mcp").handler(ids, context);
  expect(erased.structuredContent).toMatchObject({
    state: "privacy_erased",
    complete: false,
  });
  expect(erased.structuredContent).not.toHaveProperty("downloadUrl");
});
