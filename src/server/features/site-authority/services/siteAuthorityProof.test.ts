import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthorityProofDetails, type ProofTarget } from "./authorityProof";
import { checkHttpAuthorityProof } from "./httpAuthorityProof";
import { getWorkersEnv } from "@/server/lib/runtime-env";
import type * as RuntimeEnv from "@/server/lib/runtime-env";

// Model the runtime boundary explicitly: celld exposes Workers bindings too.
vi.mock("@/server/lib/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEnv>()),
  getWorkersEnv: vi.fn(async () => null),
}));

const target: ProofTarget = {
  id: "ac835a4c-2213-4814-abff-c8fef1821958",
  origin: "https://shop.example.com",
  nonce: "x".repeat(43),
};
const { value, ...details } = getAuthorityProofDetails(target);
const gateway = "https://gateway.example/fetch";
const encoder = new TextEncoder();
const signal = () => new AbortController().signal;
const now = 1_793_621_400_000;
const answer = (data: string, overrides: Record<string, unknown> = {}) => ({
  name: details.dnsName + ".",
  type: 16,
  TTL: 60,
  data,
  ...overrides,
});
const dnsBody = (url: URL, answers: unknown[] = [], status = 0) => ({
  Status: status,
  Question: [
    {
      name: url.searchParams.get("name") + ".",
      type: { A: 1, AAAA: 28, TXT: 16 }[url.searchParams.get("type") ?? ""],
    },
  ],
  Answer: answers,
});

function routeNetwork(
  http: () => Response | Promise<Response>,
  dns?: (url: URL) => Response | Promise<Response>,
) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.hostname === "cloudflare-dns.com"
      ? dns
        ? dns(url)
        : Response.json(dnsBody(url))
      : http();
  });
}
const gatewayCalls = () =>
  vi.mocked(fetch).mock.calls.filter(([input]) => input === gateway);

