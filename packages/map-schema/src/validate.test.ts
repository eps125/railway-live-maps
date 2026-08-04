import { describe, expect, it } from "vitest";
import { validateMapDocument } from "./validate.js";

function baseDoc(overrides: Record<string, unknown> = {}) {
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

describe("validateMapDocument", () => {
  it("is valid for a minimal well-formed document", () => {
    const result = validateMapDocument(baseDoc());
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("flags schema-invalid input without throwing", () => {
    const result = validateMapDocument({ not: "a map document" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("flags duplicate element ids", () => {
    const doc = baseDoc({
      elements: [
        { id: "e1", layerId: "l1", type: "label", x: 0, y: 0, text: "a" },
        { id: "e1", layerId: "l1", type: "label", x: 1, y: 1, text: "b" },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "duplicate_element_id")).toBe(true);
  });

  it("flags an element referencing a missing layer", () => {
    const doc = baseDoc({
      elements: [{ id: "e1", layerId: "does-not-exist", type: "label", x: 0, y: 0, text: "a" }],
    });
    const result = validateMapDocument(doc);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "missing_layer", elementId: "e1" }),
    );
  });

  it("flags a topology edge referencing a missing node", () => {
    const doc = baseDoc({
      topology: {
        nodes: [{ id: "n1", x: 0, y: 0 }],
        edges: [{ id: "edge-1", fromNodeId: "n1", toNodeId: "n2" }],
      },
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "topology_edge_missing_node")).toBe(true);
  });

  it("flags a berth element with no binding", () => {
    const doc = baseDoc({
      elements: [
        {
          id: "berth-1",
          layerId: "l1",
          type: "berth",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          displayName: "1008",
        },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "missing_berth_binding")).toBe(true);
  });

  it("flags a berth element whose binding id doesn't resolve", () => {
    const doc = baseDoc({
      elements: [
        {
          id: "berth-1",
          layerId: "l1",
          type: "berth",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          displayName: "1008",
          bindingId: "does-not-exist",
        },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "invalid_berth_binding")).toBe(true);
  });

  it("accepts a valid berth binding", () => {
    const doc = baseDoc({
      elements: [
        {
          id: "berth-1",
          layerId: "l1",
          type: "berth",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          displayName: "1008",
          bindingId: "bind-1",
        },
      ],
      bindings: [
        { id: "bind-1", elementId: "berth-1", type: "tdBerth", tdArea: "PX", berth: "1008" },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.valid).toBe(true);
  });

  it("flags a duplicate berth binding unless allowDuplicate is set", () => {
    const doc = baseDoc({
      bindings: [
        { id: "bind-1", elementId: "berth-1", type: "tdBerth", tdArea: "PX", berth: "1008" },
        { id: "bind-2", elementId: "berth-2", type: "tdBerth", tdArea: "PX", berth: "1008" },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "duplicate_berth_binding")).toBe(true);
  });

  it("allows a duplicate berth binding when allowDuplicate is set on one of them", () => {
    const doc = baseDoc({
      bindings: [
        {
          id: "bind-1",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "1008",
          allowDuplicate: true,
        },
        { id: "bind-2", elementId: "berth-2", type: "tdBerth", tdArea: "PX", berth: "1008" },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "duplicate_berth_binding")).toBe(false);
  });
});
