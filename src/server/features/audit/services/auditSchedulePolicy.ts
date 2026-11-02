import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { sha256Hex } from "@/server/lib/audit/ids";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cost = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const policySchema = z.strictObject({
  version: z.literal(1),
  maxRunsPerUtcDay: positive,
  maxPagesPerUtcDay: positive,
  maxCostMicrosPerUtcDay: cost,
  maxConcurrentRuns: positive,
  providers: z.strictObject({
    cloudflare: z
      .strictObject({ maxAttemptsPerRun: positive, unitMaxCostMicros: cost })
      .optional(),
    context: z
      .strictObject({ maxCreditsPerRun: positive, unitMaxCostMicros: cost })
      .optional(),
    dataforseoLighthouse: z
      .strictObject({ maxChecksPerRun: positive, unitMaxCostMicros: cost })
      .optional(),
  }),
});
export type AuditRecurringPolicy = z.infer<typeof policySchema>;
export async function auditSchedulePolicy() {
  const value = await getOptionalEnvValue("AUDIT_RECURRING_POLICY");
  let policy: AuditRecurringPolicy | null = null;
  if (value) {
    try {
      const parsed = policySchema.safeParse(JSON.parse(value));
      if (parsed.success) policy = parsed.data;
    } catch {
      /* Invalid policy remains explicitly blocked. */
    }
  }
  return { policy, fingerprint: await sha256Hex(JSON.stringify(policy)) };
}
