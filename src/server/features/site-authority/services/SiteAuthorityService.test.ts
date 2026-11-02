import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Migrations/provider must be ready before the statically imported service's DB handle.
const { testDb } = await vi.hoisted(async () => {
  const { createSiteAuthorityTestDb } = await import("../siteAuthorityTestDb");
  return { testDb: await createSiteAuthorityTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: testDb.provider },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
import { SiteAuthorityService as service } from "./SiteAuthorityService";
import type { ProofMethod } from "@/types/schemas/siteAuthority";

const projectId = "10000000-0000-4000-8000-000000000001";
const foreignId = "20000000-0000-4000-8000-000000000002";
const actor = { userId: "user", organizationId: "organization", role: "owner" };
const origin = "https://shop.example.com";
const issueInput = {
  projectId,
  origin,
  method: "http_file" as const,
  expectedVersion: 0,
};
const gateway = "https://gateway.example/fetch";
let now = 1_800_000_000_000;
let proof = "";

function network(
  http: () => Response | Promise<Response> = () => new Response(proof),
) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "cloudflare-dns.com") return http();
    const type = url.searchParams.get("type");
    const name = url.searchParams.get("name");
    const recordType = type === "TXT" ? 16 : type === "AAAA" ? 28 : 1;
    return Response.json({
      Status: 0,
      Question: [{ name, type: recordType }],
      Answer:
        type === "AAAA"
          ? []
          : [
              {
                name,
                type: recordType,
                TTL: 60,
                data: type === "TXT" ? JSON.stringify(proof) : "93.184.216.34",
              },
            ],
    });
  });
}

async function issue(
  method: ProofMethod = "http_file",
  expectedVersion = 0,
  selectedOrigin = origin,
) {
  const result = await service.issue(actor, {
    projectId,
    origin: selectedOrigin,
    method,
    expectedVersion,
  });
  if (!result.ok || !result.authority.challenge || !result.instructions)
    throw new Error("Challenge not issued");
  proof =
    result.instructions.method === "http_file"
      ? result.instructions.content
      : result.instructions.value;
  return {
    projectId,
    challengeId: result.authority.challenge.id,
    expectedVersion: result.authority.version,
  };
}

