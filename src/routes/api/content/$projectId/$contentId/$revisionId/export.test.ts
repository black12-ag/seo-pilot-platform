import { createHash } from "node:crypto";
import { sortBy } from "remeda";
import { z } from "zod";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
const { testDb, resolveIdentity } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } =
    await import("@/server/features/site-authority/siteAuthorityTestDb");
  return {
    testDb: await createSiteAuthorityTestDb(),
    resolveIdentity: vi.fn(),
  };
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
vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: resolveIdentity,
}));
import { ContentService } from "@/server/features/content/services/ContentService";
import { ContentSourceService } from "@/server/features/content/services/ContentSourceService";
import { AppError } from "@/server/lib/errors";
import { Route } from "./export";

const actor = {
  userId: "user",
  organizationId: "organization",
  role: "owner",
  surface: "web" as const,
};
beforeEach(async () => {
  await testDb.seedProject();
  resolveIdentity.mockResolvedValue(actor);
});
afterAll(testDb.close);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      sortBy(Object.entries(value), ([key]) => key).map(([key, item]) => [
        key,
        canonical(item),
      ]),
    );
  return value;
}

it("serves complete saved bytes with a scoped manifest and private attachment headers", async () => {
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
  const source = await ContentSourceService.capture(actor, {
    projectId: "project",
    mutationId: "source",
    source: {
      kind: "pasted",
      title: "Source",
      attribution: "Owner",
      text: "ሰላም evidence",
      publisherDate: null,
      language: null,
      market: null,
    },
  });
  const saved = await ContentService.saveRevision(actor, {
    projectId: "project",
    contentId: created.revision.contentId,
    mutationId: "save",
    expectedHeadVersion: 1,
    expectedContextVersion: created.revision.contextVersion,
    brief: created.revision.brief,
    markdown: "# ሰላም",
    metadata: { ...created.revision.metadata, title: "Saved title" },
    sourceIds: [source.source.id],
    claims: [],
    openQuestions: [],
    omissions: [],
  });
  if (!saved.ok) throw new Error("Revision was not saved");
  const handlers = Route.options.server?.handlers;
  if (typeof handlers !== "object" || typeof handlers.GET !== "function")
    throw new Error("Missing export handler");
  const params = {
    projectId: "project",
    contentId: saved.revision.contentId,
    revisionId: saved.revision.id,
  };
  const response = await handlers.GET({
    request: new Request("http://localhost/export?format=json"),
    params,
    context: undefined,
    pathname: "/api/content/$projectId/$contentId/$revisionId/export",
    next: () => {
      throw new Error("Unexpected delegation");
    },
  });
  if (!(response instanceof Response)) throw new Error("Expected response");
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-disposition")).toMatch(
    /^attachment; filename="[a-zA-Z0-9_.-]+\.json"$/,
  );
  expect(response.headers.get("x-content-sha256")).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(Number(response.headers.get("x-content-bytes"))).toBe(bytes.length);
  const data = z
    .object({ payload: z.unknown(), manifest: z.unknown() })
    .parse(JSON.parse(bytes.toString("utf8")));
  expect(data.payload).toMatchObject({
    revision: {
      id: saved.revision.id,
      markdown: "# ሰላም",
      metadata: { title: "Saved title" },
    },
    sources: [{ id: source.source.id, sourceText: "ሰላም evidence" }],
  });
  const canonicalBytes = Buffer.from(JSON.stringify(canonical(data.payload)));
  expect(data.manifest).toMatchObject({
    scope: "canonical-json-payload-v1",
    payloadBytes: canonicalBytes.length,
    payloadSha256: createHash("sha256").update(canonicalBytes).digest("hex"),
  });
  resolveIdentity.mockRejectedValue(new AppError("UNAUTHENTICATED"));
  const denied = await handlers.GET({
    request: new Request("http://localhost/export?format=json"),
    params,
    context: undefined,
    pathname: "/api/content/$projectId/$contentId/$revisionId/export",
    next: () => {
      throw new Error("Unexpected delegation");
    },
  });
  if (!(denied instanceof Response)) throw new Error("Expected response");
  expect(denied.status).toBe(401);
  expect(denied.headers.get("cache-control")).toBe("private, no-store");
});
