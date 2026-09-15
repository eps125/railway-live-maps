import { describe, expect, it } from "vitest";
import {
  selectEffectiveSchedule,
  candidatesRunningOnAny,
  selectEffectiveScheduleAcrossDates,
  type ScheduleCandidate,
} from "./resolveStpPrecedence.js";

function candidate(overrides: Partial<ScheduleCandidate>): ScheduleCandidate {
  return {
    stpIndicator: "P",
    scheduleStartDate: "2026-01-01",
    scheduleEndDate: "2026-12-31",
    daysRunsBitmask: "1111111",
    ...overrides,
  };
}

// 2026-08-10 is a Monday.
const A_MONDAY = "2026-08-10";

describe("selectEffectiveSchedule", () => {
  it("a single Permanent schedule matches when nothing overlays it", () => {
    const p = candidate({ stpIndicator: "P" });
    const result = selectEffectiveSchedule([p], A_MONDAY);
    expect(result).toEqual({ outcome: "matched", selected: p });
  });

  it("an Overlay beats the Permanent schedule it overlays", () => {
    const p = candidate({ stpIndicator: "P" });
    const o = candidate({ stpIndicator: "O" });
    const result = selectEffectiveSchedule([p, o], A_MONDAY);
    expect(result).toEqual({ outcome: "matched", selected: o });
  });

  it("a Cancellation beats everything, including an Overlay", () => {
    const o = candidate({ stpIndicator: "O" });
    const c = candidate({ stpIndicator: "C" });
    const result = selectEffectiveSchedule([o, c], A_MONDAY);
    expect(result).toEqual({ outcome: "matched", selected: c });
  });

  it("a New schedule matches when there is no Permanent schedule", () => {
    const n = candidate({ stpIndicator: "N" });
    const result = selectEffectiveSchedule([n], A_MONDAY);
    expect(result).toEqual({ outcome: "matched", selected: n });
  });

  it("two same-precedence candidates that both match is reported ambiguous, never picked arbitrarily", () => {
    const p1 = candidate({ stpIndicator: "P" });
    const p2 = candidate({ stpIndicator: "P" });
    const result = selectEffectiveSchedule([p1, p2], A_MONDAY);
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome === "ambiguous") {
      expect(result.candidates).toEqual([p1, p2]);
    }
  });

  it("reports none when no candidate's date range covers the service date", () => {
    const p = candidate({ scheduleStartDate: "2020-01-01", scheduleEndDate: "2020-12-31" });
    const result = selectEffectiveSchedule([p], A_MONDAY);
    expect(result).toEqual({ outcome: "none" });
  });

  it("reports none when the day-of-week bit isn't set", () => {
    // Sunday bit (index 6) is off; A_MONDAY is a Monday (index 0).
    const p = candidate({ daysRunsBitmask: "1111110" });
    const result = selectEffectiveSchedule([p], A_MONDAY);
    expect(result).toEqual({ outcome: "matched", selected: p });

    const sundayOnly = candidate({ daysRunsBitmask: "0000001" });
    expect(selectEffectiveSchedule([sundayOnly], A_MONDAY)).toEqual({ outcome: "none" });
  });

  it("a missing days-runs bitmask is treated as matching every day, not silently excluded", () => {
    const p = candidate({ daysRunsBitmask: null });
    const result = selectEffectiveSchedule([p], A_MONDAY);
    expect(result).toEqual({ outcome: "matched", selected: p });
  });
});

// 2026-08-09 is a Sunday, the day before A_MONDAY.
const SUNDAY_BEFORE = "2026-08-09";

describe("candidatesRunningOnAny / selectEffectiveScheduleAcrossDates (docs/adr/0008)", () => {
  it("tags a candidate with the first (most-preferred) date it runs on among several probed", () => {
    const p = candidate({});
    const result = candidatesRunningOnAny([p], [A_MONDAY, SUNDAY_BEFORE]);
    expect(result).toEqual([{ candidate: p, serviceDate: A_MONDAY }]);
  });

  it("falls through to a later probed date when the candidate doesn't run on the first", () => {
    const sundayOnly = candidate({ daysRunsBitmask: "0000001" });
    const result = candidatesRunningOnAny([sundayOnly], [A_MONDAY, SUNDAY_BEFORE]);
    expect(result).toEqual([{ candidate: sundayOnly, serviceDate: SUNDAY_BEFORE }]);
  });

  it("omits a candidate that runs on neither probed date", () => {
    const neither = candidate({ daysRunsBitmask: "0000000" });
    expect(candidatesRunningOnAny([neither], [A_MONDAY, SUNDAY_BEFORE])).toEqual([]);
  });

  it("selectEffectiveScheduleAcrossDates picks the STP winner across the whole multi-date pool", () => {
    const p = candidate({ stpIndicator: "P" });
    const o = candidate({ stpIndicator: "O", daysRunsBitmask: "0000001" }); // Sunday only
    const result = selectEffectiveScheduleAcrossDates([p, o], [A_MONDAY, SUNDAY_BEFORE]);
    expect(result).toEqual({
      outcome: "matched",
      selected: { candidate: o, serviceDate: SUNDAY_BEFORE },
    });
  });
});
