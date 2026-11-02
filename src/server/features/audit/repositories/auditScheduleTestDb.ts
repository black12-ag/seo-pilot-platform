import type { AuditEvidenceManifest } from "@/types/schemas/audit-evidence";
import type { AuditScheduleRepository } from "./AuditScheduleRepository";
import type { AuditRecurringPolicy } from "../services/auditSchedulePolicy";
import {
  auditScheduleEstimateInputSchema,
  type AuditScheduleEstimateInput,
} from "@/types/schemas/audit-schedule";
import { sha256Hex } from "@/server/lib/audit/ids";
export { createSiteAuthorityTestDb as createAuditScheduleTestDb } from "../../site-authority/siteAuthorityTestDb";
export const now = Date.parse("2026-11-02T12:00:00Z");
export const scope = {
  organizationId: "organization",
  userId: "user",
  role: "owner",
  requireMembership: true,
};
export const policy: AuditRecurringPolicy = {
  version: 1,
  maxRunsPerUtcDay: 2,
  maxPagesPerUtcDay: 100,
  maxCostMicrosPerUtcDay: 0,
  maxConcurrentRuns: 2,
  providers: {},
};
export function scheduleInput(
  overrides: Partial<AuditScheduleEstimateInput> = {},
): AuditScheduleEstimateInput {
  return auditScheduleEstimateInputSchema.parse({
    projectId: "project",
    state: "paused",
    startUrl: "https://example.com/",
    cadence: "daily",
    timeZone: "Africa/Addis_Ababa",
    hour: 6,
    minute: 15,
    maxPages: 10,
    renderJavaScript: false,
    lighthouseStrategy: "none",
    maxCostMicrosPerRun: 0,
    maxCostMicrosPerUtcDay: 0,
    maxPagesPerUtcDay: 100,
    maxRunsPerUtcDay: 2,
    ...overrides,
  });
}
export async function testSchedule(
  repository: typeof AuditScheduleRepository,
  projectId = "project",
  actorScope = scope,
) {
  const schedule = await repository.save(
    actorScope,
    {
      ...scheduleInput({ projectId, state: "enabled" }),
      expectedVersion: 0,
      estimateFingerprint: "a".repeat(64),
    },
    {
      fingerprint: "a".repeat(64),
      policyFingerprint: await sha256Hex(JSON.stringify(policy)),
      nextDueAtMs: now,
      nowMs: now - 1,
      domain: "example.com",
    },
  );
  if (!schedule) throw new Error("Fixture schedule CAS failed");
  return schedule;
}
export async function testAttempt(
  repository: typeof AuditScheduleRepository,
  projectId = "project",
  actorScope = scope,
) {
  const schedule = await testSchedule(repository, projectId, actorScope);
  const attempt = await repository.admitSlot(
    schedule,
    {
      dueAtMs: now,
      nextDueAtMs: now + 86_400_000,
      firstMissedAtMs: now,
      lastMissedAtMs: now,
      missedCount: 1,
    },
    now,
  );
  if (!attempt) throw new Error("Fixture attempt admission failed");
  const claimed = await repository.claimAttempt(attempt.id, now);
  if (!claimed?.leaseToken) throw new Error("Fixture lease failed");
  return { ...claimed, leaseToken: claimed.leaseToken };
}

export function testEvidenceManifest(
  auditId: string,
  finalizedAtMs: number,
): AuditEvidenceManifest {
  const target = {
    startUrl: "https://example.com",
    config: {
      maxPages: 10,
      renderJavaScript: false,
      lighthouseStrategy: "none",
      sitePlatform: null,
    },
  } as const;
  return {
    schemaVersion: 1,
    engineVersion: "test-1",
    rulesetVersion: "test-1",
    normalizationVersion: "test-1",
    sourceScope: "bounded",
    projectId: "project",
    auditId,
    requested: target,
    effective: target,
    coverage: {
      state: "partial",
      stopReasons: ["frontier_remaining"],
      discoveredLowerBound: 3,
      pending: 1,
      attempted: 2,
      assessed: 2,
      errors: 0,
      blocked: 0,
      rateLimited: 0,
      unrenderedShell: 0,
      lighthouseAttempted: 0,
      lighthouseSucceeded: 0,
      lighthouseFailed: 0,
    },
    observedStartAtMs: now,
    observedEndAtMs: now + 1,
    finalizedAtMs,
    source: "plain_http",
    terminalStatus: "completed",
    requestedHash: "b".repeat(64),
    effectiveHash: "b".repeat(64),
    rowsHash: "c".repeat(64),
    artifact: { key: "test/evidence.json", sha256: "a".repeat(64) },
  };
}