beforeEach(() => {
  vi.mocked(getWorkersEnv).mockResolvedValue(null);
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("CRAWL_GATEWAY_URL", gateway);
  vi.stubEnv("CRAWL_GATEWAY_SECRET", "fixture-gateway-key");
  vi.spyOn(Date, "now").mockReturnValue(now);
  routeNetwork(() => new Response(value));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("HTTPS authority proof", () => {
  it.each(["", "\n", "\r\n"])(
    "matches only the exact stored origin and value with optional single line ending %j",
    async (ending) => {
      routeNetwork(
        () =>
          new Response(value + ending, {
            headers: { "content-type": "application/octet-stream" },
          }),
      );
      const digest = await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(value),
      );
      await expect(checkHttpAuthorityProof(target, signal())).resolves.toEqual({
        matched: true,
        observedAtMs: now,
        httpStatus: 200,
        evidenceSha256: Buffer.from(digest).toString("hex"),
      });
      const [, init] = gatewayCalls()[0];
      const headers = new Headers(init?.headers);
      expect(headers.get("x-crawl-url")).toBe(details.httpUrl);
      expect(headers.get("accept")).toBe("text/plain");
      expect(headers.get("user-agent")).toBe("SEO-Pilot-Site-Verification/1.0");
      expect(headers.has("authorization") || headers.has("cookie")).toBe(false);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
      });
      expect(gatewayCalls()).toHaveLength(1);
    },
  );

  it.each(["\n\n", "\r", " ", "\t", "\r\n\r\n"])(
    "rejects extra whitespace %j",
    async (ending) => {
      routeNetwork(() => new Response(value + ending));
      await expect(
        checkHttpAuthorityProof(target, signal()),
      ).resolves.toMatchObject({ matched: false, failure: "mismatch" });
    },
  );

  it.each([
    "\uFEFF" + value,
    `<html>${value}</html>`,
    value.replace(target.nonce, "y".repeat(43)),
    "",
    "prefix" + value,
  ])("rejects transformed or stale proof %j", async (body) => {
    routeNetwork(() => new Response(body));
    await expect(
      checkHttpAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "mismatch" });
  });

  it.each([301, 302, 303, 307, 308, 304])(
    "rejects 3xx %s without following",
    async (status) => {
      const cancel = vi.fn();
      routeNetwork(
        () =>
          new Response(status === 304 ? null : new ReadableStream({ cancel }), {
            status,
            headers: { location: "http://127.0.0.1/private" },
          }),
      );
      await expect(
        checkHttpAuthorityProof(target, signal()),
      ).resolves.toMatchObject({
        matched: false,
        failure: "redirect",
        httpStatus: status,
      });
      expect(gatewayCalls()).toHaveLength(1);
      if (status !== 304) expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([206, 401, 403, 404, 410, 500])(
    "refuses non-200 status %s",
    async (status) => {
      routeNetwork(() => new Response(value, { status }));
      await expect(
        checkHttpAuthorityProof(target, signal()),
      ).resolves.toMatchObject({
        matched: false,
        httpStatus: status,
        failure:
          status === 404 || status === 410 ? "not_found" : "invalid_response",
      });
    },
  );

  it.each([
    "http://shop.example.com",
    "https://shop.example.com/",
    "https://shop.example.com:444",
    "https://shop.example.com/path",
    "https://user:pass@shop.example.com",
    "https://shop.example.com?q=x",
    "https://shop.example.com#x",
    "https://shop.example.com.",
    "https://127.0.0.1",
    "https://[::1]",
    "https://localhost",
    "https://x.internal",
    "https://*.example.com",
  ])("blocks stored origin %s", async (origin) => {
    await expect(
      checkHttpAuthorityProof({ ...target, origin }, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "blocked_target" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses mixed public/private DNS preflight answers", async () => {
    routeNetwork(
      () => new Response(value),
      (url) =>
        Response.json(
          dnsBody(url, [
            answer("93.184.216.34", { name: "shop.example.com.", type: 1 }),
            answer("10.0.0.1", { name: "shop.example.com.", type: 1 }),
          ]),
        ),
    );
    await expect(
      checkHttpAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "blocked_target" });
    expect(gatewayCalls()).toHaveLength(0);
  });

  it.each(["CRAWL_GATEWAY_URL", "CRAWL_GATEWAY_SECRET"])(
    "refuses missing %s without raw fetching the target",
    async (name) => {
      vi.stubEnv(name, "");
      await expect(
        checkHttpAuthorityProof(target, signal()),
      ).resolves.toMatchObject({ matched: false, failure: "unreachable" });
      expect(gatewayCalls()).toHaveLength(0);
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every(
            ([input]) =>
              typeof input === "string" &&
              input.startsWith("https://cloudflare-dns.com/"),
          ),
      ).toBe(true);
    },
  );

  it("reports network failure without retries", async () => {
    routeNetwork(() => {
      throw new TypeError("TLS failed");
    });
    await expect(
      checkHttpAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "unreachable" });
    expect(gatewayCalls()).toHaveLength(1);
  });

  it.each(["CRAWL_GATEWAY_URL", "CRAWL_GATEWAY_SECRET"])(
    "refuses celld proof without %s even with Workers bindings",
    async (name) => {
      vi.stubEnv("MODE", "standalone");
      vi.stubEnv(name, "");
      vi.mocked(getWorkersEnv).mockResolvedValue({});
      await expect(
        checkHttpAuthorityProof(target, signal()),
      ).resolves.toMatchObject({ matched: false, failure: "unreachable" });
      expect(gatewayCalls()).toHaveLength(0);
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every(
            ([input]) =>
              typeof input === "string" &&
              input.startsWith("https://cloudflare-dns.com/"),
          ),
      ).toBe(true);
    },
  );

  it("retains strictly-public Workers fetch without a standalone gateway", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubEnv("CRAWL_GATEWAY_URL", "");
    vi.mocked(getWorkersEnv).mockResolvedValue({});
    await expect(
      checkHttpAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: true });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => input === details.httpUrl),
    ).toHaveLength(1);
  });

  it("caps decoded streamed bytes independently of absent or lying Content-Length", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(value));
          controller.enqueue(new Uint8Array(1025));
        },
        cancel,
      }),
      { headers: { "content-length": "1", "content-encoding": "gzip" } },
    );
    routeNetwork(() => response);
    await expect(
      checkHttpAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "body_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("aborts slow streamed bodies at the total deadline and releases the reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(value));
        },
        cancel,
      }),
    );
    routeNetwork(() => response);
    const result = checkHttpAuthorityProof(target, signal());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toMatchObject({
      matched: false,
      failure: "timeout",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(gatewayCalls()[0][1]?.signal?.aborted).toBe(true);
  });

  it("bounds stalled headers and cancels late fetch results", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    routeNetwork(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const result = checkHttpAuthorityProof(target, signal());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toMatchObject({
      matched: false,
      failure: "timeout",
    });
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not start a late proof fetch after cancellation during URL preflight", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    routeNetwork(
      () => new Response(value),
      () => new Promise(() => {}),
    );
    const result = checkHttpAuthorityProof(target, controller.signal);
    controller.abort();
    await expect(result).resolves.toMatchObject({
      matched: false,
      failure: "timeout",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("includes resolver time in the total budget while retaining fail-open preflight", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    routeNetwork(
      () => new Response(new ReadableStream({ cancel })),
      () => new Promise(() => {}),
    );
    const result = checkHttpAuthorityProof(target, signal());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({
      matched: false,
      failure: "timeout",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
