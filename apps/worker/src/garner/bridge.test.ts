import { describe, expect, it } from "vitest";
import {
  GARNER_NOT_DELETED,
  dedupeScheduleRowsById,
  diffScheduleWindow,
  garnerDeletedToTs,
  sequenceScheduleLocations,
} from "./bridge.js";

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

describe("dedupeScheduleRowsById", () => {
  // Production, 2026-09-21: a schedule created *and* withdrawn since the last tick was returned by
  // both the `id >` and the `deleted >` query; passing it twice to one upsert failed every tick
  // with "ON CONFLICT DO UPDATE command cannot affect row a second time".
  it("keeps one row per id, preferring the later occurrence", () => {
    const rows = [
      { id: 871026, deleted: GARNER_NOT_DELETED },
      { id: 871027, deleted: GARNER_NOT_DELETED },
      { id: 871026, deleted: 1790020000 },
    ];
    expect(dedupeScheduleRowsById(rows)).toEqual([
      { id: 871026, deleted: 1790020000 },
      { id: 871027, deleted: GARNER_NOT_DELETED },
    ]);
  });
});

describe("diffScheduleWindow", () => {
  const live = (id: number, updateId = 18) => ({ id, updateId, deletedEpoch: null });

  it("reports a garner schedule the id cursor skipped (R61798 / id 843031, 2026-09-18 load)", () => {
    const diff = diffScheduleWindow(
      [live(843030), live(843031), live(843289)],
      [live(843030), live(843289)],
      new Map([
        [843030, 5],
        [843031, 24],
        [843289, 3],
      ]),
      new Map([
        [843030, 5],
        [843289, 3],
      ]),
    );
    expect(diff).toEqual({ scheduleIds: [843031], locationOnlyIds: [] });
  });

  it("reports a present schedule whose calling points never arrived (B32230 / id 822834)", () => {
    const diff = diffScheduleWindow(
      [live(822833), live(822834)],
      [live(822833), live(822834)],
      new Map([
        [822833, 23],
        [822834, 17],
      ]),
      new Map(),
    );
    expect(diff).toEqual({ scheduleIds: [], locationOnlyIds: [822833, 822834] });
  });

  it("reports a withdrawal or amendment RLM hasn't seen, but nothing when in sync", () => {
    const counts = new Map([
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
    const diff = diffScheduleWindow(
      [live(1), { id: 2, updateId: 18, deletedEpoch: 1790020390 }, live(3, 19)],
      [live(1), live(2), live(3, 18)],
      counts,
      counts,
    );
    expect(diff).toEqual({ scheduleIds: [2, 3], locationOnlyIds: [] });
  });

  it("never reports an RLM-only schedule — the mirror does not delete history", () => {
    const diff = diffScheduleWindow([], [live(5)], new Map(), new Map([[5, 4]]));
    expect(diff).toEqual({ scheduleIds: [], locationOnlyIds: [] });
  });
});
