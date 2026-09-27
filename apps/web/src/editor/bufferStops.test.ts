import { describe, expect, it } from "vitest";
import type { MapElement } from "@railway/map-schema";
import { nearestTrackEnd } from "./bufferStops.js";

const track = (id: string, points: Array<[number, number]>): MapElement => ({
  id,
  layerId: "track",
  zIndex: 0,
  type: "trackPath",
  points: points.map(([x, y]) => ({ x, y })),
});

describe("nearestTrackEnd", () => {
  const elements = [
    track("a", [
      [0, 0],
      [200, 0],
    ]),
    // Continues a at (200, 0): that joint is not a dead end.
    track("b", [
      [200, 0],
      [300, 0],
    ]),
  ];

  it("snaps to a dead end, facing the way trains reach it", () => {
    expect(nearestTrackEnd(elements, { x: 290, y: 10 })).toEqual({
      point: { x: 300, y: 0 },
      facing: "left",
    });
    expect(nearestTrackEnd(elements, { x: 5, y: -5 })).toEqual({
      point: { x: 0, y: 0 },
      facing: "right",
    });
  });

  it("ignores joints between tracks and ends out of reach", () => {
    expect(nearestTrackEnd(elements, { x: 200, y: 0 })).toBeNull();
    expect(nearestTrackEnd(elements, { x: 100, y: 100 })).toBeNull();
  });
});
