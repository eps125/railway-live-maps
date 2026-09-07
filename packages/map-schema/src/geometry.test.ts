import { describe, expect, it } from "vitest";
import { berthRenderRect, pointOnPathAtX } from "./geometry.js";
import { MapDocumentSchema, type BerthElement, type MapElement } from "./document.js";

describe("pointOnPathAtX", () => {
  it("interpolates linearly between the two bracketing vertices", () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 100, y: 300 },
    ];
    expect(pointOnPathAtX(pts, 0)).toBe(100);
    expect(pointOnPathAtX(pts, 50)).toBe(200);
    expect(pointOnPathAtX(pts, 100)).toBe(300);
  });

  it("walks a multi-vertex polyline (horizontal, diagonal, horizontal)", () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 100, y: 100 },
      { x: 160, y: 130 },
      { x: 400, y: 130 },
    ];
    expect(pointOnPathAtX(pts, 50)).toBe(100);
    expect(pointOnPathAtX(pts, 130)).toBe(115); // half-way down the 1:2 diagonal
    expect(pointOnPathAtX(pts, 300)).toBe(130);
  });

  it("clamps to the nearer endpoint when x is beyond both ends", () => {
    const pts = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ];
    expect(pointOnPathAtX(pts, 0)).toBe(100);
    expect(pointOnPathAtX(pts, 999)).toBe(100);
  });

  it("returns null only for an empty path", () => {
    expect(pointOnPathAtX([], 5)).toBeNull();
    expect(pointOnPathAtX([{ x: 3, y: 7 }], 5)).toBe(7);
  });
});

function berth(overrides: Partial<BerthElement> = {}): BerthElement {
  return {
    id: "b1",
    layerId: "l1",
    zIndex: 0,
    type: "berth",
    x: 40,
    y: 10,
    width: 40,
    height: 20,
    textAlign: "center",
    fontSize: 12,
    displayName: "B1",
    ...overrides,
  } as BerthElement;
}

const track: MapElement = {
  id: "trk",
  layerId: "l1",
  zIndex: 0,
  type: "trackPath",
  points: [
    { x: 0, y: 100 },
    { x: 400, y: 100 },
  ],
};

describe("berthRenderRect", () => {
  it("centres a berth vertically on its explicitly bound track", () => {
    const rect = berthRenderRect(berth({ trackElementId: "trk" }), { trk: track });
    // track y = 100, berth height 20 -> top at 90, so the box centre lands on the rail
    expect(rect).toEqual({ x: 40, y: 90, width: 40, height: 20 });
  });

  it("falls back to the nearest horizontal track when trackElementId is absent", () => {
    const rect = berthRenderRect(berth({ y: 96 }), { trk: track });
    expect(rect.y).toBe(90);
  });

  it("leaves an unbound berth with no track in range exactly as authored", () => {
    expect(berthRenderRect(berth({ y: 500 }), { trk: track })).toEqual({
      x: 40,
      y: 500,
      width: 40,
      height: 20,
    });
    expect(berthRenderRect(berth(), {})).toEqual({ x: 40, y: 10, width: 40, height: 20 });
  });

  it("ignores a diagonal transition segment as a centring host", () => {
    const diagonal: MapElement = {
      id: "diag",
      layerId: "l1",
      zIndex: 0,
      type: "trackPath",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 200 },
      ],
    };
    // only a steep diagonal in range, no horizontal line -> authored geometry kept
    expect(berthRenderRect(berth({ y: 90 }), { diag: diagonal }).y).toBe(90);
  });

  it("accepts a Map lookup as well as a plain record", () => {
    const rect = berthRenderRect(berth({ trackElementId: "trk" }), new Map([["trk", track]]));
    expect(rect.y).toBe(90);
  });

  it("works through the real schema parse (defaults applied)", () => {
    const doc = MapDocumentSchema.parse({
      schemaVersion: 1,
      map: {
        id: "m",
        name: "M",
        canvas: { width: 500, height: 200, gridSize: 10 },
        timezone: "Europe/London",
      },
      layers: [{ id: "l1", name: "Track", order: 0 }],
      elements: [
        {
          id: "trk",
          layerId: "l1",
          type: "trackPath",
          points: [
            { x: 0, y: 100 },
            { x: 400, y: 100 },
          ],
        },
        {
          id: "b1",
          layerId: "l1",
          type: "berth",
          x: 40,
          y: 10,
          width: 40,
          height: 20,
          displayName: "B1",
          trackElementId: "trk",
        },
      ],
      topology: { nodes: [], edges: [] },
      bindings: [],
      editorMetadata: {},
    });
    const byId = Object.fromEntries(doc.elements.map((e) => [e.id, e]));
    const b = doc.elements.find((e) => e.id === "b1") as BerthElement;
    expect(berthRenderRect(b, byId).y).toBe(90);
  });
});
