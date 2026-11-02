import { NonRetryableError } from "cloudflare:workflows";
import { AuditScheduleRepository } from "../repositories/AuditScheduleRepository";
import { usesBetterAuthServer } from "@/server/lib/runtime-env";

/** Called inside each network-bearing durable step, so replays check live authority. */
export async function assertAuditExecutionAllowed(
  auditId: string,
  scheduledAttemptId?: string,
) {
  if (!scheduledAttemptId) return;
  if (
    scheduledAttemptId !== auditId ||
    !(await usesBetterAuthServer()) ||
    !(await AuditScheduleRepository.executionAllowed(
      scheduledAttemptId,
      Date.now(),
    ))
  ) {
    throw new NonRetryableError(
      "Scheduled audit execution is no longer authorized.",
    );
  }
}
