import {
  AuditScheduleRepository,
  scheduleSettings,
} from "../repositories/AuditScheduleRepository";
import { recoverScheduledAudit } from "./scheduledAuditRecovery";
import { coalesceAuditOccurrences } from "@/shared/audit-schedule";

/** A bounded round robin prevents one organization consuming every launch in a tick. */
function fair<T extends { organizationId: string }>(rows: T[]) {
  const organizations = new Map<string, T[]>();
  for (const row of rows) {
    const group = organizations.get(row.organizationId) ?? [];
    group.push(row);
    organizations.set(row.organizationId, group);
  }
  const result: T[] = [];
  while (result.length < rows.length)
    for (const group of organizations.values()) {
      const row = group.shift();
      if (row) result.push(row);
    }
  return result;
}

export async function runScheduledAudits() {
  const deadlineMs = Date.now() + 60_000;
  const counts = {
    recovered: 0,
    admitted: 0,
    running: 0,
    terminal: 0,
    deferred: 0,
    errors: 0,
  };
  let operations = 0;
  const recover = async (id: string) => {
    operations += 1;
    const outcome = await recoverScheduledAudit(id);
    if (outcome !== "unclaimed") counts[outcome] += 1;
  };
  // Recover all durable intents first, including archived and revoked projects.
  for (const attempt of fair(
    await AuditScheduleRepository.listRecoverable(Date.now(), 50),
  )) {
    // Reserve half the bounded tick for due work in other organizations.
    if (operations >= 5 || Date.now() >= deadlineMs) break;
    try {
      await recover(attempt.id);
      counts.recovered += 1;
    } catch {
      counts.errors += 1;
    }
  }
  if (operations < 10 && Date.now() < deadlineMs) {
    for (const schedule of fair(
      await AuditScheduleRepository.listDue(Date.now(), 50),
    )) {
      if (operations >= 10 || Date.now() >= deadlineMs) break;
      if (schedule.nextDueAtMs === null) continue;
      try {
        const settings = scheduleSettings(schedule);
        const slot = coalesceAuditOccurrences(
          {
            timeZone: settings.timeZone,
            hour: settings.hour,
            minute: settings.minute,
            ...(settings.cadence === "weekly"
              ? { cadence: "weekly", weekday: settings.weekday }
              : { cadence: "daily" }),
          },
          schedule.nextDueAtMs,
          Date.now(),
        );
        const attempt = await AuditScheduleRepository.admitSlot(
          schedule,
          slot,
          Date.now(),
        );
        if (!attempt) continue;
        counts.admitted += 1;
        await recover(attempt.id);
      } catch {
        counts.errors += 1;
      }
    }
  }
  console.info("Scheduled audit tick", counts);
  return counts;
}
