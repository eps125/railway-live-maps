import { describe, expect, it } from "vitest";
import type { MapDocument } from "@railway/map-schema";
import { applyCommand, type EditorCommand } from "./commands.js";

function baseDoc(): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 1000, height: 500, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [
      { id: "l1", name: "Layer 1", visible: true, locked: false, order: 0 },
      { id: "l2", name: "Layer 2", visible: true, locked: false, order: 1 },
    ],
    elements: [
      {
        id: "berth-1",
        layerId: "l1",
        type: "berth",
        x: 10,
        y: 20,
        width: 40,
        height: 20,
        textAlign: "center",
        fontSize: 12,
        displayName: "Berth 1",
        bindingId: "bind-1",
      },
      {
        id: "track-1",
        layerId: "l1",
        type: "trackPath",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
    ],
    topology: {
      nodes: [
        { id: "n1", x: 0, y: 0 },
        { id: "n2", x: 100, y: 0 },
      ],
      edges: [],
    },
    bindings: [
      {
        id: "bind-1",
        elementId: "berth-1",
        type: "tdBerth",
        tdArea: "ZZ",
        berth: "0001",
        allowDuplicate: false,
      },
    ],
    editorMetadata: {},
  };
}

function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

/** Applies the command, then applies the returned inverse, and asserts the round trip restores
 * the exact same set of elements/bindings/layers/topology — order-independent for
 * elements/bindings, since `deleteElements`'s inverse (`addElement`) appends rather than
 * reinserting at the original array index; a documented MVP simplification (array position
 * within a layer isn't currently a modeled z-order signal, layers themselves are). */
function expectRoundTrip(doc: MapDocument, command: EditorCommand): MapDocument {
  const { doc: applied, inverse } = applyCommand(doc, command);
  const { doc: restored } = applyCommand(applied, inverse);
  expect(byId(restored.elements)).toEqual(byId(doc.elements));
  expect(byId(restored.bindings)).toEqual(byId(doc.bindings));
  expect(restored.layers).toEqual(doc.layers);
  expect(restored.topology).toEqual(doc.topology);
  return applied;
}

describe("applyCommand", () => {
  it("addElement adds elements (+ bindings), inverse deletes them back to the original", () => {
    const doc = baseDoc();
    const newElement = {
      id: "label-1",
      layerId: "l2",
      type: "label" as const,
      x: 5,
      y: 5,
      text: "New",
      align: "left" as const,
      fontSize: 12,
    };
    const applied = expectRoundTrip(doc, { type: "addElement", elements: [newElement] });
    expect(applied.elements.map((e) => e.id)).toContain("label-1");
  });

  it("deleteElements removes an element and its binding, inverse restores both exactly", () => {
    const doc = baseDoc();
    const applied = expectRoundTrip(doc, { type: "deleteElements", elementIds: ["berth-1"] });
    expect(applied.elements.map((e) => e.id)).not.toContain("berth-1");
    expect(applied.bindings).toHaveLength(0);
  });

  it("moveElements shifts x/y for position-based elements and points for path elements, inverse restores exactly", () => {
    const doc = baseDoc();
    const applied = expectRoundTrip(doc, {
      type: "moveElements",
      elementIds: ["berth-1", "track-1"],
      dx: 5,
      dy: -3,
    });
    const berth = applied.elements.find((e) => e.id === "berth-1")!;
    expect(berth).toMatchObject({ x: 15, y: 17 });
    const track = applied.elements.find((e) => e.id === "track-1")! as Extract<
      MapDocument["elements"][number],
      { points: unknown }
    >;
    expect(track.points).toEqual([
      { x: 5, y: -3 },
      { x: 105, y: -3 },
    ]);
  });

  it("resizeElement changes width/height, inverse restores the original size", () => {
    const doc = baseDoc();
    const applied = expectRoundTrip(doc, {
      type: "resizeElement",
      elementId: "berth-1",
      width: 80,
      height: 30,
    });
    const berth = applied.elements.find((e) => e.id === "berth-1")!;
    expect(berth).toMatchObject({ width: 80, height: 30 });
  });

  it("setProperty changes an arbitrary field, inverse restores the previous value", () => {
    const doc = baseDoc();
    const applied = expectRoundTrip(doc, {
      type: "setProperty",
      elementId: "berth-1",
      property: "displayName",
      value: "Renamed",
    });
    const berth = applied.elements.find((e) => e.id === "berth-1")!;
    expect(berth).toMatchObject({ displayName: "Renamed" });
  });

  it("setBinding replaces a binding and updates the element's bindingId, inverse restores the previous binding", () => {
    const doc = baseDoc();
    const newBinding = {
      id: "bind-2",
      elementId: "berth-1",
      type: "tdBerth" as const,
      tdArea: "YY",
      berth: "9999",
      allowDuplicate: false,
    };
    const applied = expectRoundTrip(doc, {
      type: "setBinding",
      elementId: "berth-1",
      binding: newBinding,
    });
    expect(applied.bindings).toEqual([newBinding]);
    const berth = applied.elements.find((e) => e.id === "berth-1")!;
    expect(berth).toMatchObject({ bindingId: "bind-2" });
  });

  it("setBinding to null clears the binding, inverse restores it", () => {
    const doc = baseDoc();
    const applied = expectRoundTrip(doc, {
      type: "setBinding",
      elementId: "berth-1",
      binding: null,
    });
    expect(applied.bindings).toEqual([]);
    const berth = applied.elements.find((e) => e.id === "berth-1")!;
    expect(berth).toMatchObject({ bindingId: undefined });
  });

  it("connectTopology adds an edge, inverse (disconnectTopology) removes it exactly", () => {
    const doc = baseDoc();
    const edge = { id: "e1", fromNodeId: "n1", toNodeId: "n2", trackElementId: "track-1" };
    const applied = expectRoundTrip(doc, { type: "connectTopology", edge });
    expect(applied.topology.edges).toEqual([edge]);
  });

  it("disconnectTopology removes an edge, inverse (connectTopology) restores it exactly", () => {
    const doc = { ...baseDoc() };
    const edge = { id: "e1", fromNodeId: "n1", toNodeId: "n2" };
    doc.topology = { ...doc.topology, edges: [edge] };
    const applied = expectRoundTrip(doc, { type: "disconnectTopology", edgeId: "e1" });
    expect(applied.topology.edges).toEqual([]);
  });

  it("reorderLayer changes a layer's order, inverse restores the previous order", () => {
    const doc = baseDoc();
    const applied = expectRoundTrip(doc, { type: "reorderLayer", layerId: "l1", newOrder: 5 });
    const layer = applied.layers.find((l) => l.id === "l1")!;
    expect(layer.order).toBe(5);
  });

  it("setLayerProperty toggles visibility, inverse restores it", () => {
    const doc = baseDoc();
    const applied = expectRoundTrip(doc, {
      type: "setLayerProperty",
      layerId: "l1",
      property: "visible",
      value: false,
    });
    const layer = applied.layers.find((l) => l.id === "l1")!;
    expect(layer.visible).toBe(false);
  });
});
