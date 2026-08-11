import { describe, expect, it } from "vitest";
import type { Layer, MapElement } from "@railway/map-schema";
import { defaultLayerIdForTool, elementBounds, boundsIntersect } from "./EditorCanvas.js";

const standardLayers: Layer[] = [
  { id: "layer-track", name: "Track", order: 0, visible: true, locked: false },
  { id: "layer-berths", name: "Berths", order: 1, visible: true, locked: false },
  { id: "layer-signals", name: "Signals", order: 2, visible: true, locked: false },
  { id: "layer-labels", name: "Labels", order: 3, visible: true, locked: false },
];

describe("defaultLayerIdForTool", () => {
  it("places each element type on its name-matched layer, not always the first layer", () => {
    // Regression test for a real production incident: every tool previously used
    // doc.layers[0] unconditionally, so a hand-authored map ended up with every berth/signal/
    // label on its "Track" layer, making paint order between tracks and berths arbitrary.
    expect(defaultLayerIdForTool("berth", standardLayers)).toBe("layer-berths");
    expect(defaultLayerIdForTool("signal", standardLayers)).toBe("layer-signals");
    expect(defaultLayerIdForTool("label", standardLayers)).toBe("layer-labels");
    expect(defaultLayerIdForTool("trackPath", standardLayers)).toBe("layer-track");
    expect(defaultLayerIdForTool("platform", standardLayers)).toBe("layer-track");
    expect(defaultLayerIdForTool("boundary", standardLayers)).toBe("layer-track");
  });

  it("falls back to the first layer when no name match exists", () => {
    const unnamedLayers: Layer[] = [
      { id: "layer-a", name: "Alpha", order: 0, visible: true, locked: false },
      { id: "layer-b", name: "Beta", order: 1, visible: true, locked: false },
    ];
    expect(defaultLayerIdForTool("berth", unnamedLayers)).toBe("layer-a");
  });

  it("returns undefined for an empty document (no layers to place on)", () => {
    expect(defaultLayerIdForTool("berth", [])).toBeUndefined();
  });
});

function berth(x: number, y: number, width: number, height: number): MapElement {
  return {
    id: `berth-${x}-${y}`,
    layerId: "l",
    zIndex: 0,
    type: "berth",
    x,
    y,
    width,
    height,
    textAlign: "center",
    fontSize: 12,
    displayName: "B",
  };
}

function label(x: number, y: number): MapElement {
  return {
    id: `label-${x}-${y}`,
    layerId: "l",
    zIndex: 0,
    type: "label",
    x,
    y,
    text: "L",
    align: "left",
    fontSize: 12,
  };
}

function trackPath(points: Array<{ x: number; y: number }>): MapElement {
  return { id: "track-1", layerId: "l", zIndex: 0, type: "trackPath", points };
}

describe("elementBounds", () => {
  it("uses x/y/width/height for a berth", () => {
    expect(elementBounds(berth(10, 20, 60, 24))).toEqual({
      minX: 10,
      minY: 20,
      maxX: 70,
      maxY: 44,
    });
  });

  it("collapses to a single point for a point-only element (label/signal/boundary)", () => {
    expect(elementBounds(label(5, 5))).toEqual({ minX: 5, minY: 5, maxX: 5, maxY: 5 });
  });

  it("spans the min/max of every point for a points-based element (trackPath/platform)", () => {
    const bounds = elementBounds(
      trackPath([
        { x: 10, y: 100 },
        { x: 50, y: 20 },
        { x: 30, y: 60 },
      ]),
    );
    expect(bounds).toEqual({ minX: 10, minY: 20, maxX: 50, maxY: 100 });
  });

  it("returns null for a points-based element with no points", () => {
    expect(elementBounds(trackPath([]))).toBeNull();
  });
});

describe("boundsIntersect", () => {
  it("true when two rectangles overlap", () => {
    expect(
      boundsIntersect(
        { minX: 0, minY: 0, maxX: 100, maxY: 100 },
        { minX: 50, minY: 50, maxX: 150, maxY: 150 },
      ),
    ).toBe(true);
  });

  it("true when one rectangle fully contains a point-shaped element's collapsed bounds", () => {
    expect(
      boundsIntersect(
        { minX: 0, minY: 0, maxX: 100, maxY: 100 },
        { minX: 50, minY: 50, maxX: 50, maxY: 50 },
      ),
    ).toBe(true);
  });

  it("false when two rectangles don't overlap at all", () => {
    expect(
      boundsIntersect(
        { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        { minX: 100, minY: 100, maxX: 200, maxY: 200 },
      ),
    ).toBe(false);
  });
});
