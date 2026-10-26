import { describe, expect, it } from "vitest";
import {
  BERTH_ALLOWANCE_DEFAULT_MINUTES,
  berthAllowance,
  percentileOfSorted,
} from "./berthAllowance.js";

describe("percentileOfSorted", () => {
  it("interpolates like Postgres percentile_cont", () => {
    expect(percentileOfSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileOfSorted([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(percentileOfSorted([5], 0.95)).toBe(5);
  });
});

describe("berthAllowance", () => {
  it("uses the default for a berth with too few occupancies", () => {
    expect(berthAllowance(Array(49).fill(2))).toEqual({
      basis: "default",
      sampleSize: 49,
      dropped: 0,
      allowanceMinutes: BERTH_ALLOWANCE_DEFAULT_MINUTES,
    });
  });

  it("drops a long stand as an outlier instead of letting it set the allowance — the BLDM case", () => {
    // 100 ordinary passes of 4-6 minutes and one 189-minute stand.
    const durations = Array.from({ length: 100 }, (_, i) => 4 + (i % 21) / 10);
    durations.push(189);
    const result = berthAllowance(durations);
    expect(result.basis).toBe("measured");
    if (result.basis !== "measured") return;
    expect(result.dropped).toBe(1);
    expect(result.allowanceMinutes).toBeGreaterThan(5.5);
    expect(result.allowanceMinutes).toBeLessThanOrEqual(6);
  });

  it("never gives less than one minute", () => {
    const result = berthAllowance(Array(60).fill(0.4));
    expect(result.allowanceMinutes).toBe(1);
  });

  it("ignores negative and non-finite durations rather than repairing them", () => {
    const durations = [...Array(50).fill(2), -3, Number.NaN];
    const result = berthAllowance(durations);
    expect(result.sampleSize).toBe(50);
    expect(result.allowanceMinutes).toBe(2);
  });
});
