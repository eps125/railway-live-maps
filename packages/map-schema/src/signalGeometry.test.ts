import { describe, expect, it } from "vitest";
import type { MapElement } from "./document.js";
import {
  applySignalNamePrefix,
  berthBoxes,
  defaultSignalDirection,
  signalColor,
  signalLabelPosition,
  signalPostGeometry,
} from "./signalGeometry.js";

describe("signalColor (ADR 0017)", () => {
  it("draws each type's on/off in its own colours, and unknown grey for all", () => {
    expect(signalColor(undefined, "on")).toBe("#f85149");
    expect(signalColor("main", "off")).toBe("#3fb950");
    expect(signalColor("subsidiary", "on")).toBe("#f85149");
    expect(signalColor("subsidiary", "off")).toBe("#e6edf3");
    expect(signalColor("distant", "on")).toBe("#e3b341");
    expect(signalColor("distant", "off")).toBe("#3fb950");
    for (const type of ["main", "subsidiary", "distant"] as const) {
      expect(signalColor(type, "blank")).toBe("#5f6b7a");
    }
  });
});

describe("signalPostGeometry (ADR 0017)", () => {
  it("is null for a signal without a direction, which keeps its old drawing", () => {
    expect(signalPostGeometry({})).toBeNull();
  });

  it("right-running main: post rises from the track edge above, arm right, head touching it", () => {
    const g = signalPostGeometry({ appliesTo: "right" })!;
    expect(g.side).toBe("above");
    expect(g.post).toEqual([0, -1.5, 0, -8.5, 3, -8.5]);
    expect(g.head).toEqual({ kind: "circle", cx: 8, cy: -8.5, r: 5 });
    // The number runs back along the protected berth (to the left), ending at the post.
    expect(g.label).toEqual({ x: -1, y: -15, anchor: "end" });
  });

  it("left-running main defaults below the track, mirrored", () => {
    const g = signalPostGeometry({ appliesTo: "left" })!;
    expect(g.side).toBe("below");
    expect(g.post).toEqual([0, 1.5, 0, 8.5, -3, 8.5]);
    expect(g.head).toEqual({ kind: "circle", cx: -8, cy: 8.5, r: 5 });
    expect(g.label).toEqual({ x: 1, y: 15, anchor: "start" });
  });

  it("honours an overridden side", () => {
    const g = signalPostGeometry({ appliesTo: "right", side: "below" })!;
    expect(g.post).toEqual([0, 1.5, 0, 8.5, 3, 8.5]);
  });

  it("subsidiary: a quarter-circle as wide as a main head, flat edge to the track, arm at its middle", () => {
    const right = signalPostGeometry({ appliesTo: "right", signalType: "subsidiary" })!;
    // Corner nearest the track (3, -3.5); flat edge up to (3, -13.5), centred on the arm at
    // -8.5; curve out to (13, -3.5): 10 wide, bottom level with a main head's.
    expect(right.head).toEqual({
      kind: "quadrant",
      path: "M 3 -3.5 L 3 -13.5 A 10 10 0 0 1 13 -3.5 Z",
    });
    // The other way round is the same shape turned 180°.
    const left = signalPostGeometry({ appliesTo: "left", signalType: "subsidiary" })!;
    expect(left.head).toEqual({
      kind: "quadrant",
      path: "M -3 3.5 L -3 13.5 A 10 10 0 0 1 -13 3.5 Z",
    });
    // Mirrored in one axis only (right-running, below): the arc runs the other way.
    const mirrored = signalPostGeometry({
      appliesTo: "right",
      side: "below",
      signalType: "subsidiary",
    })!;
    expect(mirrored.head).toEqual({
      kind: "quadrant",
      path: "M 3 3.5 L 3 13.5 A 10 10 0 0 0 13 3.5 Z",
    });
  });

  it("puts the number at its dragged offset when it has one", () => {
    const g = signalPostGeometry({ appliesTo: "right" })!;
    expect(signalLabelPosition({}, g)).toEqual({ x: -1, y: -15 });
    expect(signalLabelPosition({ labelOffset: { x: 20, y: -25 } }, g)).toEqual({ x: 20, y: -25 });
  });
});

describe("defaultSignalDirection (owner rule, 2026-09-27)", () => {
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
  // Two berths on the track at y = 100: [0, 60] and [100, 160]. Another track's berth at y = 130.
  const boxes = berthBoxes([
    berth("a", 0),
    berth("b", 100),
    { ...berth("other", 60), y: 118 } as MapElement,
  ]);

  it("right of a berth: above, applies to right-running trains", () => {
    expect(defaultSignalDirection({ x: 70, y: 100 }, boxes)).toEqual({
      ok: true,
      appliesTo: "right",
      side: "above",
    });
  });

  it("left of a berth: below, applies to left-running trains", () => {
    expect(defaultSignalDirection({ x: 90, y: 100 }, boxes)).toEqual({
      ok: true,
      appliesTo: "left",
      side: "below",
    });
  });

  it("leaves the undecidable ones to the author", () => {
    expect(defaultSignalDirection({ x: 80, y: 100 }, boxes)).toEqual({
      ok: false,
      reason: "between-two-berths",
    });
    expect(defaultSignalDirection({ x: 300, y: 100 }, boxes)).toEqual({
      ok: false,
      reason: "no-berth-nearby",
    });
    expect(defaultSignalDirection({ x: 30, y: 100 }, boxes)).toEqual({
      ok: false,
      reason: "inside-a-berth",
    });
  });

  it("ignores berths on another track", () => {
    // Only the other track's berth is near x = 125 on y = 130.
    expect(defaultSignalDirection({ x: 125, y: 100 }, boxes)).toEqual({
      ok: false,
      reason: "inside-a-berth",
    });
    expect(defaultSignalDirection({ x: 130, y: 60 }, boxes)).toEqual({
      ok: false,
      reason: "no-berth-nearby",
    });
  });
});

describe("applySignalNamePrefix (owner rule, 2026-09-27)", () => {
  it("replaces the leading letters", () => {
    expect(applySignalNamePrefix("S001", "CE")).toBe("CE001");
    expect(applySignalNamePrefix("S0451", " CE ")).toBe("CE0451");
    expect(applySignalNamePrefix("SX12A", "CE")).toBe("CE12A");
  });

  it("leaves the label alone with no prefix, or when it has no leading letters", () => {
    expect(applySignalNamePrefix("S001", undefined)).toBe("S001");
    expect(applySignalNamePrefix("S001", "  ")).toBe("S001");
    expect(applySignalNamePrefix("0451", "CE")).toBe("0451");
  });
});
