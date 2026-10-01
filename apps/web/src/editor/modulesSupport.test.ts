import { describe, expect, it } from "vitest";
import { MapDocumentSchema, type MapDocument } from "@railway/map-schema";
import {
  assemblyBackdrop,
  contextBackdrop,
  newJoinAt,
  placementForNewModule,
  placementSummary,
  type EditorModule,
} from "./modulesSupport.js";
import { applyCommand } from "./commands.js";

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

function module(slug: string, length = 200): EditorModule {
  const moduleDoc = doc({
    id: slug,
    elements: [
      {
        id: "up",
        type: "trackPath",
        layerId: "layer-track",
        zIndex: 0,
        points: [
          { x: 0, y: 0 },
          { x: length, y: 0 },
        ],
      },
    ],
    joins: [
      {
        id: "west",
        name: "West",
        points: [
          { x: 0, y: -10 },
          { x: 0, y: 10 },
        ],
      },
      {
        id: "east",
        name: "East",
        points: [
          { x: length, y: -10 },
          { x: length, y: 10 },
        ],
      },
    ],
  });
  return {
    slug,
    name: slug.toUpperCase(),
    draft: moduleDoc,
    draftRevision: 2,
    published: moduleDoc,
    publishedVersion: 1,
  };
}

const assembled = doc({
  id: "assembled",
  modules: [
    { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
    { slug: "b", placement: { kind: "attached", join: "west", to: "a", toJoin: "east" } },
  ],
});

describe("assemblyBackdrop", () => {
  it("places each module; only freely placed ones can be dragged", () => {
    const view = assemblyBackdrop(assembled, [module("a"), module("b")]);
    expect(view.issues).toEqual([]);
    expect(view.items.map((i) => [i.key, i.dx, i.dy, i.draggable, i.title])).toEqual([
      ["a", 0, 0, true, "A"],
      ["b", 200, 0, false, "B"],
    ]);
  });
});

describe("contextBackdrop", () => {
  it("draws the rest of the map around the module being edited, following its live edits", () => {
    // Editing "a", lengthened to 260: "b" (attached to a's east join) follows, and the backdrop
    // is relative to a's own coordinates.
    const view = contextBackdrop("a", module("a", 260).draft!, assembled, [module("b")])!;
    const b = view.items.find((i) => i.key === "b")!;
    expect([b.dx, b.dy]).toEqual([260, 0]);
    expect(view.items[0]!.key).toBe("__assembled");
  });

  it("is null when the module isn't in that map", () => {
    expect(contextBackdrop("zzz", module("zzz").draft!, assembled, [module("a")])).toBeNull();
  });
});

describe("placementForNewModule", () => {
  it("puts a new module to the right of everything, snapped to the grid", () => {
    const view = assemblyBackdrop(assembled, [module("a"), module("b")]);
    expect(placementForNewModule(assembled, view.items, 10)).toEqual({ kind: "at", x: 500, y: 0 });
    expect(placementForNewModule(doc({ id: "empty" }), [], 10)).toEqual({ kind: "at", x: 0, y: 0 });
  });
});

describe("joins", () => {
  it("names and numbers new joins without clashing", () => {
    const first = newJoinAt({ x: 100, y: 50 }, []);
    expect(first).toEqual({
      id: "join-1",
      name: "Join 1",
      points: [
        { x: 100, y: 20 },
        { x: 100, y: 80 },
      ],
    });
    expect(newJoinAt({ x: 0, y: 0 }, [first, { ...first, id: "join-2", name: "Join 2" }]).id).toBe(
      "join-3",
    );
  });

  it("setJoins and setModules undo in one step", () => {
    const start = module("a").draft!;
    const { doc: changed, inverse } = applyCommand(start, { type: "setJoins", joins: [] });
    expect(changed.joins).toEqual([]);
    expect(applyCommand(changed, inverse).doc.joins).toEqual(start.joins);

    const moved = applyCommand(assembled, {
      type: "setModules",
      modules: [{ slug: "a", placement: { kind: "at", x: 50, y: 0 } }],
    });
    expect(applyCommand(moved.doc, moved.inverse).doc.modules).toEqual(assembled.modules);
  });

  it("describes a placement in words", () => {
    const names = (slug: string) => slug.toUpperCase();
    const joinName = (_slug: string, id: string) => (id === "west" ? "West" : "East");
    expect(placementSummary(assembled.modules![1]!, joinName, names)).toBe(
      "Its West joins A's East",
    );
    expect(placementSummary(assembled.modules![0]!, joinName, names)).toMatch(/placed freely/i);
  });
});
