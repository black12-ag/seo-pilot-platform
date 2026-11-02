import type { z } from "zod";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import { AppError } from "@/server/lib/errors";
import {
  authorityMutationResultSchema,
  checkAuthorityInputSchema,
  issueAuthorityInputSchema,
  readAuthorityInputSchema,
  readAuthorityResultSchema,
  proofFailureSchema,
  requireVerifiedOriginInputSchema,
  revokeAuthorityInputSchema,
  type AuthorityInstructions,
  type AuthorityView,
  type CheckAuthorityInput,
  type IssueAuthorityInput,
  type RevokeAuthorityInput,
  type ReadAuthorityInput,
  type MutationResult,
} from "@/types/schemas/siteAuthority";
import {
  SiteAuthorityRepository,
  type AuthorityState,
  type AuthorityRepositoryResult,
} from "../repositories/SiteAuthorityRepository";
import { getAuthorityProofDetails } from "./authorityProof";
import { checkHttpAuthorityProof } from "./httpAuthorityProof";
import { checkDnsAuthorityProof } from "./dnsAuthorityProof";
import {
  siteAuthorityAccess,
  type AuthorityActor,
} from "./siteAuthorityAccess";

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError("VALIDATION_ERROR");
  return result.data;
}

function normalizedOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("VALIDATION_ERROR", "Enter an exact HTTPS origin.");
  }
  if (
    !/^https:\/\//i.test(value) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.href.includes("?") ||
    url.href.includes("#") ||
    url.hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      url.hostname,
    ) ||
    !isCrawlableUrl(url.href)
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "Enter an exact public HTTPS origin.",
    );
  return url.origin;
}

function view(
  state: AuthorityState,
  canManage: boolean,
  nowMs: number,
): AuthorityView {
  const a = state.authority;
  const c = state.challenge;
  const grant = a?.status === "verified" && c?.status === "verified";
  let status: AuthorityView["status"] = a?.status ?? "unverified";
  if (status === "verified") {
    status = !grant
      ? "unverified"
      : (a?.verifiedUntilMs ?? 0) <= nowMs
        ? "expired"
        : "verified";
  } else if (status === "pending" && c && c.expiresAtMs <= nowMs) {
    status = "expired";
  }
  return {
    projectId: state.projectId,
    version: a?.version ?? 0,
    origin: a?.origin ?? null,
    status,
    supportedMethods: ["http_file", "dns_txt"],
    canManage,
    verifiedMethod: grant ? c.method : null,
    verifiedAtMs: grant ? a.verifiedAtMs : null,
    verifiedUntilMs: grant ? a.verifiedUntilMs : null,
    revocationReason: a?.revocationReason ?? null,
    challenge: c
      ? {
          id: c.id,
          method: c.method,
          status:
            c.expiresAtMs <= nowMs &&
            (c.status === "pending" || c.status === "checking")
              ? "expired"
              : c.status,
          issuedAtMs: c.issuedAtMs,
          expiresAtMs: c.expiresAtMs,
          attemptsUsed: c.attemptsUsed,
          nextCheckAtMs: c.nextCheckAtMs,
          lastFailure:
            c.lastFailure === null
              ? null
              : proofFailureSchema.parse(c.lastFailure),
        }
      : null,
  };
}

function instructions(
  state: AuthorityState,
  canManage: boolean,
  nowMs: number,
): AuthorityInstructions | undefined {
  const c = state.challenge;
  if (
    !canManage ||
    !c ||
    c.expiresAtMs <= nowMs ||
    !["pending", "checking", "verified"].includes(c.status)
  )
    return;
  const details = getAuthorityProofDetails(c);
  return c.method === "http_file"
    ? { method: "http_file", url: details.httpUrl, content: details.value }
    : {
        method: "dns_txt",
        name: details.dnsName,
        type: "TXT",
        value: details.value,
      };
}

async function current(
  actor: AuthorityActor,
  projectId: string,
  manage = false,
) {
  const access = await siteAuthorityAccess(actor, projectId, manage);
  const state = await SiteAuthorityRepository.get(access.scope, projectId);
  if (!state) {
    await siteAuthorityAccess(actor, projectId, manage);
    throw new AppError("FORBIDDEN");
  }
  return { ...access, state };
}

async function get(actor: AuthorityActor, input: ReadAuthorityInput) {
  const data = parse(readAuthorityInputSchema, input);
  const { state, canManage } = await current(actor, data.projectId);
  const nowMs = Date.now();
  const publicInstructions = instructions(state, canManage, nowMs);
  return readAuthorityResultSchema.parse({
    authority: view(state, canManage, nowMs),
    ...(publicInstructions ? { instructions: publicInstructions } : {}),
  });
}

