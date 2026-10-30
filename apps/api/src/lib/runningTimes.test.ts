import { describe, expect, it } from "vitest";
import { matchRunningToLocations, type RunMovementRow } from "./runningTimes.js";

const DEPARTURE = 1;
const ARRIVAL = 2;
const LATE = 2 << 3;

function movement(overrides: Partial<RunMovementRow>): RunMovementRow {
  return {
    loc_stanox: "11000",
    platform: null,
    actual_timestamp: new Date("2026-10-30T12:47:00Z"),
    planned_timestamp: new Date("2026-10-30T12:38:00Z"),
    timetable_variation: 9,
    flags: DEPARTURE | LATE,
    created: new Date("2026-10-30T12:47:30Z"),
    ...overrides,
  };
}

const call = (
  tiploc: string,
  arr: string | null,
  dep: string | null,
  pass: string | null = null,
) => ({
  tiploc,
  arrivalWorking: arr,
  departureWorking: dep,
  passWorking: pass,
});

describe("matchRunningToLocations (popup live running, 2026-10-30)", () => {
  it("puts a departure and an arrival at the calling point with their STANOX", () => {
    const result = matchRunningToLocations(
      [call("PRST", "1236", "1238"), call("LANCSTR", "1252", "1253")],
      [
        movement({ platform: "4" }),
        movement({
          loc_stanox: "12000",
          flags: ARRIVAL | LATE,
          planned_timestamp: new Date("2026-10-30T12:52:00Z"),
          actual_timestamp: new Date("2026-10-30T13:00:00Z"),
          timetable_variation: 8,
          created: new Date("2026-10-30T13:00:30Z"),
        }),
      ],
      new Map([
        ["PRST", "11000"],
        ["LANCSTR", "12000"],
      ]),
    );

    expect(result[0]).toEqual({
      arrival: null,
      departure: { actual: "2026-10-30T12:47:00.000Z", minutesLate: 9, platform: "4" },
    });
    expect(result[1]?.arrival).toEqual({
      actual: "2026-10-30T13:00:00.000Z",
      minutesLate: 8,
      platform: null,
    });
  });

  it("picks between two points sharing a STANOX by the closest booked time (GMT, so UTC = London)", () => {
    const result = matchRunningToLocations(
      [
        call("LOOPA", null, null, "1200"),
        call("MID", "1220", "1221"),
        call("LOOPB", null, null, "1240"),
      ],
      [movement({ loc_stanox: "9", planned_timestamp: new Date("2026-11-02T12:40:00Z") })],
      new Map([
        ["LOOPA", "9"],
        ["LOOPB", "9"],
      ]),
    );
    expect(result[0]).toBeNull();
    expect(result[2]?.departure?.minutesLate).toBe(9);
  });

  it("lets a later report (a TRUST correction) replace an earlier one for the same point", () => {
    const result = matchRunningToLocations(
      [call("PRST", "1236", "1238")],
      [
        movement({ timetable_variation: 12, created: new Date("2026-10-30T12:50:00Z") }),
        movement({ timetable_variation: 9, created: new Date("2026-10-30T12:48:00Z") }),
      ],
      new Map([["PRST", "11000"]]),
    );
    expect(result[0]?.departure?.minutesLate).toBe(12);
  });

  it("leaves out a report at a STANOX the schedule doesn't call at", () => {
    const result = matchRunningToLocations(
      [call("PRST", "1236", "1238")],
      [movement({ loc_stanox: "99999" })],
      new Map([["PRST", "11000"]]),
    );
    expect(result).toEqual([null]);
  });
});
