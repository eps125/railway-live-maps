import { describe, expect, it } from "vitest";
import { estimateHeldDelay } from "@railway/domain";
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
        plannedAt: null,
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
            plannedAt: null,
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
            plannedAt: null,
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

describe("buildHeldDelayInput — repeated visits to the same place (owner report 2026-10-26, PX 3S58)", () => {
  // 3S58 (H49507) on 26 October: Preston twice and Farington Curve Jn four times.
  const LOCS = [
    loc(1, "WIGANDD", "LO", { departure: "1703" }),
    loc(14, "FRNGTNC", "LI", { pass: "1818H" }),
    loc(16, "PRST", "LI", { arrival: "1824", departure: "1833" }),
    loc(19, "FRNGTNC", "LI", { pass: "1840" }),
    loc(20, "RUFDORD", "LI", { arrival: "1854", departure: "1858" }),
    loc(23, "FRNGTNC", "LI", { pass: "1943H" }),
    loc(25, "PRST", "LI", { arrival: "1948", departure: "2045" }),
    loc(28, "FRNGTNC", "LI", { pass: "2051H" }),
    loc(57, "WIGANDD", "LT", { arrival: "0053", nextDay: true }),
  ];
  const STANOXES = new Map([
    ["WIGANDD", "35150"],
    ["FRNGTNC", "30150"],
    ["PRST", "30120"],
    ["RUFDORD", "30155"],
  ]);
  const DEPARTURE_LATE = 1 | (2 << 3);
  const ARRIVAL_LATE = 2 | (2 << 3);
  const train: HeldTrainCandidate = { ...candidate, trafficDay: "2026-10-26", description: "3S58" };
  const context = (
    now: string,
    report: { stanox: string; flags: number; late: number; actual: string },
    berthStanox: string,
    planned: boolean,
  ): HeldDelayContext => ({
    now: new Date(now),
    trust: {
      trustId: "353S58CU26",
      latestReport: {
        locStanox: report.stanox,
        flags: report.flags,
        timetableVariation: report.late,
        actualAt: new Date(report.actual),
        plannedAt: planned
          ? new Date(new Date(report.actual).getTime() - report.late * 60_000)
          : null,
      },
      latestReceivedAt: new Date(report.actual),
      latestCancellation: null,
    },
    locations: LOCS,
    tiplocStanox: STANOXES,
    berthStanoxes: [berthStanox],
    berthAllowanceMinutes: 1,
    feedGapAreas: new Set(),
    sameDescriptionBerths: [],
  });

  for (const planned of [true, false]) {
    const label = planned ? "TRUST's planned time" : "actual time less lateness";
    it(`at Farington on the way back, measures from its third pass, not its first (${label})`, () => {
      // Last seen departing Farington 18:46, 6 late (its 18:40 pass); back at Farington at 19:56.
      const input = buildHeldDelayInput(
        { ...train, enteredAt: new Date("2026-10-26T19:56:21Z") },
        context(
          "2026-10-26T19:56:34Z",
          { stanox: "30150", flags: DEPARTURE_LATE, late: 6, actual: "2026-10-26T18:46:00Z" },
          "30150",
          planned,
        ),
      );
      expect(input.timingPoint?.bookedAt).toEqual(new Date("2026-10-26T19:43:30Z"));
      // Was 76 late against the 18:40 pass; 13 against the right one.
      expect(estimateHeldDelay(input)).toEqual({
        kind: "estimate",
        minutesLate: 13,
        basis: "timing_point",
      });
    });

    it(`in the Preston platform, waits for its 20:45 departure, not the 18:33 one (${label})`, () => {
      // Arrived at its second Preston call 20:03, 15 late; booked to wait until 20:45.
      const input = buildHeldDelayInput(
        { ...train, enteredAt: new Date("2026-10-26T20:02:00Z") },
        context(
          "2026-10-26T20:40:00Z",
          { stanox: "30120", flags: ARRIVAL_LATE, late: 15, actual: "2026-10-26T20:03:00Z" },
          "30120",
          planned,
        ),
      );
      expect(input.timingPoint?.bookedAt).toEqual(new Date("2026-10-26T20:45:00Z"));
      // Was about 127 late against 18:33; not late yet against 20:45.
      expect(estimateHeldDelay(input)).toEqual({ kind: "none" });
    });
  }

  it("never measures against a visit booked before the last report, whatever the report matched", () => {
    // A report at a place the schedule doesn't call at gives no visit to match; the berth's
    // earlier Preston call (18:33) is still ruled out by the 19:48 booked time of the report.
    const input = buildHeldDelayInput(
      { ...train, enteredAt: new Date("2026-10-26T20:02:00Z") },
      context(
        "2026-10-26T20:40:00Z",
        { stanox: "99999", flags: ARRIVAL_LATE, late: 15, actual: "2026-10-26T20:03:00Z" },
        "30120",
        true,
      ),
    );
    expect(input.timingPoint?.bookedAt).toEqual(new Date("2026-10-26T20:45:00Z"));
  });
});
