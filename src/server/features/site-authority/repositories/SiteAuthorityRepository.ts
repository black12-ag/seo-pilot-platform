import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  projects,
  projectSiteAuthority as a,
  siteAuthorityChallenges as c,
} from "@/db/schema";
import type {
  CheckAuthorityInput,
  IssueAuthorityInput,
  RevokeAuthorityInput,
} from "@/types/schemas/siteAuthority";
import type { ProofObservation } from "../services/authorityProof";
import {
  authorityScope,
  lockAuthorityProject,
  type AuthorityScope,
} from "./siteAuthorityProjectWrites";
import { authorityLimits, issueAuthority } from "./siteAuthorityIssue";
import {
  claimAuthorityCheck,
  completeAuthorityCheck,
} from "./siteAuthorityChecks";
export type { AuthorityScope } from "./siteAuthorityProjectWrites";
export { authorityLimits } from "./siteAuthorityIssue";

async function get(scope: AuthorityScope, projectId: string) {
  const [row] = await db
    .select({ projectId: projects.id, authority: a, challenge: c })
    .from(projects)
    .leftJoin(a, eq(a.projectId, projects.id))
    .leftJoin(
      c,
      and(
        eq(c.projectId, a.projectId),
        eq(c.id, a.currentChallengeId),
        eq(c.authorityVersion, a.version),
        eq(c.origin, a.origin),
      ),
    )
    .where(
      and(eq(projects.id, projectId), authorityScope(scope, projectId, false)),
    )
    .limit(1);
  return row ?? null;
}
export type AuthorityState = NonNullable<Awaited<ReturnType<typeof get>>>;
export type AuthorityRefusalCode =
  | "stale"
  | "busy"
  | "rate_limited"
  | "expired"
  | "exhausted";
export type AuthorityRepositoryResult =
  | { ok: true; state: AuthorityState }
  | {
      ok: false;
      code: AuthorityRefusalCode;
      state: AuthorityState | null;
      retryAtMs?: number;
    };
type AuthorityClaimResult = AuthorityRepositoryResult & {
  claimToken?: string;
};

async function issue(
  scope: AuthorityScope,
  input: IssueAuthorityInput,
  nowMs: number,
): Promise<AuthorityRepositoryResult> {
  const candidate = await issueAuthority(scope, input, nowMs);
  const state = await get(scope, input.projectId);
  if (
    state?.authority?.version === candidate.version &&
    state.challenge?.id === candidate.id &&
    state.challenge.status === "pending"
  )
    return { ok: true, state };
  if (!state || (state.authority?.version ?? 0) !== input.expectedVersion)
    return { ok: false, code: "stale", state };
  const selected = state.authority;
  const retryAtMs = Math.max(
    (selected?.lastIssuedAtMs ?? -authorityLimits.issueCooldownMs) +
      authorityLimits.issueCooldownMs,
    selected && selected.issuedInWindow >= authorityLimits.issues
      ? (selected.issueWindowStartedAtMs ?? nowMs) +
          authorityLimits.issueWindowMs
      : 0,
  );
  return { ok: false, code: "rate_limited", state, retryAtMs };
}

async function claim(
  scope: AuthorityScope,
  input: CheckAuthorityInput,
  nowMs: number,
): Promise<AuthorityClaimResult> {
  const token = await claimAuthorityCheck(scope, input, nowMs);
  const state = await get(scope, input.projectId);
  if (
    !state ||
    state.authority?.version !== input.expectedVersion ||
    state.challenge?.id !== input.challengeId
  )
    return { ok: false, code: "stale", state };
  const challenge = state.challenge;
  if (
    challenge.status === "verified" &&
    state.authority.status === "verified" &&
    (state.authority.verifiedUntilMs ?? 0) > nowMs
  )
    return { ok: true, state };
  if (
    challenge.claimToken === token &&
    challenge.status === "checking" &&
    (challenge.claimUntilMs ?? 0) > nowMs
  )
    return { ok: true, state, claimToken: token };
  if (challenge.expiresAtMs <= nowMs)
    return { ok: false, code: "expired", state };
  if (
    challenge.attemptsUsed >= authorityLimits.checks &&
    challenge.status !== "checking"
  )
    return { ok: false, code: "exhausted", state };
  if (challenge.status === "checking" && state.authority.status !== "pending")
    return { ok: false, code: "stale", state };
  if (challenge.status === "checking")
    return {
      ok: false,
      code: "busy",
      state,
      retryAtMs: challenge.claimUntilMs ?? challenge.nextCheckAtMs,
    };
  if (challenge.status === "pending" && challenge.nextCheckAtMs > nowMs)
    return {
      ok: false,
      code: "rate_limited",
      state,
      retryAtMs: challenge.nextCheckAtMs,
    };
  return { ok: false, code: "stale", state };
}

