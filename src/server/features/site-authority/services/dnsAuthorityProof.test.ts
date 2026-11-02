import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthorityProofDetails, type ProofTarget } from "./authorityProof";
import { checkDnsAuthorityProof } from "./dnsAuthorityProof";

const target: ProofTarget = {
  id: "ac835a4c-2213-4814-abff-c8fef1821958",
  origin: "https://shop.example.com",
  nonce: "x".repeat(43),
};
const { value, ...details } = getAuthorityProofDetails(target);
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
function stubTxt(answers: unknown[], status = 0) {
  vi.mocked(fetch).mockImplementation(async () =>
    Response.json({
      Status: status,
      Question: [{ name: details.dnsName + ".", type: 16 }],
      Answer: answers,
    }),
  );
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DNS TXT authority proof", () => {
  it("concatenates character strings with decimal escapes, matches one RR and hashes the exact value", async () => {
    const split = `"${value.slice(0, 12)}" "${value.slice(12).replace("=", "\\061")}"`;
    stubTxt([
      answer('"unrelated"'),
      answer(split, { name: details.dnsName.toUpperCase() + "." }),
    ]);
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    await expect(checkDnsAuthorityProof(target, signal())).resolves.toEqual({
      matched: true,
      observedAtMs: now,
      httpStatus: null,
      evidenceSha256: Buffer.from(digest).toString("hex"),
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      `https://cloudflare-dns.com/dns-query?name=${details.dnsName}&type=TXT`,
    );
  });

  it("parses escaped ordinary characters", async () => {
    stubTxt([answer('"' + value.replace("=", "\\=") + '"')]);
    await expect(
      checkDnsAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: true });
  });

  it.each([
    [3, "dns_not_found"],
    [2, "dns_unavailable"],
    [5, "dns_unavailable"],
  ])("maps resolver status %s to %s", async (status, failure) => {
    stubTxt([], Number(status));
    await expect(
      checkDnsAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure });
  });

  it.each([
    { answers: [] },
    {
      answers: [
        answer('"' + value + '"', {
          name: "_seo-pilot-verification.example.com.",
        }),
      ],
    },
    { answers: [answer('"' + value + '"', { type: 1 })] },
  ])("requires the exact owner and TXT type: %j", async ({ answers }) => {
    stubTxt(answers);
    await expect(
      checkDnsAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "dns_not_found" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([5, 39])(
    "refuses alias type %s even alongside matching TXT",
    async (type) => {
      const name = type === 5 ? details.dnsName : "example.com.";
      stubTxt([
        answer("alias.example.com.", { type, name }),
        answer('"' + value + '"'),
      ]);
      await expect(
        checkDnsAuthorityProof(target, signal()),
      ).resolves.toMatchObject({ matched: false, failure: "invalid_response" });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("never joins independent records or accepts a stale challenge", async () => {
    stubTxt([
      answer('"' + value.slice(0, 40) + '"'),
      answer('"' + value.slice(40) + '"'),
      answer('"' + value.replace(target.nonce, "z".repeat(43)) + '"'),
    ]);
    await expect(
      checkDnsAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "mismatch" });
  });

  it.each([
    '"unterminated',
    "unquoted",
    '"one""two"',
    '"\\1"',
    '"\\999"',
    '"\\12x"',
    '"line\nfeed"',
    '"' + "x".repeat(256) + '"',
    Array(5)
      .fill('"' + "x".repeat(255) + '"')
      .join(" "),
  ])("fails closed on malformed or oversized TXT %j", async (data) => {
    stubTxt([answer(data)]);
    await expect(
      checkDnsAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "dns_unavailable" });
  });

  it("does not mistake escaped quotes or backslashes for record boundaries", async () => {
    stubTxt([answer('"' + value + '\\""'), answer('"' + value + '\\\\"')]);
    await expect(
      checkDnsAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "mismatch" });
  });

  it("fails closed on malformed DoH JSON", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{broken"));
    await expect(
      checkDnsAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "dns_unavailable" });
  });

  it("fails closed on oversized DoH bodies and answer arrays", async () => {
    stubTxt(Array(33).fill(answer('"' + value + '"')));
    await expect(
      checkDnsAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "dns_unavailable" });
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16_385));
          },
          cancel,
        }),
      ),
    );
    await expect(
      checkDnsAuthorityProof(target, signal()),
    ).resolves.toMatchObject({ matched: false, failure: "dns_unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out stalled DoH headers without retry", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const result = checkDnsAuthorityProof(target, signal());
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(result).resolves.toMatchObject({
      matched: false,
      failure: "dns_unavailable",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    "https://x.internal",
    `https://${[63, 63, 63, 61].map((n) => "x".repeat(n)).join(".")}`,
  ])(
    "refuses blocked hosts or overlong proof owner %s without requests",
    async (origin) => {
      await expect(
        checkDnsAuthorityProof({ ...target, origin }, signal()),
      ).resolves.toMatchObject({ matched: false, failure: "blocked_target" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
