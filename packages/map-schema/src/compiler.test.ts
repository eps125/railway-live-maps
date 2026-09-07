import { describe, expect, it } from "vitest";
import { MapDocumentSchema, type Layer, type MapElement } from "./document.js";
import {
  compileMapDocument,
  sortElementsForPaint,
  weldTrackPaths,
  Z_INDEX_LAYER_BAND,
} from "./compiler.js";

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

  it("elementsById iterates in paint order (layer order, not document array order)", () => {
    // doc declares elements track-1, berth-1, signal-1, boundary-1, but all four share layer l1
    // — add a second doc with elements deliberately out of layer order to prove the compiler
    // reorders rather than trusting document array order.
    const outOfOrderDoc = MapDocumentSchema.parse({
      ...doc,
      layers: [
        { id: "signals", name: "Signals", order: 2 },
        { id: "track", name: "Track", order: 0 },
      ],
      elements: [
        { id: "sig", layerId: "signals", type: "signal", x: 0, y: 0 },
        {
          id: "trk",
          layerId: "track",
          type: "trackPath",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      ],
    });
    const bundle = compileMapDocument(outOfOrderDoc);
    expect(Object.keys(bundle.elementsById)).toEqual(["trk", "sig"]);
  });
});

describe("weldTrackPaths (ADR 0004 D2 — junction-gap fix)", () => {
  const layers = [{ id: "l1", name: "Track", order: 0, visible: true, locked: false }];

  function track(
    id: string,
    points: Array<{ x: number; y: number }>,
    extra: Partial<MapElement> = {},
  ): MapElement {
    return { id, layerId: "l1", zIndex: 0, type: "trackPath", points, ...extra } as MapElement;
  }

  it("merges two topology-joined coincident segments into one polyline", () => {
    const a = track(
      "a",
      [
        { x: 0, y: 100 },
        { x: 100, y: 100 },
      ],
      { topologyEdgeId: "e1" },
    );
    const b = track(
      "b",
      [
        { x: 100, y: 100 },
        { x: 160, y: 130 },
      ],
      { topologyEdgeId: "e2" },
    );
    const topology = {
      nodes: [
        { id: "n1", x: 0, y: 100 },
        { id: "n2", x: 100, y: 100 },
        { id: "n3", x: 160, y: 130 },
      ],
      edges: [
        { id: "e1", fromNodeId: "n1", toNodeId: "n2" },
        { id: "e2", fromNodeId: "n2", toNodeId: "n3" },
      ],
    };
    const { elements, remap } = weldTrackPaths([a, b], topology);
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      id: "a",
      points: [
        { x: 0, y: 100 },
        { x: 100, y: 100 },
        { x: 160, y: 130 },
      ],
    });
    expect(remap).toEqual({ b: "a" });
  });

  it("re-points a berth's trackElementId at the surviving segment", () => {
    const a = track(
      "a",
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
      ],
      { topologyEdgeId: "e1" },
    );
    const b = track(
      "b",
      [
        { x: 50, y: 0 },
        { x: 90, y: 20 },
      ],
      { topologyEdgeId: "e1" },
    );
    const berth: MapElement = {
      id: "brt",
      layerId: "l1",
      zIndex: 0,
      type: "berth",
      x: 10,
      y: -10,
      width: 20,
      height: 10,
      textAlign: "center",
      fontSize: 12,
      displayName: "X",
      trackElementId: "b",
    } as MapElement;
    const { elements } = weldTrackPaths([a, b, berth], { nodes: [], edges: [] });
    const rewrittenBerth = elements.find((e) => e.id === "brt");
    expect(rewrittenBerth).toMatchObject({ trackElementId: "a" });
  });

  it("does not merge a purely visual crossing with no topology", () => {
    const a = track("a", [
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ]);
    const b = track("b", [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ]);
    const { elements, remap } = weldTrackPaths([a, b], { nodes: [], edges: [] });
    expect(elements).toHaveLength(2);
    expect(remap).toEqual({});
  });

  it("does not merge segments on different lines", () => {
    const a = track(
      "a",
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      {
        topologyEdgeId: "e1",
        line: "Up Main",
      },
    );
    const b = track(
      "b",
      [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ],
      {
        topologyEdgeId: "e1",
        line: "Down Main",
      },
    );
    const { elements } = weldTrackPaths([a, b], { nodes: [], edges: [] });
    expect(elements).toHaveLength(2);
  });

  it("compileMapDocument welds through the full pipeline", () => {
    const doc = MapDocumentSchema.parse({
      schemaVersion: 1,
      map: {
        id: "m",
        name: "M",
        canvas: { width: 300, height: 300, gridSize: 10 },
        timezone: "Europe/London",
      },
      layers,
      elements: [
        {
          id: "a",
          layerId: "l1",
          type: "trackPath",
          topologyEdgeId: "e1",
          points: [
            { x: 0, y: 100 },
            { x: 100, y: 100 },
          ],
        },
        {
          id: "b",
          layerId: "l1",
          type: "trackPath",
          topologyEdgeId: "e1",
          points: [
            { x: 100, y: 100 },
            { x: 160, y: 130 },
          ],
        },
      ],
      topology: { nodes: [], edges: [] },
      bindings: [],
      editorMetadata: {},
    });
    const bundle = compileMapDocument(doc);
    expect(Object.keys(bundle.elementsById)).toEqual(["a"]);
  });
});

