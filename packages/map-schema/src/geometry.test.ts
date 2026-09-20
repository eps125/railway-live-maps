import { describe, expect, it } from "vitest";
import { berthRenderRect, neutralSectionGeometry, pointOnPathAtX } from "./geometry.js";
import { MapDocumentSchema, type BerthElement, type MapElement } from "./document.js";

describe("pointOnPathAtX", () => {
  it("interpolates linearly between the two bracketing vertices", () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 100, y: 300 },
    ];
    expect(pointOnPathAtX(pts, 0)).toBe(100);
    expect(pointOnPathAtX(pts, 50)).toBe(200);
    expect(pointOnPathAtX(pts, 100)).toBe(300);
  });

  it("walks a multi-vertex polyline (horizontal, diagonal, horizontal)", () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 100, y: 100 },
      { x: 160, y: 130 },
      { x: 400, y: 130 },
    ];
    expect(pointOnPathAtX(pts, 50)).toBe(100);
    expect(pointOnPathAtX(pts, 130)).toBe(115); // half-way down the 1:2 diagonal
    expect(pointOnPathAtX(pts, 300)).toBe(130);
  });

  it("clamps to the nearer endpoint when x is beyond both ends", () => {
    const pts = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ];
    expect(pointOnPathAtX(pts, 0)).toBe(100);
    expect(pointOnPathAtX(pts, 999)).toBe(100);
  });

  it("returns null only for an empty path", () => {
    expect(pointOnPathAtX([], 5)).toBeNull();
    expect(pointOnPathAtX([{ x: 3, y: 7 }], 5)).toBe(7);
  });
});

function berth(overrides: Partial<BerthElement> = {}): BerthElement {
  return {
    id: "b1",
    layerId: "l1",
    zIndex: 0,
    type: "berth",
    x: 40,
    y: 10,
    width: 40,
    height: 20,
    textAlign: "center",
    fontSize: 12,
    displayName: "B1",
    ...overrides,
  } as BerthElement;
}

const track: MapElement = {
  id: "trk",
  layerId: "l1",
  zIndex: 0,
  type: "trackPath",
  points: [
    { x: 0, y: 100 },
    { x: 400, y: 100 },
  ],
};

describe("berthRenderRect", () => {
  it("centres a berth vertically on its explicitly bound track", () => {
    const rect = berthRenderRect(berth({ trackElementId: "trk" }), { trk: track });
    // track y = 100, berth height 20 -> top at 90, so the box centre lands on the rail
    expect(rect).toEqual({ x: 40, y: 90, width: 40, height: 20 });
  });

  it("falls back to the nearest horizontal track when trackElementId is absent", () => {
    const rect = berthRenderRect(berth({ y: 96 }), { trk: track });
    expect(rect.y).toBe(90);
  });

  it("leaves an unbound berth with no track in range exactly as authored", () => {
    expect(berthRenderRect(berth({ y: 500 }), { trk: track })).toEqual({
      x: 40,
      y: 500,
      width: 40,
      height: 20,
    });
    expect(berthRenderRect(berth(), {})).toEqual({ x: 40, y: 10, width: 40, height: 20 });
  });

  it("ignores a diagonal transition segment as a centring host", () => {
    const diagonal: MapElement = {
      id: "diag",
      layerId: "l1",
      zIndex: 0,
      type: "trackPath",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 200 },
      ],
    };
    // only a steep diagonal in range, no horizontal line -> authored geometry kept
    expect(berthRenderRect(berth({ y: 90 }), { diag: diagonal }).y).toBe(90);
  });

  it("accepts a Map lookup as well as a plain record", () => {
    const rect = berthRenderRect(berth({ trackElementId: "trk" }), new Map([["trk", track]]));
    expect(rect.y).toBe(90);
  });

  it("works through the real schema parse (defaults applied)", () => {
    const doc = MapDocumentSchema.parse({
      schemaVersion: 1,
      map: {
        id: "m",
        name: "M",
        canvas: { width: 500, height: 200, gridSize: 10 },
        timezone: "Europe/London",
      },
      layers: [{ id: "l1", name: "Track", order: 0 }],
      elements: [
        {
          id: "trk",
          layerId: "l1",
          type: "trackPath",
          points: [
            { x: 0, y: 100 },
            { x: 400, y: 100 },
          ],
        },
        {
          id: "b1",
          layerId: "l1",
          type: "berth",
          x: 40,
          y: 10,
          width: 40,
          height: 20,
          displayName: "B1",
          trackElementId: "trk",
        },
      ],
      topology: { nodes: [], edges: [] },
      bindings: [],
      editorMetadata: {},
    });
    const byId = Object.fromEntries(doc.elements.map((e) => [e.id, e]));
    const b = doc.elements.find((e) => e.id === "b1") as BerthElement;
    expect(berthRenderRect(b, byId).y).toBe(90);
  });
});

