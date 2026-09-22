import { describe, expect, it } from "vitest";
import { MapDocumentSchema } from "./document.js";
import { routeWarnings, validateMapDocument } from "./validate.js";

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

  it("flags a berth element whose matching binding resolves to the wrong type", () => {
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
        {
          id: "bind-1",
          elementId: "berth-1",
          type: "tdSBit",
          tdArea: "PX",
          address: "A",
          bit: 0,
          activeMeans: "on",
        },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "invalid_berth_binding")).toBe(true);
  });

  it("treats doc.bindings (matched by elementId) as authoritative even when element.bindingId is stale or unset", () => {
    // The compiler builds the published berth-binding index from binding.elementId alone
    // (packages/map-schema/src/compiler.ts) — it never reads element.bindingId. A real editor
    // bug once left element.bindingId out of sync with doc.bindings, which made this exact,
    // genuinely-bound berth get flagged as "missing_berth_binding".
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
          // No bindingId set on the element at all.
        },
      ],
      bindings: [
        { id: "bind-1", elementId: "berth-1", type: "tdBerth", tdArea: "PX", berth: "1008" },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.valid).toBe(true);
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

  it("accepts a combined berth: 3 tdBerth bindings sharing one elementId with distinct combinedOrder", () => {
    const doc = baseDoc({
      bindings: [
        {
          id: "bind-a",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "A001",
          combinedOrder: 1,
        },
        {
          id: "bind-b",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "B001",
          combinedOrder: 2,
        },
        {
          id: "bind-c",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "C001",
          combinedOrder: 3,
        },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.valid).toBe(true);
  });

  it("flags a combined berth with more than 4 members", () => {
    // combinedOrder itself is schema-capped at 4 (z.max(4)), so a 5th member necessarily repeats
    // one — that's fine here, this test only cares that the group-size check fires regardless.
    const doc = baseDoc({
      bindings: [1, 2, 3, 4, 5].map((n) => ({
        id: `bind-${n}`,
        elementId: "berth-1",
        type: "tdBerth",
        tdArea: "PX",
        berth: `${n}001`,
        combinedOrder: Math.min(n, 4),
      })),
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "combined_berth_too_many_members")).toBe(true);
  });

  it("flags a combined berth where not every member sets combinedOrder", () => {
    const doc = baseDoc({
      bindings: [
        {
          id: "bind-a",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "A001",
          combinedOrder: 1,
        },
        { id: "bind-b", elementId: "berth-1", type: "tdBerth", tdArea: "PX", berth: "B001" },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "combined_berth_missing_order")).toBe(true);
  });

  it("flags a combined berth whose members share the same combinedOrder", () => {
    const doc = baseDoc({
      bindings: [
        {
          id: "bind-a",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "A001",
          combinedOrder: 1,
        },
        {
          id: "bind-b",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "B001",
          combinedOrder: 1,
        },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "combined_berth_duplicate_order")).toBe(true);
  });

  it("flags a lone binding that sets combinedOrder with no sibling to combine with", () => {
    const doc = baseDoc({
      bindings: [
        {
          id: "bind-a",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "A001",
          combinedOrder: 1,
        },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors.some((e) => e.code === "combined_order_without_group")).toBe(true);
  });

  it("flags a berth element inhibited by itself", () => {
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
          inhibitedBy: "berth-1",
        },
      ],
      bindings: [
        { id: "bind-1", elementId: "berth-1", type: "tdBerth", tdArea: "PX", berth: "1008" },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "inhibited_by_self_reference", elementId: "berth-1" }),
    );
  });

  it("flags a berth element inhibited by a berth that doesn't exist", () => {
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
          inhibitedBy: "no-such-berth",
        },
      ],
      bindings: [
        { id: "bind-1", elementId: "berth-1", type: "tdBerth", tdArea: "PX", berth: "1008" },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "inhibited_by_missing_element", elementId: "berth-1" }),
    );
  });

  it("accepts a berth element inhibited by another real berth element (TD-area fringe pair)", () => {
    const doc = baseDoc({
      elements: [
        {
          id: "berth-px",
          layerId: "l1",
          type: "berth",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          displayName: "CE04",
          bindingId: "bind-px",
          inhibitedBy: "berth-cl",
        },
        {
          id: "berth-cl",
          layerId: "l1",
          type: "berth",
          x: 20,
          y: 0,
          width: 10,
          height: 10,
          displayName: "0005",
          bindingId: "bind-cl",
        },
      ],
      bindings: [
        { id: "bind-px", elementId: "berth-px", type: "tdBerth", tdArea: "PX", berth: "CE04" },
        { id: "bind-cl", elementId: "berth-cl", type: "tdBerth", tdArea: "CL", berth: "0005" },
      ],
    });
    const result = validateMapDocument(doc);
    expect(result.valid).toBe(true);
  });

  describe("S-Class signal bindings (Milestone 36c)", () => {
    const signal = (id: string) => ({ id, layerId: "l1", type: "signal", x: 0, y: 0 });
    const sBit = (id: string, elementId: string, extra: Record<string, unknown> = {}) => ({
      id,
      elementId,
      type: "tdSBit",
      tdArea: "M9",
      address: "03",
      bit: 2,
      activeMeans: "off",
      ...extra,
    });

    it("accepts one S-Class binding on a signal", () => {
      const result = validateMapDocument(
        baseDoc({ elements: [signal("s1")], bindings: [sBit("b1", "s1")] }),
      );
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it("flags a signal with more than one S-Class binding", () => {
      const result = validateMapDocument(
        baseDoc({
          elements: [signal("s1")],
          bindings: [sBit("b1", "s1"), sBit("b2", "s1", { bit: 3 })],
        }),
      );
      expect(result.errors).toEqual([
        expect.objectContaining({ code: "multiple_signal_bindings", elementId: "s1" }),
      ]);
    });

    it("flags an S-Class binding on a non-signal element", () => {
      const result = validateMapDocument(
        baseDoc({
          elements: [{ id: "lbl", layerId: "l1", type: "label", x: 0, y: 0, text: "x" }],
          bindings: [sBit("b1", "lbl")],
        }),
      );
      expect(result.errors).toEqual([
        expect.objectContaining({ code: "invalid_signal_binding", elementId: "lbl" }),
      ]);
    });

    it("rejects a non-hex address or a bit outside 0-7 at the schema level", () => {
      for (const extra of [{ address: "25:0" }, { address: "123" }, { bit: 8 }]) {
        const result = validateMapDocument(
          baseDoc({ elements: [signal("s1")], bindings: [sBit("b1", "s1", extra)] }),
        );
        expect(result.valid).toBe(false);
      }
    });
  });
});

