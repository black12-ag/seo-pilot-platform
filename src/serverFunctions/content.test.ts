import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { z } from "zod";
import type * as RuntimeEnv from "@/server/lib/runtime-env";
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
vi.mock("@/server/lib/runtime-env", async (original) => ({
  ...(await original<typeof RuntimeEnv>()),
  usesBetterAuthServer: async () => true,
  getWorkersEnv: async () => null,
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
  captureContentUrls,
  createContentBrief,
  saveContentRevision,
} from "./content";

beforeEach(testDb.seedProject);
afterAll(testDb.close);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

it("captures URLs with verified web identity and rejects malformed and unauthorized requests", async () => {
  vi.stubEnv("CRAWL_GATEWAY_URL", "https://gateway.example/fetch");
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "cloudflare-dns.com")
        return Response.json({ Status: 0, Answer: [] });
      return new Response(`<main>${"source evidence ".repeat(30)}</main>`, {
        headers: { "content-type": "text/html" },
      });
    }),
  );
  const data = {
    projectId: "project",
    requests: [{ mutationId: "web-url", url: "https://example.com/" }],
  };
  const forged = { ...data, surface: "mcp" };
  await expect(captureContentUrls({ data: forged })).rejects.toThrow();
  await expect(
    captureContentUrls({ data: { ...data, requests: [] } }),
  ).rejects.toThrow();
  await expect(
    captureContentUrls({ data: { ...data, projectId: "foreign-project" } }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  const result = await captureContentUrls({ data });
  expect(result.outcomes).toMatchObject([
    { state: "captured", extractionStatus: "usable" },
  ]);
  expect(JSON.stringify(result)).not.toContain("source evidence");
  testDb.mutateMembershipInNextBatchAt(3, null);
  await expect(
    captureContentUrls({
      data: {
        ...data,
        requests: [{ mutationId: "removed", url: "https://example.com/other" }],
      },
    }),
  ).rejects.toThrow();
});