describe("neutralSectionGeometry", () => {
  // Every number here is read straight off Sign AJ02 Issue 1's own 600x600 drawing (RSSB, June
  // 2015), so the test fails if the symbol ever drifts from the real board. Rendering at size
  // 600 makes each computed value the drawing's dimension exactly.
  const atFullSize = neutralSectionGeometry({
    x: 300,
    y: 300,
    size: 600,
    fontSize: 40,
    labelPosition: "below",
  });

  it("reproduces the AJ02 board at the sign's own dimensions", () => {
    expect(atFullSize.board).toEqual({ x: 0, y: 0, width: 600, height: 600, rx: 30 });
  });

  it("reproduces the AJ02 symbol: two 70-wide bars 60 apart, each with an outward 80-tall arm", () => {
    expect(atFullSize.bars).toEqual([
      { x: 200, y: 40, width: 70, height: 520 },
      { x: 330, y: 40, width: 70, height: 520 },
      // The arms run *outward* from their own bar, to 50 from each board edge.
      { x: 50, y: 260, width: 220, height: 80 },
      { x: 330, y: 260, width: 220, height: 80 },
    ]);
  });

  it("treats x/y as the centre of the board, so size scales about the placed point", () => {
    const small = neutralSectionGeometry({
      x: 100,
      y: 50,
      size: 20,
      fontSize: 10,
      labelPosition: "below",
    });
    expect(small.board).toEqual({ x: 90, y: 40, width: 20, height: 20, rx: 1 });
    const bigger = neutralSectionGeometry({
      x: 100,
      y: 50,
      size: 40,
      fontSize: 10,
      labelPosition: "below",
    });
    expect(bigger.board.x + bigger.board.width / 2).toBe(100);
    expect(bigger.board.y + bigger.board.height / 2).toBe(50);
  });

  it("places a detached label at its offset from the board centre, ignoring labelPosition", () => {
    // Owner request 2026-09-20. The offset is relative to x/y, so the label travels with the
    // sign rather than being pinned to an absolute point on the canvas.
    const detached = neutralSectionGeometry({
      x: 100,
      y: 50,
      size: 20,
      fontSize: 10,
      labelPosition: "below",
      labelOffset: { x: -35, y: -15 },
    });
    expect(detached.label).toEqual({ x: 65, y: 35, anchor: "middle" });

    // Moving the sign moves the label with it, offset unchanged.
    const moved = neutralSectionGeometry({
      x: 140,
      y: 50,
      size: 20,
      fontSize: 10,
      labelPosition: "below",
      labelOffset: { x: -35, y: -15 },
    });
    expect(moved.label.x - moved.board.x).toBe(detached.label.x - detached.board.x);
  });

  it("leaves the board and symbol untouched when the label is detached", () => {
    const base = { x: 100, y: 50, size: 20, fontSize: 10, labelPosition: "below" } as const;
    const attached = neutralSectionGeometry(base);
    const detached = neutralSectionGeometry({ ...base, labelOffset: { x: 40, y: 0 } });
    expect(detached.board).toEqual(attached.board);
    expect(detached.bars).toEqual(attached.bars);
  });

  it("anchors the label on the chosen side of the board", () => {
    const base = { x: 100, y: 50, size: 20, fontSize: 10 } as const;
    expect(neutralSectionGeometry({ ...base, labelPosition: "below" })).toMatchObject({
      label: { x: 100, anchor: "middle" },
    });
    expect(neutralSectionGeometry({ ...base, labelPosition: "below" }).label.y).toBeGreaterThan(60);
    expect(neutralSectionGeometry({ ...base, labelPosition: "above" }).label.y).toBeLessThan(40);
    expect(neutralSectionGeometry({ ...base, labelPosition: "left" }).label).toEqual({
      x: 86,
      y: 53.5,
      anchor: "end",
    });
    expect(neutralSectionGeometry({ ...base, labelPosition: "right" }).label).toEqual({
      x: 114,
      y: 53.5,
      anchor: "start",
    });
  });
});