describe("sortElementsForPaint", () => {
  const layers: Layer[] = [
    { id: "track", name: "Track", order: 0, visible: true, locked: false },
    { id: "berths", name: "Berths", order: 1, visible: true, locked: false },
    { id: "signals", name: "Signals", order: 2, visible: true, locked: false },
    { id: "labels", name: "Labels", order: 3, visible: true, locked: false },
  ];

  function el(id: string, layerId: string, zIndex = 0): MapElement {
    return {
      id,
      layerId,
      zIndex,
      type: "label",
      x: 0,
      y: 0,
      text: id,
      align: "left",
      fontSize: 12,
    };
  }

  it("defaults to layer order: tracks < berths < signals < everything else", () => {
    const elements = [
      el("label", "labels"),
      el("signal", "signals"),
      el("berth", "berths"),
      el("track", "track"),
    ];
    const sorted = sortElementsForPaint(elements, layers).map((e) => e.id);
    expect(sorted).toEqual(["track", "berth", "signal", "label"]);
  });

  it("a small zIndex nudge reorders within the same layer only", () => {
    const elements = [
      el("berth-a", "berths"),
      el("berth-b", "berths", -1),
      el("signal", "signals"),
    ];
    const sorted = sortElementsForPaint(elements, layers).map((e) => e.id);
    // berth-b (zIndex -1) moves before berth-a within the berths layer, but neither crosses into
    // the track layer below or the signals layer above.
    expect(sorted).toEqual(["berth-b", "berth-a", "signal"]);
  });

  it("a zIndex large enough to exceed the layer band deliberately overrides layer order", () => {
    // The user's stated need: sink a specific signal below a specific berth, even though signals
    // (order 2) are above berths (order 1) by default.
    const elements = [el("berth", "berths"), el("signal-sunk", "signals", -Z_INDEX_LAYER_BAND - 1)];
    const sorted = sortElementsForPaint(elements, layers).map((e) => e.id);
    expect(sorted).toEqual(["signal-sunk", "berth"]);
  });

  it("ties (equal effective order) keep document array order — stable sort", () => {
    const elements = [el("first", "track"), el("second", "track")];
    expect(sortElementsForPaint(elements, layers).map((e) => e.id)).toEqual(["first", "second"]);
    expect(sortElementsForPaint([...elements].reverse(), layers).map((e) => e.id)).toEqual([
      "second",
      "first",
    ]);
  });

  it("an element referencing an unknown layerId sorts last", () => {
    const elements = [el("label", "labels"), el("orphan", "does-not-exist")];
    expect(sortElementsForPaint(elements, layers).map((e) => e.id)).toEqual(["label", "orphan"]);
  });
});
