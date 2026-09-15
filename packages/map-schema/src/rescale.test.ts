import { describe, expect, it } from "vitest";
import { rescaleMapDocument } from "./rescale.js";
import type { MapDocument } from "./document.js";

function doc(overrides: Partial<MapDocument> = {}): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "test",
      name: "Test",
      canvas: { width: 2000, height: 800, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l1", name: "Track", visible: true, locked: false, order: 0 }],
    elements: [],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
    ...overrides,
  };
}

describe("rescaleMapDocument", () => {
  it("scales canvas width, height and gridSize", () => {
    const result = rescaleMapDocument(doc(), 1.5);
    expect(result.map.canvas).toEqual({ width: 3000, height: 1200, gridSize: 15 });
  });

  it("scales trackPath and platform points, both x and y", () => {
    const result = rescaleMapDocument(
      doc({
        elements: [
          {
            id: "t1",
            layerId: "l1",
            zIndex: 0,
            type: "trackPath",
            points: [
              { x: 0, y: 30 },
              { x: 100, y: 30 },
            ],
          },
          {
            id: "p1",
            layerId: "l1",
            zIndex: 0,
            type: "platform",
            points: [
              { x: 10, y: 20 },
              { x: 60, y: 20 },
            ],
          },
        ],
      }),
      1.5,
    );
    const track = result.elements[0];
    const platform = result.elements[1];
    expect(track?.type).toBe("trackPath");
    if (track?.type === "trackPath") {
      expect(track.points).toEqual([
        { x: 0, y: 45 },
        { x: 150, y: 45 },
      ]);
    }
    expect(platform?.type).toBe("platform");
    if (platform?.type === "platform") {
      expect(platform.points).toEqual([
        { x: 15, y: 30 },
        { x: 90, y: 30 },
      ]);
    }
  });

  it("scales a berth's x/y position but NOT its width/height (fixed furniture size)", () => {
    const result = rescaleMapDocument(
      doc({
        elements: [
          {
            id: "b1",
            layerId: "l1",
            zIndex: 0,
            type: "berth",
            x: 20,
            y: 30,
            width: 32,
            height: 20,
            textAlign: "center",
            fontSize: 12,
            displayName: "1008",
          },
        ],
      }),
      1.5,
    );
    const berth = result.elements[0];
    expect(berth).toMatchObject({ x: 30, y: 45, width: 32, height: 20 });
  });

  it("scales x/y for signal/platformNumber/station/label/boundary but not fontSize or orientation", () => {
    const result = rescaleMapDocument(
      doc({
        elements: [
          {
            id: "sig1",
            layerId: "l1",
            zIndex: 0,
            type: "signal",
            x: 10,
            y: 20,
            orientation: 90,
            symbolStyle: "signal-blank",
          },
          {
            id: "pn1",
            layerId: "l1",
            zIndex: 0,
            type: "platformNumber",
            x: 10,
            y: 20,
            text: "1",
            fontSize: 10,
          },
          {
            id: "stn1",
            layerId: "l1",
            zIndex: 0,
            type: "station",
            x: 10,
            y: 20,
            name: "Lancaster",
            fontSize: 16,
          },
          {
            id: "lbl1",
            layerId: "l1",
            zIndex: 0,
            type: "label",
            x: 10,
            y: 20,
            text: "Note",
            align: "center",
            fontSize: 12,
          },
          { id: "bnd1", layerId: "l1", zIndex: 0, type: "boundary", x: 10, y: 20, name: "North" },
        ],
      }),
      1.5,
    );
    expect(result.elements[0]).toMatchObject({ x: 15, y: 30, orientation: 90 });
    expect(result.elements[1]).toMatchObject({ x: 15, y: 30, fontSize: 10 });
    expect(result.elements[2]).toMatchObject({ x: 15, y: 30, fontSize: 16 });
    expect(result.elements[3]).toMatchObject({ x: 15, y: 30, fontSize: 12 });
    expect(result.elements[4]).toMatchObject({ x: 15, y: 30 });
  });

  it("scales topology node positions", () => {
    const result = rescaleMapDocument(
      doc({
        topology: {
          nodes: [{ id: "n1", x: 10, y: 20 }],
          edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n1" }],
        },
      }),
      1.5,
    );
    expect(result.topology.nodes).toEqual([{ id: "n1", x: 15, y: 30 }]);
    expect(result.topology.edges).toEqual([{ id: "e1", fromNodeId: "n1", toNodeId: "n1" }]);
  });

  it("leaves bindings, layers and editorMetadata untouched", () => {
    const input = doc({
      bindings: [
        {
          id: "bind-1",
          elementId: "b1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "1008",
          allowDuplicate: false,
        },
      ],
      editorMetadata: { anything: "goes" },
    });
    const result = rescaleMapDocument(input, 1.5);
    expect(result.bindings).toEqual(input.bindings);
    expect(result.layers).toEqual(input.layers);
    expect(result.editorMetadata).toEqual(input.editorMetadata);
  });

  it("is invertible with the reciprocal scale (up to floating point) — the fallback if a --restore snapshot weren't available", () => {
    const originalPoints = [
      { x: 12, y: 24 },
      { x: 96, y: 24 },
    ];
    const original = doc({
      elements: [{ id: "t1", layerId: "l1", zIndex: 0, type: "trackPath", points: originalPoints }],
    });
    const scaled = rescaleMapDocument(original, 1.5);
    const restored = rescaleMapDocument(scaled, 1 / 1.5);
    const el = restored.elements[0];
    if (el?.type !== "trackPath") throw new Error("expected a trackPath element");
    el.points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(originalPoints[i]!.x);
      expect(p.y).toBeCloseTo(originalPoints[i]!.y);
    });
  });
});
