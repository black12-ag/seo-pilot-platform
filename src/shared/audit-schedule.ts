import { z } from "zod";
import { timeZoneSchema } from "@/types/schemas/schedule-time";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DATE_LIMIT_MS = 8_640_000_000_000_000;
const weekday = z.number().int().min(0).max(6);
const fields = {
  timeZone: timeZoneSchema.refine(
    (value) => !/^[+-]/.test(value),
    "Use an IANA timezone name, not a fixed offset",
  ),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
};
export const auditCalendarSchema = z.discriminatedUnion("cadence", [
  z.strictObject({
    ...fields,
    cadence: z.literal("daily"),
    weekday: weekday.optional(),
  }),
  z.strictObject({ ...fields, cadence: z.literal("weekly"), weekday }),
]);

/** Weekdays use the local calendar: 0 = Sunday, 6 = Saturday. */
export type AuditCalendarSchedule = z.infer<typeof auditCalendarSchema>;

function wallTimeMs(formatter: Intl.DateTimeFormat, instant: number): number {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let beforeCommonEra = false;
  for (const part of formatter.formatToParts(instant)) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value) - 1;
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      case "era":
        beforeCommonEra = part.value === "BC";
        break;
    }
  }
  const date = new Date(0);
  // Shift toward the epoch so local dates just outside Date limits still work.
  const fullYear = beforeCommonEra ? 1 - year : year;
  const shift = fullYear < 1970 ? 1 : -1;
  date.setUTCFullYear(fullYear, month, day + shift);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime() - shift * DAY_MS;
}

function occurrenceOnDay(
  formatter: Intl.DateTimeFormat,
  day: number,
  minuteOfDay: number,
): number | undefined {
  const target = day + minuteOfDay * MINUTE_MS;
  // Most slots have an exact wall minute. Sample offsets across the same
  // bounded transition window; gaps retain the exhaustive fallback below.
  const candidates = new Set<number>();
  for (
    let offset = -DAY_MS;
    offset <= 2 * DAY_MS;
    offset += 6 * 60 * MINUTE_MS
  ) {
    const sample = Math.max(
      -DATE_LIMIT_MS,
      Math.min(DATE_LIMIT_MS, day + offset),
    );
    const candidate = target - (wallTimeMs(formatter, sample) - sample);
    if (
      Math.abs(candidate) <= DATE_LIMIT_MS &&
      wallTimeMs(formatter, candidate) === target
    )
      candidates.add(candidate);
  }
  if (candidates.size) return Math.min(...candidates);
  let firstWallMinute = Infinity;
  let firstInstant: number | undefined;
  // IANA offsets and civil-date jumps fit within this bounded 72-hour window.
  // Sweep UTC so a repeated local minute always resolves to its earlier instant.
  const start = Math.max(-DATE_LIMIT_MS, day - DAY_MS);
  const end = Math.min(DATE_LIMIT_MS, day + 2 * DAY_MS);
  for (let instant = start; instant <= end; instant += MINUTE_MS) {
    const wall = wallTimeMs(formatter, instant);
    const minute = Math.floor(wall / MINUTE_MS) * MINUTE_MS;
    if (minute < target || minute >= firstWallMinute) continue;
    // Historical IANA offsets can include seconds; align to local second zero.
    const candidate = instant - (wall - minute);
    if (Math.abs(candidate) > DATE_LIMIT_MS) continue;
    if (wallTimeMs(formatter, candidate) !== minute) continue;
    if (minute === target) return candidate;
    firstWallMinute = minute;
    firstInstant = candidate;
  }
  return firstInstant;
}

/**
 * Next three strictly future UTC epoch milliseconds, with no implicit clock.
 * Gaps use the first valid minute after the gap; folds use the earlier instant
 * once, even when resuming between the two instants. Skipped civil dates coalesce.
 * Throws for invalid input or insufficient representable future Date instants.
 */
export function nextAuditOccurrences(
  schedule: AuditCalendarSchedule,
  afterMs: number,
): [number, number, number] {
  const input = auditCalendarSchema.parse(schedule);
  if (!Number.isSafeInteger(afterMs) || Math.abs(afterMs) > DATE_LIMIT_MS) {
    throw new RangeError(
      "afterMs must be a safe integer within the Date range",
    );
  }
  const formatter = calendarFormatter(input.timeZone);
  const localNow = wallTimeMs(formatter, afterMs);
  const today = Math.floor(localNow / DAY_MS) * DAY_MS;
  const slots: number[] = [];
  // Three weekly slots need at most 21 days; leave room for a skipped date.
  for (let daysAhead = 0; daysAhead < 32; daysAhead += 1) {
    const day = today + daysAhead * DAY_MS;
    if (!Number.isFinite(day) || day > DATE_LIMIT_MS) break;
    if (
      input.cadence === "weekly" &&
      (((day / DAY_MS + 4) % 7) + 7) % 7 !== input.weekday
    )
      continue;
    const instant = occurrenceOnDay(
      formatter,
      day,
      input.hour * 60 + input.minute,
    );
    if (instant === undefined || instant <= (slots.at(-1) ?? afterMs)) continue;
    slots.push(instant);
    if (slots.length === 3) return [slots[0], slots[1], slots[2]];
  }
  throw new RangeError("Cannot represent three future audit occurrences");
}

function calendarFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

/** Coalesce an outage in bounded work, preserving unknown long-gap counts. */
export function coalesceAuditOccurrences(
  schedule: AuditCalendarSchedule,
  firstDueAtMs: number,
  nowMs: number,
) {
  const input = auditCalendarSchema.parse(schedule);
  if (
    !Number.isSafeInteger(firstDueAtMs) ||
    !Number.isSafeInteger(nowMs) ||
    firstDueAtMs < 0 ||
    nowMs < firstDueAtMs ||
    nowMs > DATE_LIMIT_MS
  )
    throw new RangeError("Invalid due window");
  const formatter = calendarFormatter(input.timeZone);
  const today = Math.floor(wallTimeMs(formatter, nowMs) / DAY_MS) * DAY_MS;
  let dueAtMs = firstDueAtMs;
  for (let back = 0; back < 16; back++) {
    const day = today - back * DAY_MS;
    if (
      input.cadence === "weekly" &&
      (((day / DAY_MS + 4) % 7) + 7) % 7 !== input.weekday
    )
      continue;
    const candidate = occurrenceOnDay(
      formatter,
      day,
      input.hour * 60 + input.minute,
    );
    if (candidate !== undefined && candidate <= nowMs) {
      dueAtMs = Math.max(firstDueAtMs, candidate);
      break;
    }
  }
  const firstDay =
    Math.floor(wallTimeMs(formatter, firstDueAtMs) / DAY_MS) * DAY_MS;
  let missedCount: number | null = null;
  if (today - firstDay <= 32 * DAY_MS) {
    const slots = new Set<number>();
    for (let day = firstDay; day <= today; day += DAY_MS) {
      if (
        input.cadence === "weekly" &&
        (((day / DAY_MS + 4) % 7) + 7) % 7 !== input.weekday
      )
        continue;
      const candidate = occurrenceOnDay(
        formatter,
        day,
        input.hour * 60 + input.minute,
      );
      if (
        candidate !== undefined &&
        candidate >= firstDueAtMs &&
        candidate <= dueAtMs
      )
        slots.add(candidate);
    }
    missedCount = slots.size || null;
  }
  return {
    dueAtMs,
    nextDueAtMs: nextAuditOccurrences(input, nowMs)[0],
    firstMissedAtMs: firstDueAtMs,
    lastMissedAtMs: dueAtMs,
    missedCount,
  };
}
