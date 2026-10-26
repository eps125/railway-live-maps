import { describe, expect, it } from "vitest";
import { validateQueueJobBody } from "./maintenance.js";

const NOW = new Date("2026-10-26T17:00:00Z");

describe("validateQueueJobBody", () => {
  it("accepts a berth-allowances job, normalising and de-duplicating areas", () => {
    expect(
      validateQueueJobBody(
        { kind: "berth_allowances", tdAreas: ["px", "PX", " cl "], params: {} },
        NOW,
      ),
    ).toEqual({
      ok: true,
      kind: "berth_allowances",
      tdAreas: ["PX", "CL"],
      params: { windowDays: 14 },
    });
  });

  it("rejects an unknown kind, no areas, or a malformed area", () => {
    expect(validateQueueJobBody({ kind: "drop_tables", tdAreas: ["PX"] }, NOW).ok).toBe(false);
    expect(validateQueueJobBody({ kind: "berth_allowances", tdAreas: [] }, NOW).ok).toBe(false);
    expect(validateQueueJobBody({ kind: "berth_allowances", tdAreas: ["PXX"] }, NOW)).toMatchObject(
      { ok: false, message: 'Not a TD area id: "PXX"' },
    );
  });

  it("bounds the allowance window", () => {
    for (const windowDays of [0, 61, 2.5, "14"]) {
      expect(
        validateQueueJobBody(
          { kind: "berth_allowances", tdAreas: ["PX"], params: { windowDays } },
          NOW,
        ).ok,
      ).toBe(false);
    }
  });

  it("accepts a link backfill with a sensible window", () => {
    expect(
      validateQueueJobBody(
        {
          kind: "link_backfill",
          tdAreas: ["R4"],
          params: { from: "2026-10-20T00:00:00Z", to: "2026-10-26T00:00:00Z", correct: true },
        },
        NOW,
      ),
    ).toEqual({
      ok: true,
      kind: "link_backfill",
      tdAreas: ["R4"],
      params: { from: "2026-10-20T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z", correct: true },
    });
  });

  it("rejects a backfill that is backwards, in the future or too long", () => {
    const backfill = (from: string, to: string) =>
      validateQueueJobBody({ kind: "link_backfill", tdAreas: ["R4"], params: { from, to } }, NOW);
    expect(backfill("2026-10-26T00:00:00Z", "2026-10-25T00:00:00Z")).toMatchObject({
      ok: false,
      code: "INVALID_TIME_RANGE",
    });
    expect(backfill("2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z").ok).toBe(false);
    expect(backfill("2026-08-01T00:00:00Z", "2026-10-26T00:00:00Z").ok).toBe(false);
    expect(backfill("not a date", "2026-10-26T00:00:00Z").ok).toBe(false);
  });
});
