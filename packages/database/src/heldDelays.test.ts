import { describe, expect, it } from "vitest";
import {
  buildHeldDelayInput,
  type HeldDelayContext,
  type HeldTrainCandidate,
  type ScheduleLocationRow,
} from "./heldDelays.js";

const DEPARTURE_LATE = 1 | (2 << 3);
const ARRIVAL_ON_TIME = 2 | (1 << 3);
const ARRIVAL_DESTINATION_TERMINATED = 3 | (1 << 3) | 0x40;

function loc(
  seqNo: number,
  tiploc: string,
  recordIdentity: string,
  times: Partial<ScheduleLocationRow> = {},
): ScheduleLocationRow {
  return {
    seqNo,
    tiploc,
    recordIdentity,
    arrival: null,
    departure: null,
    pass: null,
    nextDay: false,
    engineeringAllowance: null,
    pathingAllowance: null,
    performanceAllowance: null,
    ...times,
  };
}

// Preston 13:30 → Ribble Jn (pass, 1½ min pathing) → Lancaster arr 13:58 dep 14:00 → Carlisle.
const LOCATIONS = [
  loc(1, "PRST", "LO", { departure: "1330" }),
  loc(2, "RIBBLEJ", "LI", { pass: "1332", pathingAllowance: "1H" }),
  loc(3, "NOSTANX", "LI", { pass: "1340", engineeringAllowance: "1" }),
  loc(4, "LANCSTR", "LI", { arrival: "1358", departure: "1400" }),
  loc(5, "CARLILE", "LT", { arrival: "1500" }),
];
const STANOX = new Map([
  ["PRST", "32530"],
  ["RIBBLEJ", "32510"],
  ["LANCSTR", "31531"],
  ["CARLILE", "86520"],
]);

const candidate: HeldTrainCandidate = {
  tdArea: "PX",
  berth: "0101",
  description: "1S66",
  occupancyId: "1",
  enteredAt: new Date("2026-11-02T13:55:00Z"),
  runKey: "7",
  matchConfidence: "solid",
  cifScheduleId: "42",
  trafficDay: "2026-11-02",
  trustId: "321S66MO02",
  activatedAt: new Date("2026-11-02T12:30:00Z"),
};

function ctx(overrides: Partial<HeldDelayContext> = {}): HeldDelayContext {
  return {
    now: new Date("2026-11-02T15:48:00Z"),
    trust: {
      trustId: candidate.trustId,
      latestReport: {
        locStanox: "32510",
        flags: DEPARTURE_LATE,
        timetableVariation: 5,
        actualAt: new Date("2026-11-02T13:37:00Z"),
      },
      latestReceivedAt: new Date("2026-11-02T13:37:20Z"),
      latestCancellation: null,
    },
    locations: LOCATIONS,
    tiplocStanox: STANOX,
    berthStanoxes: ["31531"],
    berthAllowanceMinutes: 1,
    feedGapAreas: new Set(),
    sameDescriptionBerths: [],
    ...overrides,
  };
}

describe("buildHeldDelayInput", () => {
  it("finds the berth's booked departure after the last report — Lancaster at 14:00 GMT", () => {
    const input = buildHeldDelayInput(candidate, ctx());
    expect(input.timingPoint).toEqual({
      kind: "departure",
      bookedAt: new Date("2026-11-02T14:00:00Z"),
      atOrigin: false,
    });
    expect(input.atDestination).toBe(false);
    expect(input.lastReport).toMatchObject({
      minutesLate: 5,
      kind: "departure",
      atThisBerthLocation: false,
    });
  });

  it("counts allowances from the last reported point up to the next point TRUST reports at", () => {
    // Reported departing Ribble Jn (1½ pathing), then NOSTANX (1 engineering, no STANOX), then
    // Lancaster has a STANOX: 2½ minutes still ahead.
    expect(buildHeldDelayInput(candidate, ctx()).allowancesAheadMinutes).toBe(2.5);
  });

  it("knows the train is still at its arrival station and that this is its own location", () => {
    const input = buildHeldDelayInput(
      candidate,
      ctx({
        trust: {
          ...ctx().trust!,
          latestReport: {
            locStanox: "31531",
            flags: ARRIVAL_ON_TIME,
            timetableVariation: 0,
            actualAt: new Date("2026-11-02T13:58:00Z"),
          },
        },
      }),
    );
    expect(input.lastReport).toMatchObject({ kind: "arrival", atThisBerthLocation: true });
    expect(input.timingPoint?.bookedAt).toEqual(new Date("2026-11-02T14:00:00Z"));
  });

  it("flags a berth at the destination, and a terminated report", () => {
    const input = buildHeldDelayInput(
      candidate,
      ctx({
        berthStanoxes: ["86520"],
        trust: {
          ...ctx().trust!,
          latestReport: {
            locStanox: "86520",
            flags: ARRIVAL_DESTINATION_TERMINATED,
            timetableVariation: 0,
            actualAt: new Date("2026-11-02T15:00:00Z"),
          },
        },
      }),
    );
    expect(input.atDestination).toBe(true);
    expect(input.timingPoint).toBeNull();
    expect(input.lastReport?.terminated).toBe(true);
  });

  it("has no timing point for a plain berth with no SMART location", () => {
    expect(buildHeldDelayInput(candidate, ctx({ berthStanoxes: [] })).timingPoint).toBeNull();
  });

  it("puts a booked time after midnight on the next day", () => {
    const overnight = [
      loc(1, "PRST", "LO", { departure: "2335" }),
      loc(2, "LANCSTR", "LI", { arrival: "2359", departure: "0001" }),
    ];
    const input = buildHeldDelayInput(candidate, ctx({ locations: overnight, trust: undefined }));
    expect(input.timingPoint?.bookedAt).toEqual(new Date("2026-11-03T00:01:00Z"));
  });

  it("sets the guards: cancellation in force, feed gap, same headcode seen elsewhere since", () => {
    const input = buildHeldDelayInput(
      candidate,
      ctx({
        trust: { ...ctx().trust!, latestCancellation: { type: "EN ROUTE", reinstate: 0 } },
        feedGapAreas: new Set(["PX"]),
        sameDescriptionBerths: [
          { tdArea: "PX", berth: "0101", eventAt: new Date("2026-11-02T15:00:00Z") },
          { tdArea: "PX", berth: "0105", eventAt: new Date("2026-11-02T14:10:00Z") },
        ],
      }),
    );
    expect(input).toMatchObject({ cancelled: true, feedGap: true, seenElsewhere: true });

    const reinstatedAndQuiet = buildHeldDelayInput(
      candidate,
      ctx({
        trust: { ...ctx().trust!, latestCancellation: { type: null, reinstate: 1 } },
        sameDescriptionBerths: [
          { tdArea: "PX", berth: "0105", eventAt: new Date("2026-11-02T13:00:00Z") },
        ],
      }),
    );
    expect(reinstatedAndQuiet).toMatchObject({
      cancelled: false,
      feedGap: false,
      seenElsewhere: false,
    });
  });
});