/** Returns current authorized state, never a claim that this observation committed. */
async function complete(
  scope: AuthorityScope,
  input: CheckAuthorityInput & { claimToken: string },
  observation: ProofObservation,
  nowMs: number,
) {
  await completeAuthorityCheck(scope, input, observation, nowMs);
  return get(scope, input.projectId);
}

async function revoke(
  scope: AuthorityScope,
  input: RevokeAuthorityInput,
  nowMs: number,
): Promise<AuthorityRepositoryResult> {
  const authorized = authorityScope(scope, input.projectId);
  await runBatch((tx) => [
    lockAuthorityProject(tx, scope, input.projectId),
    tx
      .insert(a)
      .select(
        sql`select ${input.projectId}, null, 0, 'unverified', null, null, null, null, null, null, 0, null, ${nowMs} where ${authorized} and ${input.expectedVersion} = 0`,
      )
      .onConflictDoNothing(),
    tx
      .update(c)
      .set({ status: "revoked", claimToken: null, claimUntilMs: null })
      .where(
        and(
          eq(c.projectId, input.projectId),
          sql`${c.status} in ('pending','checking')`,
          authorized,
          sql`exists (select 1 from ${a} where ${a.projectId} = ${input.projectId} and ${a.version} = ${input.expectedVersion} and ${a.currentChallengeId} = ${c.id} and ${a.status} <> 'revoked')`,
        ),
      ),
    tx
      .update(a)
      .set({
        version: sql`${a.version} + 1`,
        status: "revoked",
        currentChallengeId: null,
        completionClaimToken: null,
        verifiedAtMs: null,
        verifiedUntilMs: null,
        revocationReason: "user",
        updatedAtMs: nowMs,
      })
      .where(
        and(
          eq(a.projectId, input.projectId),
          eq(a.version, input.expectedVersion),
          sql`${a.status} <> 'revoked'`,
          authorized,
        ),
      ),
  ]);
  const state = await get(scope, input.projectId);
  if (
    state?.authority?.status === "revoked" &&
    (state.authority.version === input.expectedVersion + 1 ||
      state.authority.version === input.expectedVersion)
  )
    return { ok: true, state };
  return { ok: false, code: "stale", state };
}

async function getVerifiedGrant(
  scope: AuthorityScope,
  projectId: string,
  expectedVersion: number,
  nowMs: number,
) {
  const [row] = await db
    .select({
      projectId: a.projectId,
      origin: c.origin,
      version: a.version,
      method: c.method,
      verifiedUntilMs: a.verifiedUntilMs,
    })
    .from(a)
    .innerJoin(
      c,
      and(
        eq(c.projectId, a.projectId),
        eq(c.id, a.currentChallengeId),
        eq(c.authorityVersion, a.version),
        eq(c.origin, a.origin),
        eq(c.status, "verified"),
      ),
    )
    .where(
      and(
        eq(a.projectId, projectId),
        eq(a.version, expectedVersion),
        eq(a.status, "verified"),
        sql`${a.verifiedUntilMs} > ${nowMs}`,
        authorityScope(scope, projectId),
      ),
    )
    .limit(1);
  return row ?? null;
}
export const SiteAuthorityRepository = {
  get,
  issue,
  claim,
  complete,
  revoke,
  getVerifiedGrant,
} as const;
