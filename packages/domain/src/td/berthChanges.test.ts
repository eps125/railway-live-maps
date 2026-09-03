import { describe, expect, it } from "vitest";
import { berthChangesForEvent } from "./berthChanges.js";

describe("berthChangesForEvent", () => {
  it("CA yields a clear for `from` and an update for `to`", () => {
    expect(
      berthChangesForEvent({
        messageType: "CA",
        tdArea: "PX",
        fromBerth: "0193",
        toBerth: "0195",
        description: "4S45",
        eventAt: "2026-09-03T10:00:00.000Z",
      }),
    ).toEqual([
      { tdArea: "PX", berth: "0193", description: null, eventAt: "2026-09-03T10:00:00.000Z" },
      { tdArea: "PX", berth: "0195", description: "4S45", eventAt: "2026-09-03T10:00:00.000Z" },
    ]);
  });

  it("CB yields only a clear for `from`", () => {
    expect(
      berthChangesForEvent({
        messageType: "CB",
        tdArea: "PX",
        fromBerth: "0195",
        toBerth: null,
        description: "",
        eventAt: "2026-09-03T10:01:00.000Z",
      }),
    ).toEqual([
      { tdArea: "PX", berth: "0195", description: null, eventAt: "2026-09-03T10:01:00.000Z" },
    ]);
  });

  it("CC yields only an update for `to`", () => {
    expect(
      berthChangesForEvent({
        messageType: "CC",
        tdArea: "PX",
        fromBerth: null,
        toBerth: "0200",
        description: "1S99",
        eventAt: "2026-09-03T10:02:00.000Z",
      }),
    ).toEqual([
      { tdArea: "PX", berth: "0200", description: "1S99", eventAt: "2026-09-03T10:02:00.000Z" },
    ]);
  });

  it("omits a half of a CA whose berth code is absent", () => {
    expect(
      berthChangesForEvent({
        messageType: "CA",
        tdArea: "PX",
        fromBerth: null,
        toBerth: "0195",
        description: "4S45",
        eventAt: "2026-09-03T10:00:00.000Z",
      }),
    ).toEqual([
      { tdArea: "PX", berth: "0195", description: "4S45", eventAt: "2026-09-03T10:00:00.000Z" },
    ]);
  });
});
