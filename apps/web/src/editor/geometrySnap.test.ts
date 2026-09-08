import { describe, expect, it } from "vitest";
import { SNAP_ANGLES_DEG, snapSegmentAngle, weldToEndpoint } from "./geometrySnap.js";

describe("SNAP_ANGLES_DEG", () => {
  it("covers horizontal, vertical, 1:2 and 1:1 in every quadrant", () => {
    for (const a of [0, 90, 180, 270, 45, 135, 225, 315]) {
      expect(SNAP_ANGLES_DEG.some((s) => Math.abs(s - a) < 1e-6)).toBe(true);
    }
    // 1:2 ~= 26.565 deg and its reflections
    expect(SNAP_ANGLES_DEG.some((s) => Math.abs(s - 26.565) < 0.01)).toBe(true);
    expect(SNAP_ANGLES_DEG.some((s) => Math.abs(s - 333.435) < 0.01)).toBe(true);
  });
});

describe("snapSegmentAngle", () => {
  const from = { x: 100, y: 100 };

  it("pulls a near-horizontal segment exactly onto 0deg, keeping length", () => {
    const snapped = snapSegmentAngle(from, { x: 200, y: 104 });
    expect(snapped.y).toBeCloseTo(100);
    expect(Math.hypot(snapped.x - from.x, snapped.y - from.y)).toBeCloseTo(Math.hypot(100, 4));
  });

  it("snaps a ~27deg segment onto the 1:2 diagonal", () => {
    const snapped = snapSegmentAngle(from, { x: 200, y: 151 });
    // 1:2 means dy = dx/2
    expect((snapped.y - from.y) / (snapped.x - from.x)).toBeCloseTo(0.5, 2);
  });

  it("snaps a ~44deg segment onto 1:1", () => {
    const snapped = snapSegmentAngle(from, { x: 200, y: 196 });
    expect((snapped.y - from.y) / (snapped.x - from.x)).toBeCloseTo(1, 2);
  });

  it("always snaps — a ~19deg segment is pulled onto the nearest angle (1:2), not left free", () => {
    const to = { x: 200, y: 135 }; // ~19.3 deg — nearer 26.565 than 0
    const snapped = snapSegmentAngle(from, to);
    expect(snapped).not.toEqual(to);
    expect((snapped.y - from.y) / (snapped.x - from.x)).toBeCloseTo(0.5, 2);
  });

  it("snaps a ~13deg segment onto 0deg (nearer horizontal than 1:2)", () => {
    const snapped = snapSegmentAngle(from, { x: 200, y: 123 });
    expect(snapped.y).toBeCloseTo(100);
  });

  it("bypass returns the raw point", () => {
    const to = { x: 200, y: 135 };
    expect(snapSegmentAngle(from, to, true)).toBe(to);
  });

  it("zero-length segment is returned unchanged", () => {
    expect(snapSegmentAngle(from, { ...from })).toEqual(from);
  });
});

describe("weldToEndpoint", () => {
  it("returns the nearest candidate within weldTolerance", () => {
    const got = weldToEndpoint({ x: 100, y: 100 }, [
      { x: 200, y: 200 },
      { x: 103, y: 98 },
    ]);
    expect(got).toEqual({ x: 103, y: 98 });
  });

  it("returns null when nothing is close enough", () => {
    expect(weldToEndpoint({ x: 100, y: 100 }, [{ x: 130, y: 130 }])).toBeNull();
  });
});
