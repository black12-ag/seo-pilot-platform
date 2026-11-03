import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as RuntimeEnv from "@/server/lib/runtime-env";
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
vi.mock("@/server/lib/runtime-env", async (original) => ({
  ...(await original<typeof RuntimeEnv>()),
  usesBetterAuthServer: async () => true,
  getWorkersEnv: async () => null,
}));
import { captureContentUrlsTool } from "./content-url-tools";
import { makeToolContext } from "./tool-test-support";
import { captureContentUrlsResultSchema } from "@/types/schemas/contentSourceIntake";

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
      return new Response(`<main>${"private source body ".repeat(20)}</main>`, {
        headers: { "content-type": "text/html" },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(testDb.close);

it("captures ordered outcomes without source text and declares outbound writes", async () => {
  const tool = captureContentUrlsTool("mcp");
  const context = makeToolContext({
    userId: "user",
    organizationId: "organization",
    role: "owner",
  });
  const input = {
    projectId: "project",
    requests: [
      { mutationId: "url-one", url: "https://example.com/" },
      { mutationId: "url-two", url: "http://127.0.0.1/" },
    ],
  };
  const result = await tool.handler(input, context);
  const output = captureContentUrlsResultSchema.parse(result.structuredContent);
  expect(output.outcomes).toMatchObject([
    { state: "captured", extractionStatus: "usable" },
    { state: "captured", extractionStatus: "blocked" },
  ]);
  const captured = output.outcomes[0];
  if (captured.state !== "captured")
    throw new Error("Expected captured outcome");
  const futureOutput = {
    futureRoot: true,
    outcomes: [
      {
        ...captured,
        futureOutcome: true,
        urlCapture: { ...captured.urlCapture, futureMetadata: true },
      },
      {
        state: "unavailable",
        mutationId: "erased",
        sourceId: "erased-source",
        replayed: true,
        reason: "privacy_erased",
        futureOutcome: true,
      },
    ],
  };
  expect(tool.config.outputSchema.parse(futureOutput)).toEqual(futureOutput);
  expect(captureContentUrlsResultSchema.safeParse(futureOutput).success).toBe(
    false,
  );
  expect(
    tool.config.inputSchema.safeParse({ ...input, futureRoot: true }).success,
  ).toBe(false);
  expect(
    tool.config.outputSchema.safeParse({ outcomes: Array(6).fill(captured) })
      .success,
  ).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private source body");
  expect(tool.config.annotations).toMatchObject({
    readOnlyHint: false,
    openWorldHint: true,
    idempotentHint: false,
  });
  await expect(
    tool.handler({ ...input, projectId: "foreign-project" }, context),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("allows a current member and rejects a removed membership despite stale credentials", async () => {
  await testDb.executeMultiple(
    "UPDATE member SET role = 'member' WHERE id = 'membership'",
  );
  const tool = captureContentUrlsTool("mcp");
  const context = makeToolContext({
    userId: "user",
    organizationId: "organization",
    role: "owner",
  });
  const input = {
    projectId: "project",
    requests: [{ mutationId: "member-url", url: "http://127.0.0.1/" }],
  };
  const result = await tool.handler(input, context);
  expect(result.structuredContent).toMatchObject({
    outcomes: [{ extractionStatus: "blocked" }],
  });
  await testDb.executeMultiple("DELETE FROM member WHERE id = 'membership'");
  await expect(
    tool.handler(
      {
        ...input,
        requests: [{ ...input.requests[0], mutationId: "removed-url" }],
      },
      context,
    ),
  ).rejects.toThrow();
});
