import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "@/server/lib/errors";
import {
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
  isShopifyHost,
} from "@/server/lib/audit/url-policy";

describe("normalizeAndValidateStartUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds https when protocol is missing and strips hash", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ Status: 0, Answer: [] }), {
        status: 200,
        headers: { "content-type": "application/dns-json" },
      }),
    );

    await expect(
      normalizeAndValidateStartUrl("example.com/path#section"),
    ).resolves.toBe("https://example.com/path");
  });

  it.each(["http://localhost:3000", "http://192.168.0.10"])(
    "blocks %s",
    async (url) => {
      await expect(normalizeAndValidateStartUrl(url)).rejects.toMatchObject({
        code: "CRAWL_TARGET_BLOCKED",
      } satisfies Partial<AppError>);
    },
  );

  it.each(["10.0.0.1", "::1", "::ffff:7f00:1"])(
    "blocks private DNS answer %s after bounded resolver extraction",
    async (data) => {
      vi.mocked(fetch).mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const type = url.searchParams.get("type") === "A" ? 1 : 28;
        return Response.json({
          Status: 0,
          Question: [{ name: "example.com.", type }],
          Answer: [{ name: "example.com.", type, TTL: 30, data }],
        });
      });
      await expect(
        normalizeAndValidateStartUrl("https://example.com"),
      ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
    },
  );

  it("keeps resolver transport and format failures fail-open for crawl preflight", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("resolver unavailable"));
    await expect(normalizeAndValidateStartUrl("example.com")).resolves.toBe(
      "https://example.com/",
    );
    vi.mocked(fetch).mockImplementation(async () => new Response("malformed"));
    await expect(normalizeAndValidateStartUrl("example.com")).resolves.toBe(
      "https://example.com/",
    );
  });

  it("still identifies Shopify from an A record", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({
        Status: 0,
        Question: [{ name: "example.com.", type: 1 }],
        Answer: [
          { name: "example.com.", type: 1, TTL: 60, data: "23.227.38.65" },
        ],
      }),
    );
    await expect(isShopifyHost("example.com")).resolves.toBe(true);
  });
});

const dnsOk = () =>
  new Response(JSON.stringify({ Status: 0, Answer: [] }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
const redirect = (location: string) =>
  new Response(null, { status: 301, headers: { location } });

describe("resolveStartUrlRedirects", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Route probe fetches by URL; DoH lookups always resolve clean. */
  function stubFetch(routes: Record<string, () => Response>) {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("dns-query")) return Promise.resolve(dnsOk());
      const route = routes[url];
      return route
        ? Promise.resolve(route())
        : Promise.resolve(new Response(null, { status: 200 }));
    });
  }

  it("follows a cross-domain redirect to the real origin", async () => {
    stubFetch({
      "https://example.net/": () => redirect("https://example.com/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.net/"),
    ).resolves.toMatchObject({ url: "https://example.com/" });
  });

  it("returns the last URL when the probe fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).resolves.toMatchObject({ url: "https://example.com/" });
  });

  it("stops after the hop limit on a redirect loop", async () => {
    stubFetch({
      "https://a.example/": () => redirect("https://b.example/"),
      "https://b.example/": () => redirect("https://a.example/"),
    });
    const resolved = await resolveStartUrlRedirects("https://a.example/");
    expect(resolved.url).toMatch(/^https:\/\/(a|b)\.example\/$/);
  });

  it("rejects redirects into blocked targets", async () => {
    stubFetch({
      "https://example.com/": () => redirect("http://192.168.0.10/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<AppError>);
  });
});
