import { describe, expect, it } from "vitest";
import { popupDelay } from "./popupDelay.js";

const report = {
  minutesLate: 5,
  eventKind: "departure" as const,
  locationName: "Preston",
  at: "2026-10-26T17:30:00.000Z",
};
const standingSince = "2026-10-26T17:35:00.000Z";

describe("popupDelay", () => {
  it("shows TRUST's own lateness when nothing is estimated", () => {
    expect(
      popupDelay({ lastReport: report, live: { kind: "none" }, stored: null, standingSince }),
    ).toEqual({
      minutesLate: 5,
      band: "on_time",
      estimated: false,
      estimate: null,
      lastReport: report,
    });
  });

  it("shows the live estimate, marked estimated, with its working", () => {
    expect(
      popupDelay({
        lastReport: report,
        live: { kind: "estimate", minutesLate: 34, basis: "held_in_berth" },
        stored: { minutesLate: 31, basis: "held_in_berth", sameOccupancy: true },
        standingSince,
      }),
    ).toEqual({
      minutesLate: 34,
      band: "moderate",
      estimated: true,
      estimate: { basis: "held_in_berth", carried: false, standingSince },
      lastReport: report,
    });
  });

  it("shows a carried estimate from an earlier berth until TRUST reports", () => {
    expect(
      popupDelay({
        lastReport: report,
        live: { kind: "none" },
        stored: { minutesLate: 108, basis: "timing_point", sameOccupancy: false },
        standingSince,
      }),
    ).toMatchObject({
      minutesLate: 108,
      band: "severe",
      estimated: true,
      estimate: { carried: true, standingSince: null },
    });
  });

  it("drops a recorded estimate the live check says TRUST has already overtaken", () => {
    expect(
      popupDelay({
        lastReport: { ...report, minutesLate: 12 },
        live: { kind: "blocked", reason: "reported_since_entry" },
        stored: { minutesLate: 32, basis: "held_in_berth", sameOccupancy: true },
        standingSince,
      }),
    ).toMatchObject({ minutesLate: 12, estimated: false });
  });

  it("uses the recorded estimate in playback, where nothing is worked out live", () => {
    expect(
      popupDelay({
        lastReport: report,
        live: null,
        stored: { minutesLate: 42, basis: "held_in_berth", sameOccupancy: true },
        standingSince,
      }),
    ).toMatchObject({ minutesLate: 42, estimated: true, estimate: { carried: false } });
  });

  it("has nothing to say with no report and no estimate, and none for minutes TRUST didn't give", () => {
    expect(
      popupDelay({ lastReport: null, live: { kind: "none" }, stored: null, standingSince }),
    ).toBeNull();
    expect(
      popupDelay({
        lastReport: { ...report, minutesLate: null },
        live: null,
        stored: null,
        standingSince,
      }),
    ).toMatchObject({ minutesLate: null, band: "none", estimated: false });
  });
});

describe("popupDelay for non-admins (owner, 2026-10-26)", () => {
  it("keeps the delay and the Estimated mark but drops the explanation", () => {
    expect(
      popupDelay(
        {
          lastReport: report,
          live: { kind: "estimate", minutesLate: 72, basis: "held_in_berth" },
          stored: null,
          standingSince,
        },
        { withExplanation: false },
      ),
    ).toEqual({
      minutesLate: 72,
      band: "severe",
      estimated: true,
      estimate: null,
      lastReport: null,
    });
  });
});