async function mutationResult(
  actor: AuthorityActor,
  projectId: string,
  result: AuthorityRepositoryResult,
): Promise<MutationResult> {
  // Re-read authorization after the write; SQL also fences membership changes at commit.
  const { state, canManage } = await current(actor, projectId, true);
  const nowMs = Date.now();
  const authority = view(state, canManage, nowMs);
  if (!result.ok)
    return authorityMutationResultSchema.parse({
      ok: false,
      code: result.code,
      authority,
      retryAtMs: result.retryAtMs,
    });
  if (
    state.authority?.version !== result.state.authority?.version ||
    state.challenge?.id !== result.state.challenge?.id ||
    state.authority?.completionClaimToken !==
      result.state.authority?.completionClaimToken
  ) {
    return { ok: false, code: "stale", authority };
  }
  return authorityMutationResultSchema.parse({
    ok: true,
    authority,
    instructions: instructions(state, canManage, nowMs),
  });
}

async function issue(
  actor: AuthorityActor,
  input: IssueAuthorityInput,
): Promise<MutationResult> {
  const data = parse(issueAuthorityInputSchema, input);
  const { scope } = await siteAuthorityAccess(actor, data.projectId, true);
  const origin = normalizedOrigin(data.origin);
  if (
    data.method === "dns_txt" &&
    `_seo-pilot-verification.${new URL(origin).hostname}`.length > 253
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The DNS verification record name is too long.",
    );
  }
  const result = await SiteAuthorityRepository.issue(
    scope,
    { ...data, origin },
    Date.now(),
  );
  return mutationResult(actor, data.projectId, result);
}

async function check(
  actor: AuthorityActor,
  input: CheckAuthorityInput,
): Promise<MutationResult> {
  const data = parse(checkAuthorityInputSchema, input);
  const { scope } = await siteAuthorityAccess(actor, data.projectId, true);
  const claim = await SiteAuthorityRepository.claim(scope, data, Date.now());
  if (!claim.ok || !claim.claimToken)
    return mutationResult(actor, data.projectId, claim);
  const challenge = claim.state.challenge;
  if (!challenge) throw new AppError("INTERNAL_ERROR");
  const signal = new AbortController().signal;
  const observation = await (
    challenge.method === "http_file"
      ? checkHttpAuthorityProof
      : checkDnsAuthorityProof
  )(challenge, signal);
  const access = await siteAuthorityAccess(actor, data.projectId, true);
  const nowMs = Date.now();
  const state = await SiteAuthorityRepository.complete(
    access.scope,
    { ...data, claimToken: claim.claimToken },
    observation,
    nowMs,
  );
  if (!state) {
    await current(actor, data.projectId, true);
    throw new AppError("FORBIDDEN");
  }
  let result: AuthorityRepositoryResult = { ok: false, code: "stale", state };
  const c = state.challenge;
  if (
    state.authority?.version === data.expectedVersion &&
    c?.id === data.challengeId
  ) {
    if (c.expiresAtMs <= nowMs) result = { ok: false, code: "expired", state };
    else if (c.status === "exhausted")
      result = { ok: false, code: "exhausted", state };
    else if (
      c.status === "verified" &&
      state.authority.status === "verified" &&
      state.authority.completionClaimToken === claim.claimToken
    )
      result = { ok: true, state };
    else if (c.status === "checking")
      result = {
        ok: false,
        code: "busy",
        state,
        retryAtMs: c.claimUntilMs ?? c.nextCheckAtMs,
      };
    else if (
      c.status === "pending" &&
      state.authority.completionClaimToken === claim.claimToken &&
      !observation.matched
    )
      result = { ok: true, state };
  }
  return mutationResult(actor, data.projectId, result);
}

async function revoke(
  actor: AuthorityActor,
  input: RevokeAuthorityInput,
): Promise<MutationResult> {
  const data = parse(revokeAuthorityInputSchema, input);
  const { scope } = await siteAuthorityAccess(actor, data.projectId, true);
  return mutationResult(
    actor,
    data.projectId,
    await SiteAuthorityRepository.revoke(scope, data, Date.now()),
  );
}

async function requireVerifiedOrigin(
  actor: AuthorityActor,
  input: z.infer<typeof requireVerifiedOriginInputSchema>,
) {
  const data = parse(requireVerifiedOriginInputSchema, input);
  const { scope } = await siteAuthorityAccess(actor, data.projectId, true);
  const target = new URL(data.targetUrl);
  const origin = normalizedOrigin(target.origin);
  if (target.username || target.password)
    throw new AppError("VALIDATION_ERROR");
  const grant = await SiteAuthorityRepository.getVerifiedGrant(
    scope,
    data.projectId,
    data.expectedVersion,
    Date.now(),
  );
  if (!grant || grant.origin !== origin || !grant.verifiedUntilMs)
    throw new AppError(
      "FORBIDDEN",
      "Current exact site authority is required.",
    );
  return { ...grant, verifiedUntilMs: grant.verifiedUntilMs };
}

export const SiteAuthorityService = {
  get,
  issue,
  check,
  revoke,
  requireVerifiedOrigin,
} as const;
