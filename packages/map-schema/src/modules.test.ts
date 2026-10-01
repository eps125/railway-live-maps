import { describe, expect, it } from "vitest";
import type { MapDocument, MapElement } from "./document.js";
import { MapDocumentSchema } from "./document.js";
import { flattenAssembledMap, joinTrackEnds, qualifyId } from "./modules.js";
import { validateMapDocument } from "./validate.js";

function doc(partial: Partial<MapDocument> & { id: string }): MapDocument {
  return MapDocumentSchema.parse({
    schemaVersion: 1,
    map: {
      id: partial.id,
      name: partial.id,
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "layer-track", name: "Track", visible: true, locked: false, order: 0 }],
    ...partial,
  });
}

function track(id: string, points: Array<[number, number]>): MapElement {
  return {
    id,
    type: "trackPath",
    layerId: "layer-track",
    zIndex: 0,
    points: points.map(([x, y]) => ({ x, y })),
  } as MapElement;
}

/** Two parallel tracks from x=0 to x=200 at y=0 and y=30, with joins at each end. */
function twoTrackModule(id: string): MapDocument {
  return doc({
    id,
    elements: [
      track("up", [
        [0, 0],
        [200, 0],
      ]),
      track("down", [
        [0, 30],
        [200, 30],
      ]),
      {
        id: "berth-1",
        type: "berth",
        layerId: "layer-track",
        zIndex: 0,
        x: 50,
        y: -20,
        width: 40,
        height: 16,
        textAlign: "center",
        fontSize: 12,
        displayName: "0101",
        trackElementId: "up",
      } as MapElement,
    ],
    bindings: [
      {
        id: "b1",
        elementId: "berth-1",
        type: "tdBerth",
        tdArea: "PX",
        berth: "0101",
        allowDuplicate: false,
      },
    ],
    joins: [
      {
        id: "west",
        name: "West",
        points: [
          { x: 0, y: -10 },
          { x: 0, y: 40 },
        ],
      },
      {
        id: "east",
        name: "East",
        points: [
          { x: 200, y: -10 },
          { x: 200, y: 40 },
        ],
      },
    ],
  });
}

describe("joinTrackEnds", () => {
  it("finds the track ends on a join, in order along it", () => {
    const module = twoTrackModule("m");
    expect(joinTrackEnds(module.elements, module.joins![1]!)).toEqual([
      { x: 200, y: 0 },
      { x: 200, y: 30 },
    ]);
  });
});

