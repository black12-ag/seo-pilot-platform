import { z } from "zod";
import { readBoundedText } from "./read-bounded-text";

const DNS_TYPES = { A: 1, AAAA: 28, TXT: 16 } as const;
const dnsName = z
  .string()
  .max(254)
  .regex(
    /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.?$/i,
  );
const envelope = z.object({
  Status: z.number().int().min(0).max(15),
  TC: z.literal(false).optional(),
  Question: z
    .array(
      z.object({ name: dnsName, type: z.number().int().min(1).max(65535) }),
    )
    .length(1),
  Answer: z
    .array(
      z.object({
        name: dnsName,
        type: z.number().int().min(1).max(65535),
        TTL: z.number().int().min(0).max(4_294_967_295),
        data: z.string().max(16_384),
      }),
    )
    .max(32)
    .default([]),
});

type DnsLookup = {
  status: number;
  questions: Array<{ name: string; type: number }>;
  answers: Array<{ name: string; type: number; ttl: number; data: string }>;
};

/** Fixed public resolver only; callers decide whether resolver failure is fatal. */
export async function resolvePublicDnsRecords(
  name: string,
  type: "A" | "AAAA" | "TXT",
  signal?: AbortSignal,
): Promise<DnsLookup> {
  dnsName.parse(name);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new DOMException("DNS timeout", "TimeoutError")),
    2_500,
  );
  let response: Response | undefined;
  let rejectAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    const work = async () => {
      controller.signal.throwIfAborted();
      response = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
        {
          method: "GET",
          headers: { Accept: "application/dns-json" },
          credentials: "omit",
          redirect: "manual",
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        controller.signal.throwIfAborted();
      }
      if (response.status !== 200 || response.redirected)
        throw new Error("Invalid DNS response");
      const text = await readBoundedText(response, 16_384, controller.signal);
      if (text === null) throw new Error("DNS response too large or empty");
      const body = envelope.parse(JSON.parse(text));
      const question = body.Question[0];
      if (
        question.name.toLowerCase().replace(/\.$/, "") !==
          name.toLowerCase().replace(/\.$/, "") ||
        question.type !== DNS_TYPES[type]
      ) {
        throw new Error("Unexpected DNS question");
      }
      return {
        status: body.Status,
        questions: body.Question,
        answers: body.Answer.map(({ TTL, ...answer }) => ({
          ...answer,
          ttl: TTL,
        })),
      };
    };
    return await Promise.race([work(), cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (rejectAbort)
      controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
    if (response && !response.body?.locked)
      void response.body?.cancel().catch(() => {});
  }
}
