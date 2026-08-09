import { describe, expect, it } from "vitest";
import type { Layer } from "@railway/map-schema";
import { defaultLayerIdForTool } from "./EditorCanvas.js";

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
