import { describe, expect, it } from "vitest";
import { MapDocumentSchema } from "./document.js";

function minimalDoc(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    map: {
      id: "test",
      name: "Test",
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l1", name: "Track", order: 0 }],
    elements: [],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
    ...overrides,
  };
}

describe("MapDocumentSchema", () => {
  it("accepts a minimal valid document", () => {
    const result = MapDocumentSchema.safeParse(minimalDoc());
    expect(result.success).toBe(true);
  });

  it("rejects an unsupported element type", () => {
    const result = MapDocumentSchema.safeParse(
      minimalDoc({ elements: [{ id: "e1", layerId: "l1", type: "unknownThing" }] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a schemaVersion other than 1", () => {
    const result = MapDocumentSchema.safeParse(minimalDoc({ schemaVersion: 2 }));
    expect(result.success).toBe(false);
  });

  it("accepts every MVP element type", () => {
    const doc = minimalDoc({
      elements: [
        {
          id: "track-1",
          layerId: "l1",
          type: "trackPath",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: "berth-1",
          layerId: "l1",
          type: "berth",
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          displayName: "1008",
          bindingId: "bind-1",
        },
        { id: "signal-1", layerId: "l1", type: "signal", x: 5, y: 5 },
        {
          id: "platform-1",
          layerId: "l1",
          type: "platform",
          points: [
            { x: 0, y: 0 },
            { x: 5, y: 0 },
          ],
        },
        { id: "label-1", layerId: "l1", type: "label", x: 0, y: 0, text: "Lancaster" },
        { id: "boundary-1", layerId: "l1", type: "boundary", x: 0, y: 0, name: "North" },
      ],
      bindings: [
        { id: "bind-1", elementId: "berth-1", type: "tdBerth", tdArea: "PX", berth: "1008" },
      ],
    });

    const result = MapDocumentSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });
});
