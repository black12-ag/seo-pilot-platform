import { and, eq, sql } from "drizzle-orm";
import { runBatch } from "@/db/runBatch";
import {
  projectSiteAuthority as a,
  siteAuthorityChallenges as c,
} from "@/db/schema";
import type { IssueAuthorityInput } from "@/types/schemas/siteAuthority";
import {
  authorityScope,
  lockAuthorityProject,
  type AuthorityScope,
} from "./siteAuthorityProjectWrites";

export const authorityLimits = {
  httpChallengeMs: 15 * 60_000,
  dnsChallengeMs: 60 * 60_000,
  grantMs: 30 * 24 * 60 * 60_000,
  claimMs: 15_000,
  checkCooldownMs: 10_000,
  issueCooldownMs: 60_000,
  issueWindowMs: 60 * 60_000,
  checks: 5,
  issues: 10,
} as const;

export async function issueAuthority(
  scope: AuthorityScope,
  input: IssueAuthorityInput,
  nowMs: number,
) {
  const id = crypto.randomUUID();
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const version = input.expectedVersion + 1;
  const authorized = authorityScope(scope, input.projectId);
  const eligible = sql`${a.version} = ${input.expectedVersion}
    and (${a.lastIssuedAtMs} is null or ${a.lastIssuedAtMs} <= ${nowMs - authorityLimits.issueCooldownMs})
    and (${a.issueWindowStartedAtMs} is null or ${a.issueWindowStartedAtMs} <= ${nowMs - authorityLimits.issueWindowMs} or ${a.issuedInWindow} < ${authorityLimits.issues})`;
  await runBatch((tx) => [
    lockAuthorityProject(tx, scope, input.projectId),
    tx
      .insert(a)
      .select(
        sql`select ${input.projectId}, null, 0, 'unverified', null, null, null, null, null, null, 0, null, ${nowMs} where ${authorized}`,
      )
      .onConflictDoNothing(),
    tx
      .insert(c)
      .select(
        sql`select ${id}, ${input.projectId}, ${version}, ${input.origin}, ${input.method}, ${nonce}, 'pending', ${nowMs}, ${nowMs + (input.method === "http_file" ? authorityLimits.httpChallengeMs : authorityLimits.dnsChallengeMs)}, ${nowMs}, 0, null, null, null, null, null, null, ${scope.requireMembership ? scope.userId : null}
      from ${a} where ${a.projectId} = ${input.projectId} and ${eligible} and ${authorized}`,
      )
      .onConflictDoNothing(),
    tx
      .update(a)
      .set({
        version,
        origin: input.origin,
        status: "pending",
        currentChallengeId: id,
        completionClaimToken: null,
        verifiedAtMs: null,
        verifiedUntilMs: null,
        revocationReason: null,
        lastIssuedAtMs: nowMs,
        updatedAtMs: nowMs,
        issuedInWindow: sql`case when ${a.issueWindowStartedAtMs} is null or ${a.issueWindowStartedAtMs} <= ${nowMs - authorityLimits.issueWindowMs} then 1 else ${a.issuedInWindow} + 1 end`,
        issueWindowStartedAtMs: sql`case when ${a.issueWindowStartedAtMs} is null or ${a.issueWindowStartedAtMs} <= ${nowMs - authorityLimits.issueWindowMs} then ${nowMs} else ${a.issueWindowStartedAtMs} end`,
      })
      .where(
        and(
          eq(a.projectId, input.projectId),
          eligible,
          authorized,
          sql`exists (select 1 from ${c} where ${c.id} = ${id} and ${c.projectId} = ${input.projectId} and ${c.authorityVersion} = ${version})`,
        ),
      ),
    tx
      .update(c)
      .set({ status: "superseded", claimToken: null, claimUntilMs: null })
      .where(
        and(
          eq(c.projectId, input.projectId),
          sql`${c.id} <> ${id} and ${c.status} in ('pending','checking')`,
          authorized,
          sql`exists (select 1 from ${a} where ${a.projectId} = ${input.projectId} and ${a.version} = ${version} and ${a.currentChallengeId} = ${id})`,
        ),
      ),
    tx
      .delete(c)
      .where(
        and(
          eq(c.projectId, input.projectId),
          eq(c.id, id),
          sql`exists (select 1 from projects p where p.id = ${input.projectId} and p.organization_id = ${scope.organizationId})`,
          eq(c.authorityVersion, version),
          sql`not exists (select 1 from ${a} where ${a.projectId} = ${input.projectId} and ${a.currentChallengeId} = ${id})`,
        ),
      ),
  ]);
  return { id, version };
}
