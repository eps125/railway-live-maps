import { describe, expect, it } from "vitest";
import {
  routePointsOffTrack,
  snapToTrack,
  traceRoute,
  type TrackLike,
  type TrackPosition,
} from "./trackGraph.js";

// Two parallel running lines 30 apart with a facing crossover from A to B for eastbound trains,
// drawn as a separate piece of track whose ends lie part-way along each line — the way a
// crossover is drawn in the editor.
const A: TrackLike = {
  id: "A",
  points: [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
  ],
};
const B: TrackLike = {
  id: "B",
  points: [
    { x: 0, y: 30 },
    { x: 400, y: 30 },
  ],
};
const X: TrackLike = {
  id: "X",
  points: [
    { x: 100, y: 0 },
    { x: 160, y: 30 },
  ],
};
const tracks = [A, B, X];

function at(x: number, y: number): TrackPosition {
  const position = snapToTrack(tracks, { x, y }, 10);
  if (!position) throw new Error(`no track near ${x},${y}`);
  return position;
}

describe("traceRoute", () => {
  it("follows a single line between two points on it", () => {
    const result = traceRoute(tracks, [at(20, 0), at(380, 0)]);
    expect(result).toEqual({
      route: {
        points: [
          { x: 20, y: 0 },
          { x: 380, y: 0 },
        ],
        trackIds: ["A"],
      },
    });
  });

  it("takes a crossover whose ends lie part-way along each line", () => {
    const result = traceRoute(tracks, [at(20, 0), at(380, 30)]);
    expect(result).toEqual({
      route: {
        points: [
          { x: 20, y: 0 },
          { x: 100, y: 0 },
          { x: 160, y: 30 },
          { x: 380, y: 30 },
        ],
        trackIds: ["A", "X", "B"],
      },
    });
  });

  it("refuses to reverse through a turnout it would have to back into", () => {
    // From A east of the crossover, the only way onto B is west past the turnout and back out
    // along X — a reversal, which no route makes.
    expect(traceRoute(tracks, [at(300, 0), at(380, 30)])).toEqual({ failedLeg: 0 });
  });

  it("goes the other way along the crossover when that is the direction of travel", () => {
    const result = traceRoute(tracks, [at(380, 30), at(20, 0)]);
    expect("route" in result && result.route.trackIds).toEqual(["B", "X", "A"]);
  });

  it("does not turn at a diamond: tracks whose interiors merely cross are not joined", () => {
    const C: TrackLike = {
      id: "C",
      points: [
        { x: 200, y: -40 },
        { x: 280, y: 70 },
      ],
    };
    const withDiamond = [...tracks, C];
    const start = snapToTrack(withDiamond, { x: 205, y: -33 }, 10)!;
    const end = snapToTrack(withDiamond, { x: 380, y: 0 }, 10)!;
    expect(traceRoute(withDiamond, [start, end])).toEqual({ failedLeg: 0 });
  });

  it("goes through an intermediate waypoint, keeping the direction of travel", () => {
    // Via a point on B *before* the crossover lands: reaching it would need the crossover and
    // then a reversal along B, so the leg after it cannot continue east past it back onto A.
    const viaCrossover = traceRoute(tracks, [at(20, 0), at(130, 15), at(380, 30)]);
    expect("route" in viaCrossover && viaCrossover.route.trackIds).toEqual(["A", "X", "B"]);
    const straight = traceRoute(tracks, [at(20, 0), at(250, 0), at(380, 30)]);
    expect(straight).toEqual({ failedLeg: 1 });
  });
});

describe("routePointsOffTrack", () => {
  it("finds nothing wrong with a route that lies on the track", () => {
    const traced = traceRoute(tracks, [at(20, 0), at(380, 30)]);
    if (!("route" in traced)) throw new Error("expected a route");
    expect(routePointsOffTrack(traced.route.points, tracks)).toEqual([]);
  });

  it("flags a route the track has since moved away from", () => {
    const moved = [{ ...A, points: A.points.map((p) => ({ x: p.x, y: p.y - 20 })) }, B, X];
    const off = routePointsOffTrack(
      [
        { x: 20, y: 0 },
        { x: 90, y: 0 },
      ],
      moved,
    );
    expect(off.length).toBeGreaterThan(0);
  });
});
