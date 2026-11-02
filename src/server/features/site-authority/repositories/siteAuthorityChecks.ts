import { and, eq, sql } from "drizzle-orm";
import { runBatch } from "@/db/runBatch";
import {
  projectSiteAuthority as a,
  siteAuthorityChallenges as c,
} from "@/db/schema";
import type { CheckAuthorityInput } from "@/types/schemas/siteAuthority";
import type { ProofObservation } from "../services/authorityProof";
import {
  authorityScope,
  lockAuthorityProject,
  type AuthorityScope,
} from "./siteAuthorityProjectWrites";
import { authorityLimits } from "./siteAuthorityIssue";

function currentChallenge(scope: AuthorityScope, input: CheckAuthorityInput) {
  return and(
    eq(c.projectId, input.projectId),
    eq(c.id, input.challengeId),
    eq(c.authorityVersion, input.expectedVersion),
    authorityScope(scope, input.projectId),
    sql`exists (select 1 from ${a} where ${a.projectId} = ${input.projectId} and ${a.version} = ${input.expectedVersion} and ${a.currentChallengeId} = ${input.challengeId} and ${a.origin} = ${c.origin} and ${a.status} = 'pending')`,
  );
}

export async function claimAuthorityCheck(
  scope: AuthorityScope,
  input: CheckAuthorityInput,
  nowMs: number,
) {
  const claimToken = crypto.randomUUID();
  const current = currentChallenge(scope, input);
  await runBatch((tx) => [
    lockAuthorityProject(tx, scope, input.projectId),
    tx
      .update(c)
      .set({ status: "expired", claimToken: null, claimUntilMs: null })
      .where(
        and(
          current,
          sql`${c.status} in ('pending','checking') and ${c.expiresAtMs} <= ${nowMs}`,
        ),
      ),
    tx
      .update(c)
      .set({ status: "exhausted", claimToken: null, claimUntilMs: null })
      .where(
        and(
          current,
          sql`${c.status} = 'checking' and ${c.claimUntilMs} <= ${nowMs} and ${c.attemptsUsed} >= ${authorityLimits.checks}`,
        ),
      ),
    tx
      .update(a)
      .set({ status: "unverified", updatedAtMs: nowMs })
      .where(
        and(
          eq(a.projectId, input.projectId),
          eq(a.version, input.expectedVersion),
          eq(a.currentChallengeId, input.challengeId),
          authorityScope(scope, input.projectId),
          sql`exists (select 1 from ${c} where ${c.id} = ${input.challengeId} and ${c.projectId} = ${input.projectId} and ${c.authorityVersion} = ${input.expectedVersion} and ${c.status} = 'exhausted')`,
        ),
      ),
    tx
      .update(c)
      .set({
        status: "checking",
        attemptsUsed: sql`${c.attemptsUsed} + 1`,
        claimToken,
        claimUntilMs: nowMs + authorityLimits.claimMs,
        nextCheckAtMs: nowMs + authorityLimits.checkCooldownMs,
      })
      .where(
        and(
          current,
          sql`${c.expiresAtMs} > ${nowMs} and ${c.attemptsUsed} < ${authorityLimits.checks} and ${c.nextCheckAtMs} <= ${nowMs} and (${c.status} = 'pending' or (${c.status} = 'checking' and ${c.claimUntilMs} <= ${nowMs}))`,
        ),
      ),
    tx
      .update(a)
      .set({ completionClaimToken: null })
      .where(
        and(
          eq(a.projectId, input.projectId),
          eq(a.version, input.expectedVersion),
          eq(a.currentChallengeId, input.challengeId),
          authorityScope(scope, input.projectId),
          sql`exists (select 1 from ${c} where ${c.projectId} = ${input.projectId} and ${c.id} = ${input.challengeId} and ${c.authorityVersion} = ${input.expectedVersion} and ${c.origin} = ${a.origin} and ${c.status} = 'checking' and ${c.claimToken} = ${claimToken})`,
        ),
      ),
  ]);
  return claimToken;
}

export async function completeAuthorityCheck(
  scope: AuthorityScope,
  input: CheckAuthorityInput & { claimToken: string },
  observation: ProofObservation,
  nowMs: number,
) {
  const current = currentChallenge(scope, input);
  const liveClaim = and(
    eq(c.status, "checking"),
    eq(c.claimToken, input.claimToken),
    sql`${c.claimUntilMs} > ${nowMs} and ${c.expiresAtMs} > ${nowMs}`,
  );
  const authorityPointer = and(
    eq(a.projectId, input.projectId),
    eq(a.version, input.expectedVersion),
    eq(a.currentChallengeId, input.challengeId),
    authorityScope(scope, input.projectId),
  );
  await runBatch((tx) => [
    lockAuthorityProject(tx, scope, input.projectId),
    // Retain the exact live claim until both records have transitioned.
    tx
      .update(c)
      .set({
        checkedAtMs: observation.observedAtMs,
        lastFailure: observation.matched ? null : observation.failure,
        httpStatus: observation.httpStatus,
        evidenceSha256: observation.matched ? observation.evidenceSha256 : null,
      })
      .where(and(current, liveClaim)),
    tx
      .update(a)
      .set({
        ...(observation.matched
          ? {
              status: "verified" as const,
              verifiedAtMs: nowMs,
              verifiedUntilMs: nowMs + authorityLimits.grantMs,
            }
          : {
              status: sql`case when exists (select 1 from ${c} where ${c.projectId} = ${input.projectId} and ${c.id} = ${input.challengeId} and ${c.attemptsUsed} >= ${authorityLimits.checks}) then 'unverified' else 'pending' end`,
            }),
        completionClaimToken: input.claimToken,
        updatedAtMs: nowMs,
      })
      .where(
        and(
          authorityPointer,
          eq(a.status, "pending"),
          sql`exists (select 1 from ${c} where ${c.projectId} = ${input.projectId} and ${c.id} = ${input.challengeId} and ${c.authorityVersion} = ${input.expectedVersion} and ${c.origin} = ${a.origin} and ${liveClaim} and ${c.checkedAtMs} = ${observation.observedAtMs} and ${observation.matched ? sql`${c.evidenceSha256} = ${observation.evidenceSha256}` : sql`${c.lastFailure} = ${observation.failure}`})`,
        ),
      ),
    // A stale claim can never finalize another claim, even with identical evidence/time.
    tx
      .update(c)
      .set({
        status: observation.matched
          ? "verified"
          : sql`case when ${c.attemptsUsed} >= ${authorityLimits.checks} then 'exhausted' else 'pending' end`,
        claimToken: null,
        claimUntilMs: null,
      })
      .where(
        and(
          eq(c.projectId, input.projectId),
          eq(c.id, input.challengeId),
          eq(c.authorityVersion, input.expectedVersion),
          liveClaim,
          authorityScope(scope, input.projectId),
          sql`exists (select 1 from ${a} where ${a.projectId} = ${input.projectId} and ${a.version} = ${input.expectedVersion} and ${a.currentChallengeId} = ${input.challengeId} and ${a.origin} = ${c.origin} and ${a.completionClaimToken} = ${input.claimToken} and ${observation.matched ? sql`${a.status} = 'verified'` : sql`${a.status} in ('pending','unverified')`})`,
        ),
      ),
  ]);
}
