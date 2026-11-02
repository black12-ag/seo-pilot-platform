import { describe, expect, it } from "vitest";
import {
  nextAuditOccurrences,
  coalesceAuditOccurrences,
  type AuditCalendarSchedule,
} from "./audit-schedule";

const daily: AuditCalendarSchedule = {
  cadence: "daily",
  timeZone: "Africa/Addis_Ababa",
  hour: 6,
  minute: 15,
};

function occurrences(schedule: AuditCalendarSchedule, after: string): string[] {
  return nextAuditOccurrences(schedule, Date.parse(after)).map((ms) =>
    new Date(ms).toISOString(),
  );
}

describe("nextAuditOccurrences", () => {
  it("returns exactly three future EAT slots, skipping the exact elapsed slot", () => {
    expect(occurrences(daily, "2026-11-02T03:15:00Z")).toEqual([
      "2026-11-03T03:15:00.000Z",
      "2026-11-04T03:15:00.000Z",
      "2026-11-05T03:15:00.000Z",
    ]);
  });

  it("includes a slot one millisecond in the future", () => {
    expect(occurrences(daily, "2026-11-02T03:14:59.999Z")[0]).toBe(
      "2026-11-02T03:15:00.000Z",
    );
  });

  it("handles UTC year rollover and a leap day without a previous anchor", () => {
    const schedule = { ...daily, timeZone: "UTC", hour: 0, minute: 0 };
    expect(occurrences(schedule, "2027-12-31T23:59:59.999Z")).toEqual([
      "2028-01-01T00:00:00.000Z",
      "2028-01-02T00:00:00.000Z",
      "2028-01-03T00:00:00.000Z",
    ]);
    expect(occurrences(schedule, "2028-02-28T00:00:00Z")).toEqual([
      "2028-02-29T00:00:00.000Z",
      "2028-03-01T00:00:00.000Z",
      "2028-03-02T00:00:00.000Z",
    ]);
  });

  it("selects the local weekday even when UTC is still Sunday", () => {
    expect(
      occurrences(
        { ...daily, cadence: "weekly", weekday: 1, hour: 0, minute: 15 },
        "2026-11-01T20:00:00Z",
      ),
    ).toEqual([
      "2026-11-01T21:15:00.000Z",
      "2026-11-08T21:15:00.000Z",
      "2026-11-15T21:15:00.000Z",
    ]);
  });

  it("supports quarter-hour offsets and resuming years later", () => {
    expect(
      occurrences(
        { ...daily, timeZone: "Asia/Kathmandu", hour: 0, minute: 0 },
        "2099-12-31T18:15:00Z",
      ),
    ).toEqual([
      "2100-01-01T18:15:00.000Z",
      "2100-01-02T18:15:00.000Z",
      "2100-01-03T18:15:00.000Z",
    ]);
  });

  it.each([
    [
      "America/New_York",
      "2026-03-07T12:00:00Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ],
    [
      "Europe/Berlin",
      "2026-03-28T12:00:00Z",
      "2026-03-29T01:00:00.000Z",
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
    ],
  ])(
    "uses the first valid minute of a spring gap in %s",
    (timeZone, after, ...expected) => {
      expect(
        occurrences({ ...daily, timeZone, hour: 2, minute: 30 }, after),
      ).toEqual(expected);
    },
  );

  it.each([
    [
      "America/New_York",
      1,
      "2026-10-31T12:00:00Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "2026-11-03T06:30:00.000Z",
    ],
    [
      "Europe/Berlin",
      2,
      "2026-10-24T12:00:00Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
      "2026-10-27T01:30:00.000Z",
    ],
  ])(
    "chooses the earlier fall-fold instant once in %s",
    (timeZone, hour, after, ...expected) => {
      expect(
        occurrences({ ...daily, timeZone, hour, minute: 30 }, after),
      ).toEqual(expected);
    },
  );

  it.each([
    "2026-11-01T05:30:00Z",
    "2026-11-01T05:45:00Z",
    "2026-11-01T06:15:00Z",
    "2026-11-01T06:45:00Z",
  ])("never emits the second New York fold when resuming at %s", (after) => {
    expect(
      occurrences(
        { ...daily, timeZone: "America/New_York", hour: 1, minute: 30 },
        after,
      )[0],
    ).toBe("2026-11-02T06:30:00.000Z");
  });

  it("keeps Sunday weekly intent across the US spring transition", () => {
    expect(
      occurrences(
        {
          ...daily,
          cadence: "weekly",
          weekday: 0,
          timeZone: "America/New_York",
          hour: 2,
          minute: 30,
        },
        "2026-03-01T07:30:00Z",
      ),
    ).toEqual([
      "2026-03-08T07:00:00.000Z",
      "2026-03-15T06:30:00.000Z",
      "2026-03-22T06:30:00.000Z",
    ]);
  });

  it("resumes after the first European weekly fold without running the second", () => {
    expect(
      occurrences(
        {
          ...daily,
          cadence: "weekly",
          weekday: 0,
          timeZone: "Europe/Berlin",
          hour: 2,
          minute: 30,
        },
        "2026-10-25T00:45:00Z",
      ),
    ).toEqual([
      "2026-11-01T01:30:00.000Z",
      "2026-11-08T01:30:00.000Z",
      "2026-11-15T01:30:00.000Z",
    ]);
  });

  it("resolves a half-hour spring gap and restores the selected minute next day", () => {
    expect(
      occurrences(
        { ...daily, timeZone: "Australia/Lord_Howe", hour: 2, minute: 15 },
        "2026-10-03T00:00:00Z",
      ),
    ).toEqual([
      "2026-10-03T15:30:00.000Z",
      "2026-10-04T15:15:00.000Z",
      "2026-10-05T15:15:00.000Z",
    ]);
  });

  it("does not repeat the half-hour fall fold", () => {
    expect(
      occurrences(
        { ...daily, timeZone: "Australia/Lord_Howe", hour: 1, minute: 45 },
        "2026-04-04T15:00:00Z",
      )[0],
    ).toBe("2026-04-05T15:15:00.000Z");
  });

  it("coalesces a skipped civil date into the first valid minute without duplicates", () => {
    expect(
      occurrences(
        { ...daily, timeZone: "Pacific/Apia", hour: 0, minute: 0 },
        "2011-12-29T10:00:00Z",
      ),
    ).toEqual([
      "2011-12-30T10:00:00.000Z",
      "2011-12-31T10:00:00.000Z",
      "2012-01-01T10:00:00.000Z",
    ]);
  });

  it("maps a skipped Friday weekly slot to the first valid minute after the date jump", () => {
    expect(
      occurrences(
        {
          ...daily,
          cadence: "weekly",
          weekday: 5,
          timeZone: "Pacific/Apia",
          hour: 9,
          minute: 0,
        },
        "2011-12-29T10:00:00Z",
      ),
    ).toEqual([
      "2011-12-30T10:00:00.000Z",
      "2012-01-05T19:00:00.000Z",
      "2012-01-12T19:00:00.000Z",
    ]);
  });

  it("keeps daily slots at least 23 hours apart across the US spring change", () => {
    const slots = nextAuditOccurrences(
      { ...daily, timeZone: "America/New_York", hour: 9, minute: 0 },
      Date.parse("2026-03-07T00:00:00Z"),
    );
    expect(slots.map((ms) => new Date(ms).toISOString())).toEqual([
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
    ]);
    expect(slots[1] - slots[0]).toBe(23 * 3_600_000);
    expect(slots[2] - slots[1]).toBe(24 * 3_600_000);
  });

  it("preserves local minute zero with a historical seconds offset", () => {
    expect(
      occurrences(
        { ...daily, timeZone: "Africa/Monrovia", hour: 9, minute: 0 },
        "1970-01-01T00:00:00Z",
      ),
    ).toEqual([
      "1970-01-01T09:44:30.000Z",
      "1970-01-02T09:44:30.000Z",
      "1970-01-03T09:44:30.000Z",
    ]);
  });

  it("uses a full valid minute after a historical gap ending mid-minute", () => {
    expect(
      occurrences(
        { ...daily, timeZone: "Africa/Monrovia", hour: 0, minute: 15 },
        "1972-01-07T00:00:00Z",
      ),
    ).toEqual([
      "1972-01-07T00:45:00.000Z",
      "1972-01-08T00:15:00.000Z",
      "1972-01-09T00:15:00.000Z",
    ]);
  });

  it.each([
    ["0099-12-31T23:59:59Z", "0100-01-01T00:00:00.000Z"],
    ["0000-12-31T23:59:59Z", "0001-01-01T00:00:00.000Z"],
    ["+012000-12-31T23:59:59Z", "+012001-01-01T00:00:00.000Z"],
  ])(
    "uses Gregorian calendar years without Date.UTC's 1900 adjustment at %s",
    (after, first) => {
      expect(
        occurrences(
          { ...daily, timeZone: "UTC", hour: 0, minute: 0 },
          after,
        )[0],
      ).toBe(first);
    },
  );
});

describe("nextAuditOccurrences validation and Date range", () => {
  it.each([
    NaN,
    Infinity,
    -Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    8_640_000_000_000_001,
    -8_640_000_000_000_001,
  ])("rejects invalid epoch %s", (afterMs) => {
    expect(() => nextAuditOccurrences(daily, afterMs)).toThrow();
  });

  it.each([
    { cadence: "monthly" },
    { timeZone: "Not/A_Zone" },
    { timeZone: "+03:00" },
    { timeZone: undefined },
    { hour: -1 },
    { hour: 24 },
    { hour: 1.5 },
    { hour: NaN },
    { minute: -1 },
    { minute: 60 },
    { minute: Infinity },
    { minute: 1.5 },
    { cadence: "weekly" },
    { cadence: "weekly", weekday: -1 },
    { cadence: "weekly", weekday: 7 },
    { cadence: "weekly", weekday: 1.5 },
    { weekday: 7 },
    { unexpected: true },
  ])("rejects invalid schedule %j", (patch) => {
    // Reflect passes malformed wire input without weakening the typed contract.
    expect(() => {
      Reflect.apply(nextAuditOccurrences, undefined, [
        { ...daily, ...patch },
        Date.parse("2026-11-02T00:00:00Z"),
      ]);
    }).toThrow();
  });

  it.each([
    [
      "Etc/GMT+12",
      12,
      "-271821-04-21T00:00:00.000Z",
      "-271821-04-22T00:00:00.000Z",
      "-271821-04-23T00:00:00.000Z",
    ],
    [
      "Etc/GMT-12",
      0,
      "-271821-04-20T12:00:00.000Z",
      "-271821-04-21T12:00:00.000Z",
      "-271821-04-22T12:00:00.000Z",
    ],
  ])(
    "supports representable future slots at the lower Date boundary in %s",
    (timeZone, hour, ...expected) => {
      expect(
        nextAuditOccurrences(
          { ...daily, timeZone, hour, minute: 0 },
          -8_640_000_000_000_000,
        ).map((ms) => new Date(ms).toISOString()),
      ).toEqual(expected);
    },
  );

  it("fails clearly when three future Date instants cannot be represented", () => {
    expect(() => nextAuditOccurrences(daily, 8_640_000_000_000_000)).toThrow(
      RangeError,
    );
  });
});

describe("bounded missed slots", () => {
  it("coalesces short outages to one latest slot with an exact count", () => {
    const first = Date.parse("2026-01-01T03:15:00Z");
    expect(
      coalesceAuditOccurrences(
        daily,
        first,
        Date.parse("2026-01-05T12:00:00Z"),
      ),
    ).toEqual({
      dueAtMs: Date.parse("2026-01-05T03:15:00Z"),
      nextDueAtMs: Date.parse("2026-01-06T03:15:00Z"),
      firstMissedAtMs: first,
      lastMissedAtMs: Date.parse("2026-01-05T03:15:00Z"),
      missedCount: 5,
    });
  });
  it("keeps years of downtime bounded and reports count unavailable", () => {
    const first = Date.parse("2000-01-01T03:15:00Z");
    const result = coalesceAuditOccurrences(
      daily,
      first,
      Date.parse("2099-01-05T12:00:00Z"),
    );
    expect(result).toMatchObject({
      firstMissedAtMs: first,
      lastMissedAtMs: Date.parse("2099-01-05T03:15:00Z"),
      missedCount: null,
    });
    expect(result.nextDueAtMs).toBe(Date.parse("2099-01-06T03:15:00Z"));
  });
  it("does not count the repeated DST wall minute twice", () => {
    const schedule = {
      cadence: "daily",
      timeZone: "America/New_York",
      hour: 1,
      minute: 30,
    } as const;
    expect(
      coalesceAuditOccurrences(
        schedule,
        Date.parse("2026-11-01T05:30:00Z"),
        Date.parse("2026-11-01T06:45:00Z"),
      ),
    ).toMatchObject({
      dueAtMs: Date.parse("2026-11-01T05:30:00Z"),
      missedCount: 1,
    });
  });
});
