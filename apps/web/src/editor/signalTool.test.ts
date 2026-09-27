import { describe, expect, it } from "vitest";
import type { MapDocument, MapElement } from "@railway/map-schema";
import { applyCommand } from "./commands.js";
import {
  DEFAULT_SIGNAL_TOOL_OPTIONS,
  planSignalTool,
  sClassLabelKey,
  summariseSignalTool,
} from "./signalTool.js";

const berth = (id: string, x: number): MapElement => ({
  id,
  layerId: "l",
  zIndex: 0,
  type: "berth",
  x,
  y: 88,
  width: 60,
  height: 24,
  displayName: id,
  fontSize: 10,
  textAlign: "center",
});

const signal = (id: string, x: number, extra: Record<string, unknown> = {}): MapElement =>
  ({
    id,
    layerId: "l",
    zIndex: 0,
    type: "signal",
    x,
    y: 100,
    orientation: 0,
    symbolStyle: "signal-blank",
    ...extra,
  }) as MapElement;

/** Berths [0, 60] and [100, 160] on the track at y = 100. */
function doc(signals: MapElement[], bound: string[]): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 400, height: 200, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", visible: true, locked: false, order: 0 }],
    elements: [berth("b1", 0), berth("b2", 100), ...signals],
    topology: { nodes: [], edges: [] },
    bindings: bound.map((id, i) => ({
      id: `bind-${id}`,
      elementId: id,
      type: "tdSBit" as const,
      tdArea: "CL",
      address: "4",
      bit: i,
      activeMeans: "off" as const,
    })),
    editorMetadata: {},
  };
}

const labels = new Map([
  [sClassLabelKey("CL", "04", 0), "S0491"],
  [sClassLabelKey("CL", "04", 1), "S0492"],
  [sClassLabelKey("CL", "04", 2), "S0493"],
]);

describe("planSignalTool (ADR 0017 §5)", () => {
  it("names bound signals from their S-Class label, replacing the letters with the prefix", () => {
    const plan = planSignalTool(doc([signal("a", 70), signal("b", 90)], ["a", "b"]), labels, {
      ...DEFAULT_SIGNAL_TOOL_OPTIONS,
      prefix: "CE",
      resizeBerths: false,
    });
    expect(plan.patches).toEqual([
      {
        elementId: "a",
        patch: {
          label: "CE0491",
          labelSource: "tool",
          appliesTo: "right",
          side: "above",
          orientationSource: "tool",
        },
      },
      {
        elementId: "b",
        patch: {
          label: "CE0492",
          labelSource: "tool",
          appliesTo: "left",
          side: "below",
          orientationSource: "tool",
        },
      },
    ]);
  });

  it("leaves hand-set numbers and directions alone unless told to overwrite", () => {
    const d = doc(
      [
        signal("custom", 70, {
          label: "MINE",
          labelSource: "custom",
          appliesTo: "left",
          side: "below",
          orientationSource: "custom",
        }),
        // A number typed before the tool existed counts as hand-set.
        signal("legacy", 90, { label: "OLD" }),
        // The tool's own earlier values are fair game.
        signal("tool", 70, { label: "S0493", labelSource: "tool" }),
      ],
      ["custom", "legacy", "tool"],
    );
    const plan = planSignalTool(d, labels, DEFAULT_SIGNAL_TOOL_OPTIONS);
    const row = (id: string) => plan.rows.find((r) => r.elementId === id)!;
    expect(row("custom").name).toEqual({ status: "skipped", reason: "number set by hand" });
    expect(row("custom").direction).toEqual({ status: "skipped", reason: "direction set by hand" });
    expect(row("legacy").name).toEqual({ status: "skipped", reason: "number set by hand" });
    expect(row("tool").name).toEqual({ status: "unchanged" });

    const overwrite = planSignalTool(d, labels, {
      ...DEFAULT_SIGNAL_TOOL_OPTIONS,
      overwriteCustomNames: true,
      overwriteCustomDirections: true,
      resizeBerths: false,
    });
    const custom = overwrite.patches.find((p) => p.elementId === "custom")!;
    expect(custom.patch).toMatchObject({
      label: "S0491",
      labelSource: "tool",
      appliesTo: "right",
      side: "above",
    });
  });

  it("explains what it can't do: not bound, no label, no berth, between two", () => {
    const d = doc(
      [signal("free", 300), signal("mid", 80), signal("unlabelled", 70)],
      ["mid", "unlabelled"],
    );
    const onlyLabel = new Map([[sClassLabelKey("CL", "04", 0), "S0491"]]);
    const plan = planSignalTool(d, onlyLabel, DEFAULT_SIGNAL_TOOL_OPTIONS);
    const row = (id: string) => plan.rows.find((r) => r.elementId === id)!;
    expect(row("free").name).toEqual({ status: "skipped", reason: "not bound to a bit" });
    expect(row("free").direction).toEqual({
      status: "skipped",
      reason: "no berth within 40 on its track",
    });
    expect(row("mid").direction).toEqual({
      status: "skipped",
      reason: "exactly between two berths",
    });
    expect(row("unlabelled").name).toEqual({
      status: "skipped",
      reason: "its bit has no S-Class label",
    });
    expect(summariseSignalTool(plan)).toMatchObject({
      signals: 3,
      namesChanged: 1,
      namesSkipped: 2,
      directionsChanged: 1,
      directionsSkipped: 2,
    });
  });

  it("does only what is ticked", () => {
    const d = doc([signal("a", 70)], ["a"]);
    const namesOnly = planSignalTool(d, labels, {
      ...DEFAULT_SIGNAL_TOOL_OPTIONS,
      setDirections: false,
      resizeBerths: false,
    });
    expect(namesOnly.patches).toEqual([
      { elementId: "a", patch: { label: "S0491", labelSource: "tool" } },
    ]);
    expect(namesOnly.rows[0]!.direction).toEqual({ status: "off" });
  });
});

