import { describe, expect, it } from "vitest";
import { GARNER_NOT_DELETED, garnerDeletedToTs, sequenceScheduleLocations } from "./bridge.js";

describe("garnerDeletedToTs", () => {
  it("maps garner's NOT_DELETED sentinel (0xffffffff) to null — a live schedule", () => {
    expect(GARNER_NOT_DELETED).toBe(0xffffffff);
    expect(garnerDeletedToTs(GARNER_NOT_DELETED)).toBeNull();
  });

  it("maps 0 to null (also treated as live)", () => {
    expect(garnerDeletedToTs(0)).toBeNull();
    expect(garnerDeletedToTs(null)).toBeNull();
    expect(garnerDeletedToTs(undefined)).toBeNull();
  });

  it("maps a real withdrawal epoch to that instant", () => {
    // 2026-08-16T00:00:00Z
    const epoch = Math.floor(Date.UTC(2026, 7, 16) / 1000);
    expect(garnerDeletedToTs(epoch)?.toISOString()).toBe("2026-08-16T00:00:00.000Z");
  });

  it("does not treat a value just below the sentinel as live", () => {
    const justBelow = GARNER_NOT_DELETED - 1;
    expect(garnerDeletedToTs(justBelow)).not.toBeNull();
  });
});

describe("sequenceScheduleLocations", () => {
  // Regression for the real overnight working reproduced 2026-09-14, headcode 9M63 / UID
  // W33240: GLASGOW CENTRAL 18:34 -> ... -> NORTHAMPTON 23:56 (all same-day) -> COURTEENHALL JN
  // 00:02 -> ... -> EUSTON 01:04 (all next-day). `sort_time` alone (a within-day clock value)
  // would put COURTEENHALL/EUSTON first because their sort_time is numerically smaller.
  function loc(tiploc_code: string, sort_time: number, next_day: number, cif_schedule_id = 1) {
    return { cif_schedule_id, tiploc_code, sort_time, next_day };
  }

  it("orders next-day rows after same-day rows regardless of input order or sort_time magnitude", () => {
    const rows = [
      loc("EUSTON", 64, 1), // 01:04 next day
      loc("COURTEENHALL", 2, 1), // 00:02 next day
      loc("NORTHAMPTON", 1436, 0), // 23:56 same day
      loc("GLASGOW", 1114, 0), // 18:34 same day
    ];

    const result = sequenceScheduleLocations(rows);

    expect(result.map((r) => r.tiploc_code)).toEqual([
      "GLASGOW",
      "NORTHAMPTON",
      "COURTEENHALL",
      "EUSTON",
    ]);
    expect(result.map((r) => r.seqNo)).toEqual([1, 2, 3, 4]);
  });

  it("assigns seq_no independently per schedule and never interleaves two schedules", () => {
    const rows = [loc("A", 10, 0, 1), loc("X", 5, 0, 2), loc("B", 20, 0, 1), loc("Y", 50, 1, 2)];

    const result = sequenceScheduleLocations(rows);

    const schedule1 = result.filter((r) => r.cif_schedule_id === 1);
    const schedule2 = result.filter((r) => r.cif_schedule_id === 2);
    expect(schedule1.map((r) => [r.tiploc_code, r.seqNo])).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
    expect(schedule2.map((r) => [r.tiploc_code, r.seqNo])).toEqual([
      ["X", 1],
      ["Y", 2],
    ]);
  });

  it("is a no-op ordering for a schedule that never crosses midnight", () => {
    const rows = [loc("C", 30, 0), loc("A", 10, 0), loc("B", 20, 0)];
    expect(sequenceScheduleLocations(rows).map((r) => r.tiploc_code)).toEqual(["A", "B", "C"]);
  });
});