describe("level crossing barrier bindings (Milestone 55 / ADR 0014)", () => {
  function docWith(elements: unknown[], bindings: unknown[]): unknown {
    return {
      schemaVersion: 1,
      map: {
        id: "m",
        name: "m",
        canvas: { width: 100, height: 100, gridSize: 10 },
        timezone: "Europe/London",
      },
      layers: [{ id: "l1", name: "Track", order: 0 }],
      elements,
      topology: { nodes: [], edges: [] },
      bindings,
      editorMetadata: {},
    };
  }

  const crossing = { id: "lx-1", layerId: "l1", type: "levelCrossing", x: 0, y: 0 };
  const barrier = (id: string, bit: number) => ({
    id,
    elementId: "lx-1",
    type: "tdSBitBarrier",
    tdArea: "M9",
    address: "03",
    bit,
    activeMeans: "down",
  });

  it("accepts one barrier binding on a level crossing", () => {
    const result = validateMapDocument(docWith([crossing], [barrier("b1", 2)]));
    expect(result.valid).toBe(true);
  });

  it("rejects a barrier binding on anything but a level crossing", () => {
    const signal = { id: "sig-1", layerId: "l1", type: "signal", x: 0, y: 0 };
    const result = validateMapDocument(
      docWith([signal], [{ ...barrier("b1", 2), elementId: "sig-1" }]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("invalid_barrier_binding");
  });

  it("rejects a crossing with two barrier bindings \u2014 it shows exactly one bit", () => {
    const result = validateMapDocument(docWith([crossing], [barrier("b1", 2), barrier("b2", 3)]));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("multiple_barrier_bindings");
  });

  // Milestone 59 / ADR 0015: a crossing's barrier position may instead be inferred from its
  // protecting signals. That is a barrier *source*, so it shares the one-per-crossing and
  // levelCrossing-only rules with a direct LXC bit.
  const inferred = (id: string, elementId = "lx-1") => ({
    id,
    elementId,
    type: "tdSBitBarrierInferred",
    inputs: [
      { tdArea: "M9", address: "07", bit: 4, activeMeans: "off", label: "S3879" },
      { tdArea: "M9", address: "6", bit: 6, activeMeans: "off", label: "S3870" },
    ],
  });

  it("accepts an inferred rule on a level crossing", () => {
    const result = validateMapDocument(docWith([crossing], [inferred("i1")]));
    expect(result.valid).toBe(true);
  });

  it("rejects an inferred rule on anything but a level crossing", () => {
    const signal = { id: "sig-1", layerId: "l1", type: "signal", x: 0, y: 0 };
    const result = validateMapDocument(docWith([signal], [inferred("i1", "sig-1")]));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("invalid_barrier_binding");
  });

  it("rejects a crossing driven by both an S-Class bit and an inferred rule", () => {
    const result = validateMapDocument(docWith([crossing], [barrier("b1", 2), inferred("i1")]));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("multiple_barrier_bindings");
  });

  it("rejects an inferred rule with no inputs, or a malformed input bit", () => {
    const empty = validateMapDocument(docWith([crossing], [{ ...inferred("i1"), inputs: [] }]));
    expect(empty.valid).toBe(false);
    const badBit = validateMapDocument(
      docWith(
        [crossing],
        [
          {
            ...inferred("i1"),
            inputs: [{ tdArea: "M9", address: "07", bit: 8, activeMeans: "off" }],
          },
        ],
      ),
    );
    expect(badBit.valid).toBe(false);
  });

  it("still parses a crossing saved with Milestone 58's retired realisticBarriers flag", () => {
    // Realistic is now the default; the old opt-in flag is simply dropped on parse.
    const result = validateMapDocument(docWith([{ ...crossing, realisticBarriers: true }], []));
    expect(result.valid).toBe(true);
  });

  it("rejects a signal binding on a level crossing (the mirror rule)", () => {
    const result = validateMapDocument(
      docWith(
        [crossing],
        [
          {
            id: "b1",
            elementId: "lx-1",
            type: "tdSBit",
            tdArea: "M9",
            address: "03",
            bit: 2,
            activeMeans: "off",
          },
        ],
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("invalid_signal_binding");
  });
});

describe("routes (Milestone 64 / ADR 0016)", () => {
  function docWith(elements: unknown[], bindings: unknown[] = []): unknown {
    return {
      schemaVersion: 1,
      map: {
        id: "m",
        name: "m",
        canvas: { width: 400, height: 100, gridSize: 10 },
        timezone: "Europe/London",
      },
      layers: [{ id: "l1", name: "Track", order: 0 }],
      elements,
      topology: { nodes: [], edges: [] },
      bindings,
      editorMetadata: {},
    };
  }

  const track = {
    id: "t1",
    layerId: "l1",
    type: "trackPath",
    points: [
      { x: 0, y: 50 },
      { x: 400, y: 50 },
    ],
  };
  const entry = { id: "s1", layerId: "l1", type: "signal", x: 20, y: 50 };
  const exit = { id: "s2", layerId: "l1", type: "signal", x: 300, y: 50 };
  const route = {
    id: "r1",
    layerId: "l1",
    type: "route",
    entrySignalId: "s1",
    exitSignalId: "s2",
    label: "R1A",
    points: [
      { x: 20, y: 50 },
      { x: 300, y: 50 },
    ],
    trackIds: ["t1"],
  };
  const routeBit = (id: string, elementId = "r1") => ({
    id,
    elementId,
    type: "tdSBitRoute",
    tdArea: "M9",
    address: "0C",
    bit: 4,
    activeMeans: "set",
  });

  it("accepts a route between two signals with one route bit", () => {
    const result = validateMapDocument(docWith([track, entry, exit, route], [routeBit("b1")]));
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects a route whose entry or exit is not a signal", () => {
    const result = validateMapDocument(
      docWith([track, entry, { ...route, entrySignalId: "t1", exitSignalId: "gone" }]),
    );
    expect(result.errors.map((e) => e.code)).toEqual([
      "route_entry_not_signal",
      "route_exit_not_signal",
    ]);
  });

  it("accepts a route with no exit signal, ending at a boundary or buffer stop", () => {
    const { exitSignalId: _, ...toBoundary } = route;
    expect(validateMapDocument(docWith([track, entry, toBoundary])).valid).toBe(true);
  });

  it("rejects a route bit on anything but a route, and two bits on one route", () => {
    const onSignal = validateMapDocument(
      docWith([track, entry, exit, route], [routeBit("b1", "s1")]),
    );
    expect(onSignal.errors.map((e) => e.code)).toContain("invalid_route_binding");
    const twice = validateMapDocument(
      docWith([track, entry, exit, route], [routeBit("b1"), { ...routeBit("b2"), bit: 5 }]),
    );
    expect(twice.errors.map((e) => e.code)).toContain("multiple_route_bindings");
  });

  it("rejects a route bit that states a signal's vocabulary instead of set/unset", () => {
    const result = validateMapDocument(
      docWith([track, entry, exit, route], [{ ...routeBit("b1"), activeMeans: "off" }]),
    );
    expect(result.valid).toBe(false);
  });

  describe("routeWarnings", () => {
    const parse = (elements: unknown[], bindings: unknown[] = []) =>
      MapDocumentSchema.parse(docWith(elements, bindings));

    it("is quiet for a bound route that lies on the track it was traced along", () => {
      expect(routeWarnings(parse([track, entry, exit, route], [routeBit("b1")]))).toEqual([]);
    });

    it("warns when the track has moved away from the route, or was deleted", () => {
      const moved = { ...track, points: track.points.map((p) => ({ x: p.x, y: p.y + 30 })) };
      expect(
        routeWarnings(parse([moved, entry, exit, route], [routeBit("b1")])).map((w) => w.code),
      ).toEqual(["route_off_track"]);
      expect(
        routeWarnings(parse([entry, exit, route], [routeBit("b1")])).map((w) => w.code),
      ).toEqual(["route_track_missing", "route_off_track"]);
    });

    it("warns about a route with no bit, which would never be shown", () => {
      expect(routeWarnings(parse([track, entry, exit, route])).map((w) => w.code)).toEqual([
        "route_unbound",
      ]);
    });
  });
});