describe("planSignalTool berth resize (owner, 2026-09-27)", () => {
  it("resizes every berth to 40 about its centre, and signals move in with the ends", () => {
    // Berths [0, 60] and [100, 160]: signal a 10 right of the first, b 10 left of the second,
    // c 30 right of the second (still next to it), d not near any berth.
    const d = doc([signal("a", 70), signal("b", 90), signal("c", 190), signal("d", 400)], []);
    const plan = planSignalTool(d, new Map(), { ...DEFAULT_SIGNAL_TOOL_OPTIONS, setNames: false });
    const patch = (id: string) => plan.patches.find((p) => p.elementId === id)?.patch;
    expect(patch("b1")).toEqual({ x: 10, width: 40 });
    expect(patch("b2")).toEqual({ x: 110, width: 40 });
    expect(patch("a")).toMatchObject({ x: 60, appliesTo: "right" });
    expect(patch("b")).toMatchObject({ x: 100, appliesTo: "left" });
    expect(patch("c")).toMatchObject({ x: 180 });
    expect(patch("d")?.x).toBeUndefined();
    expect(plan.berthsResized).toBe(2);
    expect(summariseSignalTool(plan)).toMatchObject({ berthsResized: 2, signalsMoved: 3 });
  });

  it("does nothing to berths already 40 wide, so running it twice changes nothing more", () => {
    const d = doc([signal("a", 70)], []);
    const first = planSignalTool(d, new Map(), DEFAULT_SIGNAL_TOOL_OPTIONS);
    const once = applyCommand(d, { type: "patchElements", patches: first.patches }).doc;
    const second = planSignalTool(once, new Map(), DEFAULT_SIGNAL_TOOL_OPTIONS);
    expect(second.berthsResized).toBe(0);
    expect(second.patches).toEqual([]);
  });

  it("leaves a signal that faces away from the nearer berth where it is", () => {
    // 10 right of the first berth, but set by hand to apply to left-running trains.
    const d = doc(
      [signal("a", 70, { appliesTo: "left", side: "below", orientationSource: "custom" })],
      [],
    );
    const plan = planSignalTool(d, new Map(), DEFAULT_SIGNAL_TOOL_OPTIONS);
    expect(plan.rows[0]!.position).toEqual({ status: "unchanged" });
  });
});

describe("planSignalTool keeps routes attached (owner, 2026-09-27)", () => {
  it("moves a moved signal's route ends with it, and repairs ends an earlier move left behind", () => {
    const route = (id: string, entry: string, points: Array<[number, number]>): MapElement =>
      ({
        id,
        layerId: "l",
        zIndex: 0,
        type: "route",
        entrySignalId: entry,
        points: points.map(([x, y]) => ({ x, y })),
        trackIds: [],
      }) as MapElement;
    // a (x 70) moves to 60 with berth b1's trimmed end; "old" already sits 10 off signal c.
    const d = doc(
      [
        signal("a", 70),
        route("ra", "a", [
          [70, 100],
          [300, 100],
        ]),
        signal("c", 250),
        route("old", "c", [
          [260, 100],
          [400, 100],
        ]),
      ],
      [],
    );
    const plan = planSignalTool(d, new Map(), { ...DEFAULT_SIGNAL_TOOL_OPTIONS, setNames: false });
    const patch = (id: string) => plan.patches.find((p) => p.elementId === id)?.patch;
    expect(patch("ra")).toEqual({
      points: [
        { x: 60, y: 100 },
        { x: 300, y: 100 },
      ],
    });
    expect(patch("old")).toEqual({
      points: [
        { x: 250, y: 100 },
        { x: 400, y: 100 },
      ],
    });
    expect(plan.routesRealigned).toBe(2);
    expect(plan.routesNeedingRetrace).toEqual([]);
  });
});

describe("patchElements command (ADR 0017)", () => {
  it("patches many elements in one step, and one undo restores them all", () => {
    const before = doc([signal("a", 70, { label: "X" }), signal("b", 90)], []);
    const { doc: after, inverse } = applyCommand(before, {
      type: "patchElements",
      patches: [
        { elementId: "a", patch: { label: "S0491", labelSource: "tool" } },
        { elementId: "b", patch: { appliesTo: "left", side: "below" } },
      ],
    });
    const find = (d: MapDocument, id: string) => d.elements.find((e) => e.id === id)!;
    expect(find(after, "a")).toMatchObject({ label: "S0491", labelSource: "tool" });
    expect(find(after, "b")).toMatchObject({ appliesTo: "left", side: "below" });

    const restored = applyCommand(after, inverse).doc;
    expect(find(restored, "a")).toEqual(find(before, "a"));
    expect(find(restored, "b")).toEqual(find(before, "b"));
  });
});
