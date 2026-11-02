export type ProofTarget = { id: string; origin: string; nonce: string };
export const proofFailures = [
  "not_found",
  "mismatch",
  "redirect",
  "blocked_target",
  "unreachable",
  "timeout",
  "body_too_large",
  "invalid_response",
  "dns_unavailable",
  "dns_not_found",
] as const;
export type ProofFailure = (typeof proofFailures)[number];
export type ProofObservation =
  | {
      matched: true;
      observedAtMs: number;
      evidenceSha256: string;
      httpStatus: 200 | null;
    }
  | {
      matched: false;
      observedAtMs: number;
      failure: ProofFailure;
      httpStatus: number | null;
    };

/** Stored challenge only: no caller-selected lookup paths, headers or values. */
export function getAuthorityProofDetails(target: ProofTarget) {
  const origin = new URL(target.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== target.origin ||
    origin.username ||
    origin.password ||
    origin.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      origin.hostname,
    ) ||
    origin.hostname.length > 253 ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(target.id) ||
    !/^[A-Za-z0-9_-]{43}$/.test(target.nonce)
  ) {
    throw new Error("Invalid stored proof target");
  }
  return {
    value: `seo-pilot-site-verification=v1.${target.id}.${target.nonce}`,
    httpUrl: new URL(
      `/.well-known/seo-pilot-verification/${target.id}.txt`,
      origin,
    ).href,
    dnsName: `_seo-pilot-verification.${origin.hostname}`,
  };
}

export function proofFailure(
  failure: ProofFailure,
  httpStatus: number | null = null,
): ProofObservation {
  return { matched: false, observedAtMs: Date.now(), failure, httpStatus };
}

export async function proofMatch(
  value: string,
  httpStatus: 200 | null,
): Promise<ProofObservation> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return {
    matched: true,
    observedAtMs: Date.now(),
    evidenceSha256: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    httpStatus,
  };
}

/** Race the whole operation; guards after awaits prevent work starting after expiry. */
export async function observeProof(
  signal: AbortSignal,
  timeoutMs: number,
  timeoutFailure: ProofFailure,
  run: (signal: AbortSignal) => Promise<ProofObservation>,
): Promise<ProofObservation> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<ProofObservation>((resolve) => {
    onAbort = () => resolve(proofFailure(timeoutFailure));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([run(controller.signal), cancelled]);
  } catch {
    return proofFailure(
      controller.signal.aborted ? timeoutFailure : "invalid_response",
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
