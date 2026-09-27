import { describe, expect, it } from "vitest";
import type { MapDocument, MapElement, RouteElement } from "@railway/map-schema";
import { applyCommand } from "./commands.js";
import { checkRouteEnds, routesFollowingSignal } from "./routeEnds.js";

const signal = (id: string, x: number, y = 100): MapElement =>
  ({
    id,
    layerId: "l",
    zIndex: 0,
    type: "signal",
    x,
    y,
    orientation: 0,
    symbolStyle: "signal-blank",
  }) as MapElement;
const route = (
  id: string,
  points: Array<[number, number]>,
  entry = "s1",
  exit?: string,
): RouteElement =>
  ({
    id,
    layerId: "l",
    zIndex: 0,
    type: "route",
    entrySignalId: entry,
    ...(exit ? { exitSignalId: exit } : {}),
    points: points.map(([x, y]) => ({ x, y })),
    trackIds: [],
  }) as RouteElement;

function doc(elements: MapElement[]): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 400, height: 200, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", visible: true, locked: false, order: 0 }],
    elements,
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

describe("routes follow their signals (owner, 2026-09-27)", () => {
  it("moving a signal along its track slides its routes' ends with it, and undo slides them back", () => {
    const before = doc([
      signal("s1", 100),
      signal("s2", 300),
      route(
        "r1",
        [
          [100, 100],
          [200, 100],
          [300, 100],
        ],
        "s1",
        "s2",
      ),
      route(
        "r2",
        [
          [300, 100],
          [400, 100],
        ],
        "s2",
      ),
    ]);
    const { doc: after, inverse } = applyCommand(before, {
      type: "moveElements",
      elementIds: ["s2"],
      dx: -10,
      dy: 0,
    });
    const points = (d: MapDocument, id: string) =>
      (d.elements.find((e) => e.id === id) as RouteElement).points;
    expect(points(after, "r1")).toEqual([
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 290, y: 100 },
    ]);
    expect(points(after, "r2")).toEqual([
      { x: 290, y: 100 },
      { x: 400, y: 100 },
    ]);
    const undone = applyCommand(after, inverse).doc;
    expect(points(undone, "r1")).toEqual(points(before, "r1"));
    expect(points(undone, "r2")).toEqual(points(before, "r2"));
  });

  it("does not bend a route: a move off the track, or an end on a diagonal, is left alone", () => {
    const before = doc([
      signal("s1", 100),
      route("diag", [
        [100, 100],
        [130, 130],
      ]),
      route("level", [
        [100, 100],
        [200, 100],
      ]),
    ]);
    const offTrack = applyCommand(before, {
      type: "moveElements",
      elementIds: ["s1"],
      dx: 0,
      dy: 30,
    }).doc;
    expect((offTrack.elements.find((e) => e.id === "level") as RouteElement).points[0]).toEqual({
      x: 100,
      y: 100,
    });
    expect(routesFollowingSignal(before.elements, { id: "s1", x: 100, y: 100 }, -10)).toEqual([
      {
        routeId: "level",
        points: [
          { x: 90, y: 100 },
          { x: 200, y: 100 },
        ],
      },
    ]);
  });

  it("re-attaches ends that have drifted a short way, and flags ones it won't guess at", () => {
    const at =
      (x: number, y = 100) =>
      () => ({ x, y });
    expect(
      checkRouteEnds(
        route("r", [
          [110, 100],
          [200, 100],
        ]),
        at(100),
      ),
    ).toEqual({
      status: "realign",
      points: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ],
    });
    expect(
      checkRouteEnds(
        route("r", [
          [100, 100],
          [200, 100],
        ]),
        at(100),
      ),
    ).toEqual({ status: "attached" });
    // Too far off, on another track, or would reverse the segment.
    expect(
      checkRouteEnds(
        route("r", [
          [150, 100],
          [200, 100],
        ]),
        at(100),
      ).status,
    ).toBe("needs-retrace");
    expect(
      checkRouteEnds(
        route("r", [
          [100, 130],
          [200, 130],
        ]),
        at(100),
      ).status,
    ).toBe("needs-retrace");
    expect(
      checkRouteEnds(
        route("r", [
          [100, 100],
          [105, 100],
        ]),
        at(110),
      ).status,
    ).toBe("needs-retrace");
    // A route with no exit signal only has its start checked.
    expect(
      checkRouteEnds(
        route("r", [
          [100, 100],
          [900, 100],
        ]),
        at(100),
      ),
    ).toEqual({ status: "attached" });
  });
});
