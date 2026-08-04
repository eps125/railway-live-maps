import { describe, expect, it } from "vitest";
import { MapDocumentSchema } from "./document.js";
import { compileMapDocument } from "./compiler.js";

const doc = MapDocumentSchema.parse({
  schemaVersion: 1,
  map: {
    id: "test",
    name: "Test",
    canvas: { width: 100, height: 100, gridSize: 10 },
    timezone: "Europe/London",
  },
  layers: [{ id: "l1", name: "Track", order: 0 }],
  elements: [
    {
      id: "track-1",
      layerId: "l1",
      type: "trackPath",
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 20 },
      ],
    },
    {
      id: "berth-1",
      layerId: "l1",
      type: "berth",
      x: 10,
      y: 10,
      width: 20,
      height: 10,
      displayName: "1008",
      bindingId: "bind-1",
    },
    { id: "signal-1", layerId: "l1", type: "signal", x: 30, y: 30 },
    {
      id: "boundary-1",
      layerId: "l1",
      type: "boundary",
      x: 0,
      y: 0,
      name: "North",
      adjacentMapSlug: "carnforth",
    },
  ],
  topology: {
    nodes: [
      { id: "n1", x: 0, y: 0 },
      { id: "n2", x: 50, y: 0 },
    ],
    edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2" }],
  },
  bindings: [{ id: "bind-1", elementId: "berth-1", type: "tdBerth", tdArea: "PX", berth: "1008" }],
  editorMetadata: { secretDraftNotes: "should not appear in compiled output" },
});

describe("compileMapDocument", () => {
  it("builds an element-by-id lookup", () => {
    const bundle = compileMapDocument(doc);
    expect(bundle.elementsById["berth-1"]?.id).toBe("berth-1");
    expect(bundle.elementsById["signal-1"]?.id).toBe("signal-1");
  });

  it("builds the berth binding index keyed by tdArea|berth", () => {
    const bundle = compileMapDocument(doc);
    expect(bundle.berthBindingIndex["PX|1008"]).toBe("berth-1");
  });

  it("computes a bounding box covering every element", () => {
    const bundle = compileMapDocument(doc);
    expect(bundle.boundingBox).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 30 });
  });

  it("builds bidirectional topology adjacency", () => {
    const bundle = compileMapDocument(doc);
    expect(bundle.topologyAdjacency["n1"]).toEqual(["n2"]);
    expect(bundle.topologyAdjacency["n2"]).toEqual(["n1"]);
  });

  it("collects boundary continuation links", () => {
    const bundle = compileMapDocument(doc);
    expect(bundle.continuationLinks).toEqual([
      { elementId: "boundary-1", adjacentMapSlug: "carnforth", direction: undefined },
    ]);
  });

  it("strips editorMetadata from the compiled bundle", () => {
    const bundle = compileMapDocument(doc);
    expect(bundle).not.toHaveProperty("editorMetadata");
  });
});
