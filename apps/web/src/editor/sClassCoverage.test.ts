import { describe, expect, it } from "vitest";
import { MapDocumentSchema, type MapDocument } from "@railway/map-schema";
import { sClassCoverage, type CoverageDefinition } from "./sClassCoverage.js";

function doc(elements: unknown[], bindings: unknown[]): MapDocument {
  return MapDocumentSchema.parse({
    schemaVersion: 1,
    map: {
      id: "t",
      name: "T",
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "L", order: 0 }],
    elements,
    bindings,
  });
}
const signal = (id: string, label: string) => ({
  id,
  type: "signal",
  layerId: "l",
  x: 0,
  y: 0,
  label,
});
const route = (id: string, label: string) => ({
  id,
  type: "route",
  layerId: "l",
  entrySignalId: "s1",
  label,
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ],
});
const crossing = (id: string) => ({ id, type: "levelCrossing", layerId: "l", x: 0, y: 0 });
const sBit = (id: string, elementId: string, address: string, bit: number, extra = {}) => ({
  id,
  type: "tdSBit",
  elementId,
  tdArea: "CE",
  address,
  bit,
  activeMeans: "off",
  ...extra,
});
const routeBit = (id: string, elementId: string, address: string, bit: number, extra = {}) => ({
  id,
  type: "tdSBitRoute",
  elementId,
  tdArea: "CE",
  address,
  bit,
  activeMeans: "set",
  ...extra,
});
const defs: CoverageDefinition[] = [
  { address: "2C", bit: 5, kind: "signal", label: "S0101", destination: null },
  { address: "2C", bit: 6, kind: "signal", label: "S0105", destination: null },
  { address: "2C", bit: 7, kind: "signal", label: "S0107", destination: null },
  { address: "01", bit: 2, kind: "route", label: "R0105AM", destination: "0135" },
  { address: "01", bit: 3, kind: "route", label: "R0105BM", destination: "0137" },
];

