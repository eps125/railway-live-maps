import { describe, expect, it } from "vitest";
import type { Layer, MapElement } from "@railway/map-schema";
import {
  anchoredText,
  defaultLayerIdForTool,
  elementBounds,
  boundsIntersect,
  snapStep,
} from "./EditorCanvas.js";

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
    // Milestone 53: no dedicated lineside-feature layer exists, so a sign lands on Labels (the
    // "everything else" layer) rather than silently on Track.
    expect(defaultLayerIdForTool("neutralSection", standardLayers)).toBe("layer-labels");
  });

  it("places platform and platformNumber tools on a Platforms layer when one exists (ADR 0005 E3)", () => {
    const withPlatforms: Layer[] = [
      { id: "layer-track", name: "Track", order: 0, visible: true, locked: false },
      { id: "layer-platforms", name: "Platforms", order: 1, visible: true, locked: false },
      { id: "layer-berths", name: "Berths", order: 2, visible: true, locked: false },
    ];
    expect(defaultLayerIdForTool("platform", withPlatforms)).toBe("layer-platforms");
    expect(defaultLayerIdForTool("platformNumber", withPlatforms)).toBe("layer-platforms");
  });

  it("puts scenery on a Scenery layer when one exists, and a viaduct with the track", () => {
    // Milestone 55: a freshly seeded map has Scenery below Track (draftStore.ts). A viaduct
    // belongs with the track it carries (owner: "same layer as track").
    const withScenery: Layer[] = [
      { id: "layer-scenery", name: "Scenery", order: -1, visible: true, locked: false },
      ...standardLayers,
    ];
    expect(defaultLayerIdForTool("tunnel", withScenery)).toBe("layer-scenery");
    expect(defaultLayerIdForTool("water", withScenery)).toBe("layer-scenery");
    expect(defaultLayerIdForTool("viaduct", withScenery)).toBe("layer-track");
    // Milestone 63: a switched diamond is marked on the rails, so it belongs with the track too.
    expect(defaultLayerIdForTool("switchedDiamond", withScenery)).toBe("layer-track");
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

describe("snapStep", () => {
  it("puts platforms, platform numbers and neutral sections on half the grid step", () => {
    // Owner request 2026-09-20 for neutralSection: a full grid square is a coarse jump for a
    // sign that is only two squares across.
    expect(snapStep("platform", 10)).toBe(5);
    expect(snapStep("platformNumber", 10)).toBe(5);
    expect(snapStep("neutralSection", 10)).toBe(5);
    // Milestone 55: scenery is traced over real features, not aligned to the grid.
    expect(snapStep("tunnel", 10)).toBe(5);
    expect(snapStep("viaduct", 10)).toBe(5);
    expect(snapStep("water", 10)).toBe(5);
    // Milestone 63: a 1:2 diagonal crosses a horizontal between grid lines.
    expect(snapStep("switchedDiamond", 10)).toBe(5);
  });

  it("leaves everything else on the full grid step", () => {
    expect(snapStep("berth", 10)).toBe(10);
    expect(snapStep("signal", 10)).toBe(10);
    expect(snapStep("trackPath", 10)).toBe(10);
    expect(snapStep("label", 10)).toBe(10);
    expect(snapStep(undefined, 10)).toBe(10);
  });

  it("never returns a zero or fractional-to-nothing step for a tiny grid", () => {
    expect(snapStep("neutralSection", 1)).toBe(1);
  });
});

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

  it("uses the whole board for a neutral section, whose x/y is its centre (Milestone 53)", () => {
    const sign: MapElement = {
      id: "ns-1",
      layerId: "l",
      zIndex: 0,
      type: "neutralSection",
      x: 100,
      y: 50,
      size: 20,
      labelPosition: "below",
      fontSize: 10,
    };
    expect(elementBounds(sign)).toEqual({ minX: 90, minY: 40, maxX: 110, maxY: 60 });
  });

  it("gives a switched diamond a box around its crossing point, for rubber-band select (Milestone 63)", () => {
    const diamond: MapElement = {
      id: "sd-1",
      layerId: "l",
      zIndex: 1,
      type: "switchedDiamond",
      x: 100,
      y: 50,
      corners: ["a"],
      style: "knuckle",
    };
    const bounds = elementBounds(diamond)!;
    expect(bounds.minX).toBeLessThan(100);
    expect(bounds.maxX).toBeGreaterThan(100);
    expect(bounds.minY).toBeLessThan(50);
    expect(bounds.maxY).toBeGreaterThan(50);
  });

  it("returns null for a points-based element with no points", () => {
    expect(elementBounds(trackPath([]))).toBeNull();
  });
});

describe("anchoredText (editor ↔ public renderer text placement parity)", () => {
  it("left align keeps x/y and only lifts to the baseline — matches SVG text-anchor:start", () => {
    expect(anchoredText(100, 50, 16, "left")).toEqual({ x: 100, y: 50, offsetY: 16 * 0.8 });
  });

  it("center align gives a box whose centre lands on x — matches text-anchor:middle", () => {
    const p = anchoredText(100, 50, 16, "center");
    expect(p.align).toBe("center");
    expect(p.x).toBe(100);
    // rendered horizontal centre = x - offsetX + width/2
    expect(p.x - (p.offsetX ?? 0) + (p.width ?? 0) / 2).toBe(100);
  });

  it("right align puts the box's right edge on x — matches text-anchor:end", () => {
    const p = anchoredText(100, 50, 16, "right");
    expect(p.align).toBe("right");
    // rendered right edge = x - offsetX + width
    expect(p.x - (p.offsetX ?? 0) + (p.width ?? 0)).toBe(100);
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
