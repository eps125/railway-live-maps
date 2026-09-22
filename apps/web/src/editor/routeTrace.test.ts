import { describe, expect, it } from "vitest";
import { MapDocumentSchema, type MapDocument } from "@railway/map-schema";
import { computeRouteTrace, routeDisplayName, routeFromTrace } from "./routeTrace.js";

// Up and Down lines with a crossover from Up to Down for eastbound trains; S1 on the Up line at
// the west end, S2 on the Down line at the east end, S3 on the Up line at the east end.
function doc(): MapDocument {
  return MapDocumentSchema.parse({
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 500, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "track", name: "Track", order: 0 }],
    elements: [
      {
        id: "up",
        layerId: "track",
        type: "trackPath",
        points: [
          { x: 0, y: 0 },
          { x: 400, y: 0 },
        ],
      },
      {
        id: "down",
        layerId: "track",
        type: "trackPath",
        points: [
          { x: 0, y: 30 },
          { x: 400, y: 30 },
        ],
      },
      {
        id: "xo",
        layerId: "track",
        type: "trackPath",
        points: [
          { x: 100, y: 0 },
          { x: 160, y: 30 },
        ],
      },
      {
        id: "S1",
        layerId: "track",
        type: "signal",
        x: 20,
        y: 0,
        label: "S1",
        trackElementId: "up",
      },
      { id: "S2", layerId: "track", type: "signal", x: 380, y: 30, label: "S2" },
      { id: "S3", layerId: "track", type: "signal", x: 380, y: 0, label: "S3" },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  });
}

describe("computeRouteTrace", () => {
  it("has only a start point until the author clicks along the track", () => {
    expect(computeRouteTrace(doc(), { signalId: "S1", routeId: null, waypoints: [] })).toEqual({
      status: "started",
      start: { x: 20, y: 0 },
    });
  });

  it("goes straight to an exit signal on the same line", () => {
    const result = computeRouteTrace(doc(), { signalId: "S1", routeId: null, waypoints: [] }, "S3");
    expect(result).toEqual({
      status: "traced",
      route: {
        points: [
          { x: 20, y: 0 },
          { x: 380, y: 0 },
        ],
        trackIds: ["up"],
      },
    });
  });

  it("takes the crossover to an exit signal on the other line", () => {
    const result = computeRouteTrace(doc(), { signalId: "S1", routeId: null, waypoints: [] }, "S2");
    expect(result.status === "traced" && result.route.trackIds).toEqual(["up", "xo", "down"]);
  });

  it("snaps a click a few units off the track onto it, and ignores one nowhere near", () => {
    const result = computeRouteTrace(doc(), {
      signalId: "S1",
      routeId: null,
      waypoints: [
        { x: 250, y: 4 },
        { x: 250, y: 70 },
      ],
    });
    expect(result).toEqual({
      status: "traced",
      route: {
        points: [
          { x: 20, y: 0 },
          { x: 250, y: 0 },
        ],
        trackIds: ["up"],
      },
    });
  });

  it("reports a leg that would need a reversal rather than drawing one", () => {
    // Past the crossover on the Up line, the Down line is only reachable by reversing.
    const result = computeRouteTrace(
      doc(),
      { signalId: "S1", routeId: null, waypoints: [{ x: 250, y: 0 }] },
      "S2",
    );
    expect(result).toMatchObject({ status: "noPath", failedLeg: 1 });
  });
});

describe("routeFromTrace", () => {
  const traced = {
    points: [
      { x: 20, y: 0 },
      { x: 380, y: 0 },
    ],
    trackIds: ["up"],
  };

  it("adds a new route owned by the entry signal, above the rails", () => {
    const change = routeFromTrace(
      doc(),
      { signalId: "S1", routeId: null, waypoints: [] },
      traced,
      "S3",
      "track",
      "r-new",
    );
    expect(change).toEqual({
      kind: "add",
      element: {
        id: "r-new",
        layerId: "track",
        zIndex: 2,
        type: "route",
        entrySignalId: "S1",
        exitSignalId: "S3",
        points: traced.points,
        trackIds: ["up"],
      },
    });
  });

  it("patches the existing route when re-tracing, clearing an exit it no longer has", () => {
    const base = doc();
    const withRoute: MapDocument = {
      ...base,
      elements: [
        ...base.elements,
        {
          id: "r1",
          layerId: "track",
          zIndex: 2,
          type: "route",
          entrySignalId: "S1",
          exitSignalId: "S2",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
          ],
          trackIds: [],
        },
      ],
    };
    expect(
      routeFromTrace(
        withRoute,
        { signalId: "S1", routeId: "r1", waypoints: [] },
        traced,
        undefined,
        "track",
        "unused",
      ),
    ).toEqual({
      kind: "patch",
      elementId: "r1",
      patch: { points: traced.points, trackIds: ["up"], exitSignalId: undefined },
    });
  });
});

describe("routeDisplayName", () => {
  it("uses the route's own name, else its signals' labels", () => {
    const route = {
      id: "r1",
      layerId: "track",
      zIndex: 2,
      type: "route" as const,
      entrySignalId: "S1",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      trackIds: [],
    };
    expect(routeDisplayName(doc(), { ...route, label: "R1A(M)" })).toBe("R1A(M)");
    expect(routeDisplayName(doc(), { ...route, exitSignalId: "S3" })).toBe("S1 → S3");
    expect(routeDisplayName(doc(), route)).toBe("S1 → end of line");
  });
});