describe("sClassCoverage", () => {
  it("counts bound and unbound definitions across the map and its modules", () => {
    const here = doc(
      [signal("s1", "CE101"), route("r1", "R0105AM")],
      [sBit("b1", "s1", "2c", 5), routeBit("b2", "r1", "1", 2)],
    );
    const other = doc([signal("s2", "CE105")], [sBit("b3", "s2", "2C", 6)]);
    const [ce] = sClassCoverage(
      [
        { moduleSlug: null, name: "This map", doc: here },
        { moduleSlug: "winford-south", name: "Winford South", doc: other },
      ],
      { CE: defs },
    );
    expect(ce!.signals).toEqual({ defined: 3, bound: 2 });
    expect(ce!.routes).toEqual({ defined: 2, bound: 1 });
    expect(ce!.unbound.map((d) => d.label)).toEqual(["S0107", "R0105BM"]);
    expect(ce!.doubleUses).toEqual([]);
    expect(ce!.problems).toEqual([]);
  });

  it("flags a bit bound to two signals, even across modules, until every binding is marked intended", () => {
    const here = doc([signal("s1", "CE101")], [sBit("b1", "s1", "2C", 5)]);
    const other = doc([signal("s9", "CE101")], [sBit("b9", "s9", "2C", 5)]);
    const run = (a: MapDocument, b: MapDocument) =>
      sClassCoverage(
        [
          { moduleSlug: null, name: "This map", doc: a },
          { moduleSlug: "m2", name: "Module 2", doc: b },
        ],
        { CE: defs },
      )[0]!;
    const first = run(here, other);
    expect(first.doubleUses).toHaveLength(1);
    expect(first.doubleUses[0]).toMatchObject({ key: "2C.5", kind: "signal", intended: false });
    expect(first.doubleUses[0]!.uses.map((u) => u.sourceName)).toEqual(["This map", "Module 2"]);

    const halfMarked = run(
      doc([signal("s1", "CE101")], [sBit("b1", "s1", "2C", 5, { allowDuplicate: true })]),
      other,
    );
    expect(halfMarked.doubleUses[0]!.intended).toBe(false);
    const bothMarked = run(
      doc([signal("s1", "CE101")], [sBit("b1", "s1", "2C", 5, { allowDuplicate: true })]),
      doc([signal("s9", "CE101")], [sBit("b9", "s9", "2C", 5, { allowDuplicate: true })]),
    );
    expect(bothMarked.doubleUses[0]!.intended).toBe(true);
  });

  it("never warns about a signal bit that also feeds a crossing", () => {
    const here = doc(
      [signal("s1", "CE101"), crossing("x1"), crossing("x2")],
      [
        sBit("b1", "s1", "2C", 5),
        {
          id: "i1",
          type: "tdSBitBarrierInferred",
          elementId: "x1",
          inputs: [{ tdArea: "CE", address: "2C", bit: 5, activeMeans: "off" }],
        },
        {
          id: "i2",
          type: "tdSBitBarrierInferred",
          elementId: "x2",
          inputs: [
            { tdArea: "CE", address: "2C", bit: 5, activeMeans: "off" },
            { tdArea: "CE", address: "2C", bit: 7, activeMeans: "off" },
          ],
        },
      ],
    );
    const [ce] = sClassCoverage([{ moduleSlug: null, name: "This map", doc: here }], { CE: defs });
    expect(ce!.doubleUses).toEqual([]);
    expect(ce!.problems).toEqual([]);
    // 2C.7 only feeds a crossing: listed on its own, not as missing.
    expect(ce!.crossingInputsOnly.map((d) => d.label)).toEqual(["S0107"]);
    expect(ce!.unbound.map((d) => d.label)).toEqual(["S0105", "R0105AM", "R0105BM"]);
  });

  it("reports undefined bits, the wrong kind of bit and a label that disagrees", () => {
    const here = doc(
      [signal("s1", "CE135"), signal("s2", "CE105"), route("r1", "R0105AM"), signal("s3", "CE999")],
      [
        sBit("b1", "s1", "2C", 5), // defined as S0101
        sBit("b2", "s2", "01", 2), // a route bit
        routeBit("b3", "r1", "01", 2),
        sBit("b4", "s3", "3F", 1), // no definition
      ],
    );
    const [ce] = sClassCoverage([{ moduleSlug: null, name: "This map", doc: here }], { CE: defs });
    expect(ce!.problems.map((p) => p.code).sort()).toEqual([
      "kind_mismatch",
      "label_mismatch",
      "undefined_bit",
    ]);
    expect(ce!.problems.find((p) => p.code === "label_mismatch")!.message).toBe(
      "CE135 is bound to CE 2C.5, which is defined as S0101",
    );
  });

  it("lists an area with definitions but no bindings yet", () => {
    const [ce] = sClassCoverage([{ moduleSlug: null, name: "This map", doc: doc([], []) }], {
      CE: defs,
    });
    expect(ce!.signals).toEqual({ defined: 3, bound: 0 });
    expect(ce!.unbound).toHaveLength(5);
  });
});

describe("TRTS coverage (Milestone 92)", () => {
  it("counts TRTS bits bound on their signals and checks the number", () => {
    const here = doc(
      [signal("s1", "CE128"), signal("s2", "CE130")],
      [
        {
          id: "t1",
          type: "tdSBitTrts",
          elementId: "s1",
          tdArea: "CE",
          address: "3B",
          bit: 4,
          activeMeans: "lit",
        },
        {
          id: "t2",
          type: "tdSBitTrts",
          elementId: "s2",
          tdArea: "CE",
          address: "3B",
          bit: 3,
          activeMeans: "lit",
        },
      ],
    );
    const trtsDefs: CoverageDefinition[] = [
      { address: "3B", bit: 4, kind: "trts", label: "TRTS 0128", destination: null },
      { address: "3B", bit: 3, kind: "trts", label: "TRTS 0157", destination: null },
      { address: "3B", bit: 2, kind: "trts", label: "TRTS 0130", destination: null },
    ];
    const [ce] = sClassCoverage([{ moduleSlug: null, name: "This map", doc: here }], {
      CE: trtsDefs,
    });
    expect(ce!.trts).toEqual({ defined: 3, bound: 2 });
    expect(ce!.unbound.map((d) => d.label)).toEqual(["TRTS 0130"]);
    expect(ce!.problems.map((p) => p.message)).toEqual([
      "CE130 is bound to CE 3B.3, which is defined as TRTS 0157",
    ]);
  });
});
