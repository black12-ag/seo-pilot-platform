import { resolvePublicDnsRecords } from "@/server/lib/public-dns";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import {
  getAuthorityProofDetails,
  observeProof,
  proofFailure,
  proofMatch,
  type ProofTarget,
  type ProofObservation,
} from "./authorityProof";

/** DNS presentation-format character strings: escapes encode octets, not JS escapes. */
function decodeTxt(data: string): string {
  const bytes: number[] = [];
  let index = 0;
  let strings = 0;
  while (index < data.length) {
    while (data[index] === " " || data[index] === "\t") index++;
    if (index === data.length && strings) break;
    if (data[index++] !== '"') throw new Error("Invalid TXT string");
    strings++;
    let length = 0;
    let closed = false;
    while (index < data.length) {
      let code = data.charCodeAt(index++);
      if (code === 34) {
        closed = true;
        break;
      }
      if (code === 92) {
        const numeric = /[0-9]/.test(data[index] ?? "");
        const escaped = data.slice(index, index + (numeric ? 3 : 1));
        if (!escaped || (numeric && !/^\d{3}$/.test(escaped)))
          throw new Error("Invalid TXT escape");
        code = numeric ? Number(escaped) : escaped.charCodeAt(0);
        index += escaped.length;
      } else if (code < 32 || code > 126) {
        throw new Error("Invalid TXT character");
      }
      if (code > 255 || ++length > 255 || bytes.length >= 1024)
        throw new Error("TXT too large");
      bytes.push(code);
    }
    if (
      !closed ||
      (index < data.length && data[index] !== " " && data[index] !== "\t")
    )
      throw new Error("Invalid TXT boundary");
  }
  if (!strings) throw new Error("Missing TXT string");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    new Uint8Array(bytes),
  );
}

export function checkDnsAuthorityProof(
  target: ProofTarget,
  signal: AbortSignal,
): Promise<ProofObservation> {
  return observeProof(signal, 2_500, "dns_unavailable", async (deadline) => {
    let details: ReturnType<typeof getAuthorityProofDetails>;
    try {
      details = getAuthorityProofDetails(target);
      if (!isCrawlableUrl(target.origin) || details.dnsName.length > 253)
        return proofFailure("blocked_target");
    } catch {
      return proofFailure("blocked_target");
    }
    try {
      deadline.throwIfAborted();
      const lookup = await resolvePublicDnsRecords(
        details.dnsName,
        "TXT",
        deadline,
      );
      deadline.throwIfAborted();
      if (lookup.status === 3) return proofFailure("dns_not_found");
      if (lookup.status !== 0) return proofFailure("dns_unavailable");
      const owner = details.dnsName.toLowerCase();
      const answers = lookup.answers.filter(
        (answer) => answer.name.toLowerCase().replace(/\.$/, "") === owner,
      );
      if (
        lookup.answers.some((answer) => answer.type === 5 || answer.type === 39)
      )
        return proofFailure("invalid_response");
      const records = answers.filter((answer) => answer.type === 16);
      if (records.length === 0) return proofFailure("dns_not_found");
      const values = records.map((answer) => decodeTxt(answer.data));
      if (values.includes(details.value))
        return await proofMatch(details.value, null);
      return proofFailure("mismatch");
    } catch {
      return proofFailure("dns_unavailable");
    }
  });
}
