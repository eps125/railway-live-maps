import { describe, expect, it } from "vitest";
import {
  estimateHeldDelay,
  nextRunEstimate,
  type RunEstimateState,
  londonWallClockToInstant,
  parseCifAllowanceMinutes,
  scheduleDayOffset,
  type HeldDelayInput,
} from "./heldDelay.js";

const T0 = new Date("2026-11-02T14:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function input(overrides: Partial<HeldDelayInput>): HeldDelayInput {
  return {
    now: minutes(30),
    occupancyEnteredAt: T0,
    lastReport: {
      minutesLate: 5,
      actualAt: minutes(-2),
      kind: "departure",
      terminated: false,
      atThisBerthLocation: false,
    },
    timingPoint: null,
    atDestination: false,
    berthAllowanceMinutes: 1,
    allowancesAheadMinutes: 2,
    cancelled: false,
    feedGap: false,
    seenElsewhere: false,
    ...overrides,
  };
}

describe("estimateHeldDelay — ADR 0021 scenarios", () => {
  it("1: still at Lancaster at 15:48, booked away at 14:00, is 108 late", () => {
    expect(
      estimateHeldDelay(
        input({
          now: minutes(108),
          occupancyEnteredAt: minutes(-3),
          lastReport: {
            minutesLate: 0,
            actualAt: minutes(-1),
            kind: "arrival",
            terminated: false,
            atThisBerthLocation: true,
          },
          timingPoint: { kind: "departure", bookedAt: T0, atOrigin: false },
        }),
      ),
    ).toEqual({ kind: "estimate", minutesLate: 108, basis: "timing_point" });
  });

  it("2: 5 late into a 20-minute booked dwell, 30 minutes later, is 15 late", () => {
    // Booked arrival T0, departure T0+20; arrived (and reported) T0+5; now T0+35.
    expect(
      estimateHeldDelay(
        input({
          now: minutes(35),
          occupancyEnteredAt: minutes(5),
          lastReport: {
            minutesLate: 5,
            actualAt: minutes(5),
            kind: "arrival",
            terminated: false,
            atThisBerthLocation: true,
          },
          timingPoint: { kind: "departure", bookedAt: minutes(20), atOrigin: false },
        }),
      ),
    ).toEqual({ kind: "estimate", minutesLate: 15, basis: "timing_point" });
  });

  it("3: 5 late, held 30 minutes in a plain berth, is 32 late", () => {
    expect(estimateHeldDelay(input({}))).toEqual({
      kind: "estimate",
      minutesLate: 32,
      basis: "held_in_berth",
    });
  });

  it("4: held only 8 minutes gives 10 late — still an estimate, still on time", () => {
    expect(estimateHeldDelay(input({ now: minutes(8) }))).toEqual({
      kind: "estimate",
      minutesLate: 10,
      basis: "held_in_berth",
    });
  });

  it("5: an early freight in a loop before its booked departure changes nothing", () => {
    expect(
      estimateHeldDelay(
        input({
          now: minutes(-5),
          occupancyEnteredAt: minutes(-20),
          lastReport: {
            minutesLate: -10,
            actualAt: minutes(-21),
            kind: "arrival",
            terminated: false,
            atThisBerthLocation: false,
          },
          timingPoint: { kind: "departure", bookedAt: T0, atOrigin: false },
        }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("6 and 7: waiting at the origin is on time until the booked departure, then late", () => {
    const atOrigin = {
      occupancyEnteredAt: minutes(-40),
      lastReport: null,
      timingPoint: { kind: "departure" as const, bookedAt: T0, atOrigin: true },
    };
    expect(estimateHeldDelay(input({ ...atOrigin, now: minutes(-5) }))).toEqual({ kind: "none" });
    expect(estimateHeldDelay(input({ ...atOrigin, now: minutes(22) }))).toEqual({
      kind: "estimate",
      minutesLate: 22,
      basis: "timing_point",
    });
  });

  it("without any TRUST report, applies the booked departure only at the origin — PX 0133 / 1S75", () => {
    // Headcode set in a Preston berth for over an hour, no report since activation: nothing says
    // the service ever left Manchester Airport, so no estimate mid-route.
    expect(
      estimateHeldDelay(
        input({
          now: minutes(63),
          occupancyEnteredAt: minutes(-15),
          lastReport: null,
          timingPoint: { kind: "departure", bookedAt: T0, atOrigin: false },
        }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("8: a terminated train standing in the platform gets nothing", () => {
    expect(
      estimateHeldDelay(
        input({
          lastReport: {
            minutesLate: 3,
            actualAt: minutes(-10),
            kind: "arrival_destination",
            terminated: true,
            atThisBerthLocation: true,
          },
        }),
      ),
    ).toEqual({ kind: "blocked", reason: "terminated" });
    expect(estimateHeldDelay(input({ atDestination: true }))).toEqual({
      kind: "blocked",
      reason: "at_destination",
    });
  });

  it("10: a TRUST report from elsewhere after the train entered the berth ends the estimate", () => {
    expect(
      estimateHeldDelay(
        input({
          lastReport: {
            minutesLate: 12,
            actualAt: minutes(25),
            kind: "departure",
            terminated: false,
            atThisBerthLocation: false,
          },
        }),
      ),
    ).toEqual({ kind: "blocked", reason: "reported_since_entry" });
  });

  it("11: held before its first TRUST report, between timing points, gets nothing", () => {
    expect(estimateHeldDelay(input({ lastReport: null }))).toEqual({ kind: "none" });
  });

  it("12: the same headcode seen in another berth since — a likely missed step — gets nothing", () => {
    expect(estimateHeldDelay(input({ seenElsewhere: true }))).toEqual({
      kind: "blocked",
      reason: "seen_elsewhere",
    });
  });

  it("never estimates for a cancelled run or during a feed gap", () => {
    expect(estimateHeldDelay(input({ cancelled: true })).kind).toBe("blocked");
    expect(estimateHeldDelay(input({ feedGap: true })).kind).toBe("blocked");
  });

  it("never shows less than TRUST: a long allowance makes no estimate, not a lower one", () => {
    expect(estimateHeldDelay(input({ berthAllowanceMinutes: 60 }))).toEqual({ kind: "none" });
  });

  it("does not count a hold at a booked stop against the berth (rule 2 only there)", () => {
    // Booked to leave in 10 minutes: not late yet, however long it has stood.
    expect(
      estimateHeldDelay(
        input({ timingPoint: { kind: "departure", bookedAt: minutes(40), atOrigin: false } }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("uses whichever bound is worse at a booked pass", () => {
    expect(
      estimateHeldDelay(
        input({ timingPoint: { kind: "pass", bookedAt: minutes(-20), atOrigin: false } }),
      ),
    ).toEqual({ kind: "estimate", minutesLate: 50, basis: "timing_point" });
  });
});

describe("parseCifAllowanceMinutes", () => {
  it("reads whole and half minutes, and treats anything else as none", () => {
    expect(parseCifAllowanceMinutes("2")).toBe(2);
    expect(parseCifAllowanceMinutes("H")).toBe(0.5);
    expect(parseCifAllowanceMinutes("1H")).toBe(1.5);
    expect(parseCifAllowanceMinutes(" 3 ")).toBe(3);
    expect(parseCifAllowanceMinutes("")).toBe(0);
    expect(parseCifAllowanceMinutes(null)).toBe(0);
    expect(parseCifAllowanceMinutes("x")).toBe(0);
  });
});

describe("scheduleDayOffset", () => {
  it("puts a time after midnight on the next day, even where garner's flag says otherwise", () => {
    // Liverpool Lime St 23:35, Kirkby arr 23:59 dep 00:01 (flag false), Headbolt Lane 00:03 (flag true).
    expect(scheduleDayOffset(1, 23 * 60 + 35, false)).toBe(1);
    expect(scheduleDayOffset(3, 23 * 60 + 35, true)).toBe(1);
    expect(scheduleDayOffset(23 * 60 + 59, 23 * 60 + 35, false)).toBe(0);
    // A daytime train's evening times stay on its own day.
    expect(scheduleDayOffset(23 * 60 + 30, 5 * 60, false)).toBe(0);
  });
});

describe("londonWallClockToInstant", () => {
  it("converts in winter and summer", () => {
    expect(londonWallClockToInstant("2026-11-02", 14 * 60).toISOString()).toBe(
      "2026-11-02T14:00:00.000Z",
    );
    expect(londonWallClockToInstant("2026-07-01", 14 * 60).toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
  });

  it("9: an overnight time on the October clock-change night (25-hour day)", () => {
    // Traffic day 24 Oct, booked 00:20 next day (25 Oct, still BST at 00:20).
    expect(londonWallClockToInstant("2026-10-24", 20, 1).toISOString()).toBe(
      "2026-10-24T23:20:00.000Z",
    );
    // 03:00 on 25 Oct is after the change, so GMT.
    expect(londonWallClockToInstant("2026-10-25", 3 * 60).toISOString()).toBe(
      "2026-10-25T03:00:00.000Z",
    );
    // The repeated hour takes its first (BST) occurrence.
    expect(londonWallClockToInstant("2026-10-25", 90).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("handles the March change (23-hour day)", () => {
    expect(londonWallClockToInstant("2026-03-29", 3 * 60).toISOString()).toBe(
      "2026-03-29T02:00:00.000Z",
    );
    expect(londonWallClockToInstant("2026-03-29", 30).toISOString()).toBe(
      "2026-03-29T00:30:00.000Z",
    );
  });
});

describe("nextRunEstimate", () => {
  const held: RunEstimateState = {
    band: "severe",
    minutesLate: 108,
    basis: "timing_point",
    lastEstimatedAt: minutes(0),
  };

  it("records a change only when the band moves", () => {
    const first = nextRunEstimate(
      null,
      { kind: "estimate", minutesLate: 16, basis: "held_in_berth" },
      null,
      minutes(0),
    );
    expect(first.change).toMatchObject({ kind: "set", state: { band: "minor", minutesLate: 16 } });
    const same = nextRunEstimate(
      first.state,
      { kind: "estimate", minutesLate: 20, basis: "held_in_berth" },
      null,
      minutes(1),
    );
    expect(same.change).toBeNull();
    expect(same.state).toMatchObject({ minutesLate: 20, lastEstimatedAt: minutes(1) });
    const worse = nextRunEstimate(
      same.state,
      { kind: "estimate", minutesLate: 31, basis: "held_in_berth" },
      null,
      minutes(12),
    );
    expect(worse.change).toMatchObject({ kind: "set", state: { band: "moderate" } });
  });

  it("carries the estimate into the next berth until TRUST reports — the Lancaster departure", () => {
    const stepped = nextRunEstimate(held, { kind: "none" }, minutes(-5), minutes(1));
    expect(stepped).toEqual({ state: held, change: null });
    const reported = nextRunEstimate(held, { kind: "none" }, minutes(2), minutes(3));
    expect(reported).toEqual({ state: null, change: { kind: "cleared", reason: "reported" } });
  });

  it("clears at once when blocked, and stops carrying after the limit", () => {
    expect(
      nextRunEstimate(held, { kind: "blocked", reason: "terminated" }, null, minutes(1)).change,
    ).toEqual({ kind: "cleared", reason: "terminated" });
    expect(nextRunEstimate(held, { kind: "none" }, null, minutes(31)).change).toEqual({
      kind: "cleared",
      reason: "carry_expired",
    });
  });

  it("does nothing for a run that never had an estimate", () => {
    expect(nextRunEstimate(null, { kind: "blocked", reason: "feed_gap" }, null, T0)).toEqual({
      state: null,
      change: null,
    });
  });
});
