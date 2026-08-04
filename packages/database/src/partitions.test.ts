import { describe, expect, it } from "vitest";
import { monthRangeBounds } from "./partitions.js";

describe("monthRangeBounds", () => {
  it("returns the [start, end) UTC bounds and suffix for a mid-month date", () => {
    const bounds = monthRangeBounds(new Date("2026-08-15T12:34:56Z"));

    expect(bounds.suffix).toBe("2026_08");
    expect(bounds.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rolls over correctly at a year boundary", () => {
    const bounds = monthRangeBounds(new Date("2026-12-31T23:59:59Z"));

    expect(bounds.suffix).toBe("2026_12");
    expect(bounds.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("pads single-digit months", () => {
    const bounds = monthRangeBounds(new Date("2026-02-01T00:00:00Z"));
    expect(bounds.suffix).toBe("2026_02");
  });
});
