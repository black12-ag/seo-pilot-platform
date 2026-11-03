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

const actor = {
  userId: "user",
  organizationId: "organization",
  role: "owner",
  surface: "web",
} as const;
const requests = [
  { mutationId: "one", url: "https://example.com/one" },
  { mutationId: "two", url: "https://example.com/two" },
];
const gateway = "https://gateway.example/fetch";
beforeEach(async () => {
  await testDb.seedProject();
  vi.stubEnv("CRAWL_GATEWAY_URL", gateway);
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const parsed = new URL(input instanceof Request ? input.url : input);
      if (parsed.hostname === "cloudflare-dns.com")
        return Response.json({ Status: 0, Answer: [] });
      return new Response(`<main>${"source text ".repeat(30)}</main>`, {
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

it("persists provenance, replays independent IDs in any order, and rejects conflicts without fetching", async () => {
  const first = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests,
  });
  expect(first.outcomes.map((o) => o.state)).toEqual(["captured", "captured"]);
  const calls = vi.mocked(fetch).mock.calls.length;
  const replay = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [requests[1], requests[0]],
  });
  expect(replay.outcomes.map((o) => o.sourceId)).toEqual([
    first.outcomes[1].sourceId,
    first.outcomes[0].sourceId,
  ]);
  expect(replay.outcomes.every((o) => o.replayed)).toBe(true);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
  await expect(
    ContentSourceService.captureUrls(actor, {
      projectId: "project",
      requests: [{ ...requests[0], url: "https://example.com/changed" }],
    }),
  ).rejects.toThrow("conflict");
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
  const source = await ContentSourceService.get(
    actor,
    "project",
    first.outcomes[0].sourceId,
  );
  expect(source.urlCapture).toMatchObject({
    requestedUrl: requests[0].url,
    responseComplete: true,
  });
  expect(source.sourceText).toContain("source text");
  expect(
    await testDb.execute("select source_id from content_source_url_captures"),
  ).toHaveLength(2);
});
it("persists mixed usable and blocked outcomes in request order", async () => {
  const result = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [
      requests[0],
      { mutationId: "private", url: "http://127.0.0.1/" },
    ],
  });
  expect(result.outcomes).toMatchObject([
    {
      mutationId: "one",
      state: "captured",
      extractionStatus: "usable",
      available: true,
    },
    {
      mutationId: "private",
      state: "captured",
      extractionStatus: "blocked",
      available: false,
    },
  ]);
  expect(
    await testDb.execute("select source_id from content_source_url_captures"),
  ).toHaveLength(2);
});
it("retains a long URL in provenance with bounded attribution", async () => {
  const url = `https://example.com/?query=${"x".repeat(1000)}`;
  const result = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [{ mutationId: "long", url }],
  });
  const source = await ContentSourceService.get(
    actor,
    "project",
    result.outcomes[0].sourceId,
  );
  expect(source.attribution).toBe("example.com");
  expect(source.urlCapture?.requestedUrl).toBe(url);
});
it("persists a blocked outcome and prevents it from being read as evidence", async () => {
  const result = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [{ mutationId: "private", url: "http://127.0.0.1/" }],
  });
  expect(result.outcomes[0]).toMatchObject({
    state: "captured",
    available: false,
    extractionStatus: "blocked",
  });
  await expect(
    ContentSourceService.get(actor, "project", result.outcomes[0].sourceId),
  ).rejects.toThrow("source_unavailable");
});
it("rejects malformed batches before fetching or writing", async () => {
  await expect(
    ContentSourceService.captureUrls(actor, {
      projectId: "project",
      requests: [
        requests[0],
        { mutationId: "one", url: "https://example.com/other" },
      ],
    }),
  ).rejects.toThrow();
  await expect(
    ContentSourceService.captureUrls(actor, {
      projectId: "project",
      requests: [{ mutationId: "x", url: "https://example.com/\n" }],
    }),
  ).rejects.toThrow();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(await testDb.execute("select id from content_mutations")).toHaveLength(
    0,
  );
});
it("rechecks membership after the external fetch", async () => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const parsed = new URL(input instanceof Request ? input.url : input);
    if (parsed.hostname === "cloudflare-dns.com")
      return Response.json({ Status: 0, Answer: [] });
    await testDb.execute("delete from member where id = 'membership'");
    return new Response(`<main>${"source text ".repeat(30)}</main>`, {
      headers: { "content-type": "text/html" },
    });
  });
  await expect(
    ContentSourceService.captureUrls(actor, {
      projectId: "project",
      requests: [requests[0]],
    }),
  ).rejects.toThrow();
  expect(await testDb.execute("select id from content_mutations")).toHaveLength(
    0,
  );
});
it("admits one receipt for concurrent identical requests", async () => {
  const input = { projectId: "project", requests: [requests[0]] };
  const results = await Promise.all([
    ContentSourceService.captureUrls(actor, input),
    ContentSourceService.captureUrls(actor, input),
  ]);
  expect(results[0].outcomes[0].sourceId).toBe(results[1].outcomes[0].sourceId);
  expect(results.filter((result) => result.outcomes[0].replayed)).toHaveLength(
    1,
  );
  expect(
    await testDb.execute("select source_id from content_source_url_captures"),
  ).toHaveLength(1);
});
it("rejects an archived project during admission without orphaning a receipt", async () => {
  testDb.beforeNextBatch(async () => {
    await testDb.execute(
      `UPDATE projects SET archived_at = ${testDb.provider === "postgres" ? "now()" : "1"} WHERE id = 'project'`,
    );
  });
  await expect(
    ContentSourceService.captureUrls(actor, {
      projectId: "project",
      requests: [requests[0]],
    }),
  ).rejects.toThrow();
  expect(await testDb.execute("select id from content_mutations")).toHaveLength(
    0,
  );
  expect(
    await testDb.execute("select source_id from content_source_url_captures"),
  ).toHaveLength(0);
});
it("rolls back a failed batch and permits a retry", async () => {
  testDb.failNextBatchAt(4);
  await expect(
    ContentSourceService.captureUrls(actor, {
      projectId: "project",
      requests: [requests[0]],
    }),
  ).rejects.toThrow();
  expect(await testDb.execute("select id from content_mutations")).toHaveLength(
    0,
  );
  expect(
    await testDb.execute("select source_id from content_source_url_captures"),
  ).toHaveLength(0);
  const retry = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [requests[0]],
  });
  expect(retry.outcomes[0]).toMatchObject({
    state: "captured",
    replayed: false,
  });
});
it("fails closed when membership is removed during capture admission", async () => {
  testDb.mutateMembershipInNextBatchAt(3, null);
  await expect(
    ContentSourceService.captureUrls(actor, {
      projectId: "project",
      requests: [requests[0]],
    }),
  ).rejects.toThrow();
  expect(await testDb.execute("select id from content_mutations")).toHaveLength(
    0,
  );
  expect(
    await testDb.execute("select source_id from content_source_url_captures"),
  ).toHaveLength(0);
});
it("does not refetch or resurrect a privacy-erased receipt even with a changed URL", async () => {
  const first = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [requests[0]],
  });
  const id = first.outcomes[0].sourceId;
  await testDb.executeMultiple(
    `DELETE FROM content_source_url_captures WHERE source_id = '${id}'; UPDATE content_sources SET source_text = '', attribution = '', title = '', text_hash = '', extraction_status = 'erased' WHERE id = '${id}'; UPDATE content_mutations SET request_hash = '' WHERE result_id = '${id}';`,
  );
  const calls = vi.mocked(fetch).mock.calls.length;
  const replay = await ContentSourceService.captureUrls(actor, {
    projectId: "project",
    requests: [{ ...requests[0], url: "https://example.com/changed" }],
  });
  expect(replay.outcomes[0]).toEqual({
    state: "unavailable",
    mutationId: "one",
    sourceId: id,
    replayed: true,
    reason: "privacy_erased",
  });
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
});