beforeEach(async () => {
  await testDb.seedProject();
  await testDb.executeMultiple(`UPDATE projects SET id='${projectId}' WHERE id='project';
    UPDATE projects SET id='${foreignId}' WHERE id='foreign-project';`);
  now = 1_800_000_000_000;
  proof = "";
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("AUTH_MODE", "password");
  vi.stubEnv("CRAWL_GATEWAY_URL", gateway);
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-gateway-key");
  network();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(testDb.close);

describe(`public site authority service (${testDb.provider})`, () => {
  it.each(["http_file", "dns_txt"] as const)(
    "verifies %s through SQL and real proof transport, replaying without extending the lease",
    async (method) => {
      const input = await issue(method);
      const result = await service.check(actor, input);
      expect(result).toMatchObject({
        ok: true,
        authority: {
          projectId,
          origin,
          version: 1,
          status: "verified",
          verifiedMethod: method,
          verifiedAtMs: now,
          verifiedUntilMs: now + 30 * 86400_000,
        },
      });
      const calls = vi.mocked(fetch).mock.calls.length;
      now += 60_000;
      expect(await service.check(actor, input)).toMatchObject({
        ok: true,
        authority: {
          verifiedAtMs: now - 60_000,
          verifiedUntilMs: now - 60_000 + 30 * 86400_000,
        },
      });
      expect(fetch).toHaveBeenCalledTimes(calls);
      expect(
        await service.requireVerifiedOrigin(actor, {
          projectId,
          targetUrl: `${origin}/posts?draft=1`,
          expectedVersion: 1,
        }),
      ).toMatchObject({ origin, version: 1, method });
      for (const [targetUrl, code] of [
        ["https://example.com/post", "FORBIDDEN"],
        ["https://www.shop.example.com", "FORBIDDEN"],
        ["https://shop.example.com:8443", "VALIDATION_ERROR"],
        ["http://shop.example.com", "VALIDATION_ERROR"],
        ["https://u:p@shop.example.com", "VALIDATION_ERROR"],
      ]) {
        await expect(
          service.requireVerifiedOrigin(actor, {
            projectId,
            targetUrl,
            expectedVersion: 1,
          }),
        ).rejects.toMatchObject({
          code,
        });
      }
      await expect(
        service.requireVerifiedOrigin(actor, {
          projectId,
          targetUrl: origin,
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      now = result.authority.verifiedUntilMs!;
      expect((await service.get(actor, { projectId })).authority.status).toBe(
        "expired",
      );
      await expect(
        service.requireVerifiedOrigin(actor, {
          projectId,
          targetUrl: origin,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("reveals no foreign project/challenge and performs no foreign fetch or write", async () => {
    const input = await issue();
    await expect(
      service.get(actor, { projectId: foreignId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.check(actor, { ...input, projectId: foreignId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.issue(actor, {
        ...issueInput,
        projectId: foreignId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await service.check(actor, {
        ...input,
        challengeId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: false, code: "stale" });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await testDb.execute("SELECT * FROM site_authority_challenges"),
    ).toHaveLength(1);
  });

  it.each([
    "http://example.com",
    "example.com",
    "https://u:p@example.com",
    "https://example.com/path",
    "https://example.com?q=x",
    "https://example.com#x",
    "https://example.com?",
    "https://example.com#",
    "https://example.com:444",
    "https://example.com.",
    "https://*.example.com",
    "https://127.0.0.1",
    "https://localhost",
  ])("rejects invalid origin %s before issue", async (selectedOrigin) => {
    await expect(
      service.issue(actor, {
        ...issueInput,
        origin: selectedOrigin,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      await testDb.execute("SELECT * FROM site_authority_challenges"),
    ).toHaveLength(0);
  });

  it("normalizes only URL origin semantics and rejects caller identity/TTL fields", async () => {
    const result = await service.issue(actor, {
      ...issueInput,
      origin: "https://SHOP.Example.com:443/",
    });
    expect(result.authority.origin).toBe(origin);
    const forged = {
      ...issueInput,
      expectedVersion: 1,
      organizationId: "foreign",
      role: "owner",
      ttl: 99,
    };
    await expect(service.issue(actor, forged)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("refuses a DNS owner exceeding the DNS name bound while accepting the same valid HTTP origin", async () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(40)}.com`;
    await expect(
      service.issue(actor, {
        ...issueInput,
        origin: `https://${host}`,
        method: "dns_txt",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      (
        await service.issue(actor, {
          ...issueInput,
          origin: `https://${host}`,
        })
      ).ok,
    ).toBe(true);
  });

  it("reports missing proof truthfully, rate-limits retries and exhausts the fifth failed check", async () => {
    const input = await issue();
    network(() => new Response("missing", { status: 404 }));
    expect(await service.check(actor, input)).toMatchObject({
      ok: true,
      authority: {
        status: "pending",
        challenge: { attemptsUsed: 1, lastFailure: "not_found" },
      },
    });
    expect(await service.check(actor, input)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    for (let attempt = 2; attempt <= 5; attempt++) {
      now += 10_000;
      await service.check(actor, input);
    }
    expect(await service.check(actor, input)).toMatchObject({
      ok: false,
      code: "exhausted",
      authority: { status: "unverified" },
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === gateway),
    ).toHaveLength(5);
  });

  it("does one lookup for simultaneous duplicate checks and cannot complete over a revoke", async () => {
    const input = await issue();
    let release!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    network(() => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const checking = service.check(actor, input);
    await ready;
    expect(await service.check(actor, input)).toMatchObject({
      ok: false,
      code: "busy",
    });
    expect(
      await service.revoke(actor, { projectId, expectedVersion: 1 }),
    ).toMatchObject({ ok: true, authority: { status: "revoked", version: 2 } });
    release(new Response(proof));
    expect(await checking).toMatchObject({
      ok: false,
      code: "stale",
      authority: { status: "revoked", version: 2 },
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === gateway),
    ).toHaveLength(1);
  });

  it.each(["DELETE FROM member", "UPDATE member SET role='member'"])(
    "reauthorizes after a held lookup: %s",
    async (change) => {
      const input = await issue();
      let release!: (response: Response) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      network(() => {
        started();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
      const checking = service.check(actor, input);
      await ready;
      await testDb.execute(change);
      release(new Response(proof));
      await expect(checking).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        await testDb.execute("SELECT status FROM project_site_authority"),
      ).toMatchObject([{ status: "pending" }]);
    },
  );

  it("suspends a verified grant immediately on explicit reissue and fences the old challenge", async () => {
    const input = await issue();
    await service.check(actor, input);
    now += 60_000;
    await issue("dns_txt", 1, "https://www.example.com");
    await expect(
      service.requireVerifiedOrigin(actor, {
        projectId,
        targetUrl: origin,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(await service.check(actor, input)).toMatchObject({
      ok: false,
      code: "stale",
      authority: {
        status: "pending",
        version: 2,
        origin: "https://www.example.com",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("returns stale for an old held claim when a reclaimed claim has verified with the same observation time", async () => {
    const input = await issue();
    let release!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let lookups = 0;
    network(() => {
      if (++lookups > 1) return new Response(proof);
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const oldCheck = service.check(actor, input);
    await ready;
    now += 15_000;
    expect(await service.check(actor, input)).toMatchObject({
      ok: true,
      authority: { status: "verified", challenge: { attemptsUsed: 2 } },
    });
    release(new Response(proof));
    expect(await oldCheck).toMatchObject({
      ok: false,
      code: "stale",
      authority: { status: "verified", challenge: { attemptsUsed: 2 } },
    });
    expect(lookups).toBe(2);
  });
});