describe("flattenAssembledMap", () => {
  it("places the first module where it is put and attaches the next by its joins", () => {
    const a = twoTrackModule("a");
    const b = twoTrackModule("b");
    const source = doc({
      id: "assembled",
      modules: [
        { slug: "a", placement: { kind: "at", x: 100, y: 50 } },
        { slug: "b", placement: { kind: "attached", join: "west", to: "a", toJoin: "east" } },
      ],
    });

    const result = flattenAssembledMap(
      source,
      new Map([
        ["a", a],
        ["b", b],
      ]),
    );

    expect(result.issues).toEqual([]);
    expect(result.placements).toEqual([
      { slug: "a", dx: 100, dy: 50 },
      { slug: "b", dx: 300, dy: 50 },
    ]);
    const bUp = result.doc.elements.find((e) => e.id === "b/up");
    expect(bUp && "points" in bUp ? bUp.points : null).toEqual([
      { x: 300, y: 50 },
      { x: 500, y: 50 },
    ]);
    // References and bindings are qualified with the module, positions moved.
    const bBerth = result.doc.elements.find((e) => e.id === "b/berth-1");
    expect(bBerth).toMatchObject({ x: 350, y: 30, trackElementId: "b/up" });
    expect(result.doc.bindings.map((binding) => [binding.id, binding.elementId])).toEqual([
      ["a/b1", "a/berth-1"],
      ["b/b1", "b/berth-1"],
    ]);
    // Joins are not published.
    expect(result.doc.joins).toBeUndefined();
    expect(result.doc.modules).toBeUndefined();
  });

  it("follows a module that grows: everything attached beyond it moves along", () => {
    const a = twoTrackModule("a");
    const longer: MapDocument = {
      ...a,
      elements: a.elements.map((e) =>
        e.type === "trackPath"
          ? { ...e, points: [e.points[0]!, { x: 260, y: e.points[1]!.y }] }
          : e,
      ),
      joins: [
        a.joins![0]!,
        {
          id: "east",
          name: "East",
          points: [
            { x: 260, y: -10 },
            { x: 260, y: 40 },
          ],
        },
      ],
    };
    const source = doc({
      id: "assembled",
      modules: [
        { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
        { slug: "b", placement: { kind: "attached", join: "west", to: "a", toJoin: "east" } },
      ],
    });
    const result = flattenAssembledMap(
      source,
      new Map([
        ["a", longer],
        ["b", twoTrackModule("b")],
      ]),
    );
    expect(result.placements[1]).toEqual({ slug: "b", dx: 260, dy: 0 });
  });

  it("attaches a module drawn the other way round", () => {
    const a = twoTrackModule("a");
    const b = twoTrackModule("b");
    // b's west join drawn bottom-to-top.
    b.joins![0] = {
      id: "west",
      name: "West",
      points: [
        { x: 0, y: 40 },
        { x: 0, y: -10 },
      ],
    };
    const result = flattenAssembledMap(
      doc({
        id: "assembled",
        modules: [
          { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
          { slug: "b", placement: { kind: "attached", join: "west", to: "a", toJoin: "east" } },
        ],
      }),
      new Map([
        ["a", a],
        ["b", b],
      ]),
    );
    expect(result.issues).toEqual([]);
    expect(result.placements[1]).toEqual({ slug: "b", dx: 200, dy: 0 });
  });

  it("reports joins whose track ends don't match", () => {
    const a = twoTrackModule("a");
    const single = doc({
      id: "single",
      elements: [
        track("t", [
          [0, 0],
          [100, 0],
        ]),
      ],
      joins: [
        {
          id: "west",
          name: "West",
          points: [
            { x: 0, y: -10 },
            { x: 0, y: 40 },
          ],
        },
      ],
    });
    const wide = twoTrackModule("wide");
    wide.elements = wide.elements.map((e) =>
      e.type === "trackPath" && e.id === "down"
        ? {
            ...e,
            points: [
              { x: 0, y: 40 },
              { x: 200, y: 40 },
            ],
          }
        : e,
    );
    wide.joins![0]!.points[1] = { x: 0, y: 50 };

    const counts = flattenAssembledMap(
      doc({
        id: "x",
        modules: [
          { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
          {
            slug: "single",
            placement: { kind: "attached", join: "west", to: "a", toJoin: "east" },
          },
        ],
      }),
      new Map([
        ["a", a],
        ["single", single],
      ]),
    );
    expect(counts.issues.map((i) => i.code)).toEqual(["join_track_count_mismatch"]);

    const spacing = flattenAssembledMap(
      doc({
        id: "y",
        modules: [
          { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
          { slug: "wide", placement: { kind: "attached", join: "west", to: "a", toJoin: "east" } },
        ],
      }),
      new Map([
        ["a", a],
        ["wide", wide],
      ]),
    );
    expect(spacing.issues.map((i) => i.code)).toEqual(["join_tracks_misaligned"]);
  });

  it("reports a missing module, a missing join, a loop, a duplicate and nesting", () => {
    const a = twoTrackModule("a");
    const nested = {
      ...twoTrackModule("n"),
      modules: [{ slug: "a", placement: { kind: "at" as const, x: 0, y: 0 } }],
    };
    const result = flattenAssembledMap(
      doc({
        id: "x",
        modules: [
          { slug: "gone", placement: { kind: "at", x: 0, y: 0 } },
          { slug: "a", placement: { kind: "attached", join: "west", to: "c", toJoin: "east" } },
          { slug: "c", placement: { kind: "attached", join: "west", to: "a", toJoin: "east" } },
          { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
          { slug: "n", placement: { kind: "at", x: 0, y: 0 } },
        ],
      }),
      new Map([
        ["a", a],
        ["c", twoTrackModule("c")],
        ["n", nested],
      ]),
    );
    expect(result.issues.map((i) => i.code).sort()).toEqual(
      [
        "attach_unresolved",
        "attach_unresolved",
        "module_duplicate",
        "module_missing",
        "module_nested",
      ].sort(),
    );

    const noJoin = flattenAssembledMap(
      doc({
        id: "z",
        modules: [
          { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
          { slug: "c", placement: { kind: "attached", join: "nope", to: "a", toJoin: "east" } },
        ],
      }),
      new Map([
        ["a", a],
        ["c", twoTrackModule("c")],
      ]),
    );
    expect(noJoin.issues.map((i) => i.code)).toEqual(["join_missing"]);
  });

  it("keeps local elements and lets them reference module elements", () => {
    const source = doc({
      id: "assembled",
      elements: [
        {
          id: "label-1",
          type: "label",
          layerId: "layer-track",
          zIndex: 0,
          x: 5,
          y: 5,
          text: "Carlisle",
          align: "center",
          fontSize: 12,
        } as MapElement,
      ],
      modules: [{ slug: "a", placement: { kind: "at", x: 0, y: 0 } }],
    });
    const result = flattenAssembledMap(source, new Map([["a", twoTrackModule("a")]]));
    expect(result.doc.elements[0]!.id).toBe("label-1");
    expect(validateMapDocument(result.doc).valid).toBe(true);
    expect(qualifyId("a", "x/y")).toBe("x/y");
  });

  it("merges topology nodes where two modules meet", () => {
    const withTopology = (id: string): MapDocument => ({
      ...twoTrackModule(id),
      topology: {
        nodes: [
          { id: "n1", x: 0, y: 0 },
          { id: "n2", x: 200, y: 0 },
        ],
        edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2", trackElementId: "up" }],
      },
    });
    const result = flattenAssembledMap(
      doc({
        id: "x",
        modules: [
          { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
          { slug: "b", placement: { kind: "attached", join: "west", to: "a", toJoin: "east" } },
        ],
      }),
      new Map([
        ["a", withTopology("a")],
        ["b", withTopology("b")],
      ]),
    );
    expect(result.doc.topology.nodes.map((n) => n.id)).toEqual(["a/n1", "a/n2", "b/n2"]);
    expect(result.doc.topology.edges.find((e) => e.id === "b/e1")).toMatchObject({
      fromNodeId: "a/n2",
      toNodeId: "b/n2",
      trackElementId: "b/up",
    });
  });
});

describe("join validation", () => {
  it("rejects duplicate join names and zero-length joins", () => {
    const module = twoTrackModule("m");
    module.joins!.push({
      id: "east-2",
      name: "east",
      points: [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
    });
    expect(validateMapDocument(module).errors.map((e) => e.code)).toEqual([
      "duplicate_join_name",
      "join_zero_length",
    ]);
  });
});
