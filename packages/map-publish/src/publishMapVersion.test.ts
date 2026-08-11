import { describe, expect, it } from "vitest";
import type { MapDocument } from "@railway/map-schema";
import { trimCanvasToContent } from "./publishMapVersion.js";

function baseDoc(overrides: Partial<MapDocument> = {}): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      // Deliberately way larger than any element actually placed — this is exactly what an
      // editor working on a viewport-following "infinite" canvas leaves behind (nothing keeps
      // it in sync with real content anymore; that's what publishing is for).
      canvas: { width: 5000, height: 5000, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", visible: true, locked: false, order: 0 }],
    elements: [],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
    ...overrides,
  };
}

describe("trimCanvasToContent", () => {
  it("shrinks canvas.width/height to fit real element positions, padded", () => {
    const doc = baseDoc({
      elements: [
        {
          id: "berth-1",
          layerId: "l",
          zIndex: 0,
          type: "berth",
          x: 100,
          y: 100,
          width: 60,
          height: 24,
          textAlign: "center",
          fontSize: 12,
          displayName: "B",
        },
        {
          id: "berth-2",
          layerId: "l",
          zIndex: 0,
          type: "berth",
          x: 300,
          y: 200,
          width: 60,
          height: 24,
          textAlign: "center",
          fontSize: 12,
          displayName: "B2",
        },
      ],
    });

    const trimmed = trimCanvasToContent(doc);
    // Real span is x: 100->300 (200), y: 100->200 (100), plus 40px padding on each side.
    expect(trimmed.map.canvas.width).toBe(200 + 80);
    expect(trimmed.map.canvas.height).toBe(100 + 80);
  });

  it("includes every point of a points-based element (trackPath/platform), not just its start", () => {
    const doc = baseDoc({
      elements: [
        {
          id: "track-1",
          layerId: "l",
          zIndex: 0,
          type: "trackPath",
          points: [
            { x: 0, y: 0 },
            { x: 500, y: 50 },
          ],
        },
      ],
    });

    const trimmed = trimCanvasToContent(doc);
    expect(trimmed.map.canvas.width).toBe(500 + 80);
    expect(trimmed.map.canvas.height).toBe(50 + 80);
  });

  it("floors at a sane minimum for a document with no elements, never zero/negative", () => {
    const trimmed = trimCanvasToContent(baseDoc({ elements: [] }));
    expect(trimmed.map.canvas.width).toBeGreaterThan(0);
    expect(trimmed.map.canvas.height).toBeGreaterThan(0);
  });

  it("leaves gridSize untouched", () => {
    const trimmed = trimCanvasToContent(baseDoc());
    expect(trimmed.map.canvas.gridSize).toBe(10);
  });

  it("does not mutate the input document", () => {
    const doc = baseDoc();
    const originalCanvas = doc.map.canvas;
    trimCanvasToContent(doc);
    expect(doc.map.canvas).toBe(originalCanvas);
  });
});
