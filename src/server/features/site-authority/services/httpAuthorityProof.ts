import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { publicFetch } from "@/server/lib/public-fetch";
import { getWorkersEnv, getOptionalEnvValue } from "@/server/lib/runtime-env";
import { readBoundedText } from "@/server/lib/read-bounded-text";
import {
  getAuthorityProofDetails,
  observeProof,
  proofFailure,
  proofMatch,
  type ProofTarget,
  type ProofObservation,
} from "./authorityProof";

export function checkHttpAuthorityProof(
  target: ProofTarget,
  signal: AbortSignal,
): Promise<ProofObservation> {
  return observeProof(signal, 10_000, "timeout", async (deadline) => {
    let details: ReturnType<typeof getAuthorityProofDetails>;
    try {
      details = getAuthorityProofDetails(target);
    } catch {
      return proofFailure("blocked_target");
    }
    let response: Response | undefined;
    try {
      const url = await normalizeAndValidateStartUrl(details.httpUrl);
      deadline.throwIfAborted();
      if (url !== details.httpUrl) return proofFailure("blocked_target");
      const workers = await getWorkersEnv();
      const gateway = await getOptionalEnvValue("CRAWL_GATEWAY_URL");
      const secret = gateway
        ? await getOptionalEnvValue("CRAWL_GATEWAY_SECRET")
        : undefined;
      deadline.throwIfAborted();
      // celld also exposes Workers bindings but lacks strictly-public global fetch.
      const requiresGateway = import.meta.env.MODE === "standalone" || !workers;
      if ((requiresGateway && !gateway) || (gateway && !secret))
        return proofFailure("unreachable");
      response = await publicFetch(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: {
          "user-agent": "SEO-Pilot-Site-Verification/1.0",
          Accept: "text/plain",
        },
        signal: deadline,
      });
      deadline.throwIfAborted();
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        return proofFailure("redirect", response.status);
      if (response.status !== 200)
        return proofFailure(
          response.status === 404 || response.status === 410
            ? "not_found"
            : "invalid_response",
          response.status,
        );
      const body = await readBoundedText(response, 1024, deadline, true);
      deadline.throwIfAborted();
      if (body === null)
        return proofFailure(
          response.body ? "body_too_large" : "invalid_response",
          200,
        );
      const content = body.replace(/\r?\n$/, "");
      if (content !== details.value) return proofFailure("mismatch", 200);
      return await proofMatch(details.value, 200);
    } catch (error) {
      if (deadline.aborted)
        return proofFailure("timeout", response?.status ?? null);
      const blocked =
        error instanceof Error &&
        "code" in error &&
        error.code === "CRAWL_TARGET_BLOCKED";
      return proofFailure(
        blocked ? "blocked_target" : "unreachable",
        response?.status ?? null,
      );
    } finally {
      if (response && !response.body?.locked)
        void response.body?.cancel().catch(() => {});
    }
  });
}
