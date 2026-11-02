import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePublicDnsRecords } from "./public-dns";

const question = { name: "example.com.", type: 1 };
const answer = {
  name: "example.com.",
  type: 1,
  TTL: 60,
  data: "93.184.216.34",
};
const json = (body: unknown) => new Response(JSON.stringify(body));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({ Status: 0, Question: [question], Answer: [answer] }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resolvePublicDnsRecords", () => {
  it("uses one fixed bounded public DoH request and validates the question", async () => {
    await expect(resolvePublicDnsRecords("EXAMPLE.COM", "A")).resolves.toEqual({
      status: 0,
      questions: [question],
      answers: [{ name: answer.name, type: 1, ttl: 60, data: answer.data }],
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://cloudflare-dns.com/dns-query?name=EXAMPLE.COM&type=A",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        headers: { Accept: "application/dns-json" },
      }),
    );
  });

  it.each([
    {},
    { Status: 0, Question: [{ ...question, name: "other.example" }] },
    { Status: 0, Question: [{ ...question, type: 16 }] },
    { Status: 0, Question: [question], TC: true },
    { Status: 0, Question: [question], Answer: Array(33).fill(answer) },
    { Status: 0, Question: [question], Answer: [{ ...answer, TTL: -1 }] },
    {
      Status: 0,
      Question: [question],
      Answer: [{ ...answer, name: "bad..example" }],
    },
  ])("rejects a malformed or ambiguous resolver envelope: %j", async (body) => {
    vi.mocked(fetch).mockImplementation(async () => json(body));
    await expect(
      resolvePublicDnsRecords("example.com", "A"),
    ).rejects.toBeDefined();
  });

  it("refuses redirects and cancels their bodies", async () => {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: 302,
        headers: { location: "https://other.example" },
      }),
    );
    await expect(resolvePublicDnsRecords("example.com", "A")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds streamed JSON rather than trusting content length", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16_385));
        },
        cancel,
      }),
      { headers: { "content-length": "1" } },
    );
    vi.mocked(fetch).mockResolvedValue(response);
    await expect(resolvePublicDnsRecords("example.com", "A")).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("times out uncooperative headers and cancels a late response", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const request = resolvePublicDnsRecords("example.com", "A");
    const assertion = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await assertion;
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out and releases a stalled response reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    vi.mocked(fetch).mockResolvedValue(response);
    const request = resolvePublicDnsRecords("example.com", "A");
    const assertion = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("honors a pre-aborted signal without making a request", async () => {
    await expect(
      resolvePublicDnsRecords("example.com", "A", AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
