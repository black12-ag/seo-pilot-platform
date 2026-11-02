import { z } from "zod";
import { proofFailures } from "@/server/features/site-authority/services/authorityProof";

export const proofMethodSchema = z.enum(["http_file", "dns_txt"]);
const authorityStatusSchema = z.enum([
  "unverified",
  "pending",
  "verified",
  "revoked",
  "expired",
]);
const challengeStatusSchema = z.enum([
  "pending",
  "checking",
  "verified",
  "expired",
  "exhausted",
  "superseded",
  "revoked",
]);
export const proofFailureSchema = z.enum(proofFailures);
export const revocationReasonSchema = z.enum([
  "user",
  "website_changed",
  "project_archived",
  "organization_changed",
]);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = time;
const projectId = z.string().uuid();
export const authorityViewSchema = z.strictObject({
  projectId,
  version,
  origin: z.string().max(261).nullable(),
  status: authorityStatusSchema,
  supportedMethods: z.array(proofMethodSchema).max(2),
  canManage: z.boolean(),
  verifiedMethod: proofMethodSchema.nullable(),
  verifiedAtMs: time.nullable(),
  verifiedUntilMs: time.nullable(),
  revocationReason: revocationReasonSchema.nullable(),
  challenge: z
    .strictObject({
      id: z.string().uuid(),
      method: proofMethodSchema,
      status: challengeStatusSchema,
      issuedAtMs: time,
      expiresAtMs: time,
      attemptsUsed: z.number().int().min(0).max(5),
      nextCheckAtMs: time,
      lastFailure: proofFailureSchema.nullable(),
    })
    .nullable(),
});
export const authorityInstructionsSchema = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("http_file"),
    url: z.url().max(512),
    content: z.string().max(128),
  }),
  z.strictObject({
    method: z.literal("dns_txt"),
    name: z.string().max(277),
    type: z.literal("TXT"),
    value: z.string().max(128),
  }),
]);
export const readAuthorityInputSchema = z.strictObject({ projectId });
export const issueAuthorityInputSchema = z.strictObject({
  projectId,
  origin: z.string().min(9).max(2048),
  method: proofMethodSchema,
  expectedVersion: version,
});
export const checkAuthorityInputSchema = z.strictObject({
  projectId,
  challengeId: z.string().uuid(),
  expectedVersion: version,
});
export const revokeAuthorityInputSchema = z.strictObject({
  projectId,
  expectedVersion: version,
});
export const requireVerifiedOriginInputSchema = z.strictObject({
  projectId,
  targetUrl: z.url().max(2048),
  expectedVersion: version,
});
export const readAuthorityResultSchema = z.strictObject({
  authority: authorityViewSchema,
  instructions: authorityInstructionsSchema.optional(),
});
export const authorityMutationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    authority: authorityViewSchema,
    instructions: authorityInstructionsSchema.optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      "stale",
      "busy",
      "rate_limited",
      "expired",
      "exhausted",
      "method_unavailable",
    ]),
    authority: authorityViewSchema,
    retryAtMs: time.optional(),
  }),
]);
export type ProofMethod = z.infer<typeof proofMethodSchema>;
export type RevocationReason = z.infer<typeof revocationReasonSchema>;
export type AuthorityView = z.infer<typeof authorityViewSchema>;
export type AuthorityInstructions = z.infer<typeof authorityInstructionsSchema>;
export type ReadAuthorityInput = z.infer<typeof readAuthorityInputSchema>;
export type IssueAuthorityInput = z.infer<typeof issueAuthorityInputSchema>;
export type CheckAuthorityInput = z.infer<typeof checkAuthorityInputSchema>;
export type RevokeAuthorityInput = z.infer<typeof revokeAuthorityInputSchema>;
export type MutationResult = z.infer<typeof authorityMutationResultSchema>;
