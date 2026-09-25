import { describe, expect, it } from "vitest";
import { aggregateBerthDayActivity } from "../td/projector.js";
import { parseBerthActivityBackfillArgs, planDays } from "./backfillBerthActivity.js";

describe("aggregateBerthDayActivity (Milestone 72)", () => {
  it("counts to_berth as in and from_berth as out, per area, UTC day and berth", () => {
    const at = (iso: string) => new Date(iso);
    const result = aggregateBerthDayActivity([
      { tdArea: "M9", eventAt: at("2026-09-24T23:59:59Z"), toBerth: "0001" }, // CC
      { tdArea: "M9", eventAt: at("2026-09-25T00:00:01Z"), fromBerth: "0001", toBerth: "0002" }, // CA
      { tdArea: "M9", eventAt: at("2026-09-25T00:10:00Z"), fromBerth: "0002" }, // CB
      { tdArea: "PX", eventAt: at("2026-09-25T00:10:00Z"), toBerth: "0001" }, // another area
    ]);
    expect(result).toEqual([
      {
        tdArea: "M9",
        activityDate: "2026-09-24",
        berth: "0001",
        eventsIn: 1,
        eventsOut: 0,
        firstAt: at("2026-09-24T23:59:59Z"),
        lastAt: at("2026-09-24T23:59:59Z"),
      },
      {
        tdArea: "M9",
        activityDate: "2026-09-25",
        berth: "0002",
        eventsIn: 1,
        eventsOut: 1,
        firstAt: at("2026-09-25T00:00:01Z"),
        lastAt: at("2026-09-25T00:10:00Z"),
      },
      {
        tdArea: "M9",
        activityDate: "2026-09-25",
        berth: "0001",
        eventsIn: 0,
        eventsOut: 1,
        firstAt: at("2026-09-25T00:00:01Z"),
        lastAt: at("2026-09-25T00:00:01Z"),
      },
      {
        tdArea: "PX",
        activityDate: "2026-09-25",
        berth: "0001",
        eventsIn: 1,
        eventsOut: 0,
        firstAt: at("2026-09-25T00:10:00Z"),
        lastAt: at("2026-09-25T00:10:00Z"),
      },
    ]);
  });
});

describe("backfill-berth-activity arguments", () => {
  it("defaults to a dry run over the default range", () => {
    expect(parseBerthActivityBackfillArgs([])).toEqual({
      ok: true,
      args: { from: null, to: null, area: null, sleepMs: 100, execute: false },
    });
  });

  it("accepts dates, an area and --execute", () => {
    expect(
      parseBerthActivityBackfillArgs([
        "--from",
        "2026-08-07",
        "--to",
        "2026-09-25",
        "--area",
        "m9",
        "--sleep-ms",
        "0",
        "--execute",
      ]),
    ).toEqual({
      ok: true,
      args: { from: "2026-08-07", to: "2026-09-25", area: "M9", sleepMs: 0, execute: true },
    });
  });

  it("rejects bad input", () => {
    expect(parseBerthActivityBackfillArgs(["--from", "7 Aug"]).ok).toBe(false);
    expect(parseBerthActivityBackfillArgs(["--from", "2026-09-02", "--to", "2026-09-01"]).ok).toBe(
      false,
    );
    expect(parseBerthActivityBackfillArgs(["--area", "M99"]).ok).toBe(false);
    expect(parseBerthActivityBackfillArgs(["--sleep-ms", "-1"]).ok).toBe(false);
  });

  it("plans every UTC day inclusive, across a month end", () => {
    expect(planDays("2026-08-30", "2026-09-02")).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
    expect(planDays("2026-09-02", "2026-09-02")).toEqual(["2026-09-02"]);
  });
});
