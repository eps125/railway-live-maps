import { describe, expect, it } from "vitest";
import { MAP_STYLE } from "./style.js";
import {
  berthRenderRect,
  levelCrossingGeometry,
  neutralSectionGeometry,
  placedLabelAnchor,
  realisticLevelCrossingGeometry,
  pointOnPathAtX,
  pointsBounds,
  scaleShapeWidth,
  switchedDiamondGeometry,
  viaductWidth,
} from "./geometry.js";
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

describe("pointsBounds", () => {
  it("is the axis-aligned box of every vertex, in any winding order", () => {
    expect(
      pointsBounds([
        { x: 30, y: 10 },
        { x: 10, y: 40 },
        { x: 50, y: 25 },
      ]),
    ).toEqual({ x: 10, y: 10, width: 40, height: 30 });
  });

  it("is a degenerate box for an empty list rather than Infinity", () => {
    expect(pointsBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("placedLabelAnchor", () => {
  // Milestone 55: generalised from the neutral-section-only version, so every piece of map
  // furniture anchors its caption the same way against its own bounds.
  const bounds = { x: 100, y: 50, width: 40, height: 20 };
  const base = { fontSize: 10 } as const;

  it("puts an attached label just outside the chosen side", () => {
    expect(placedLabelAnchor(bounds, { ...base, labelPosition: "above" })).toEqual({
      x: 120,
      y: 46,
      anchor: "middle",
    });
    expect(placedLabelAnchor(bounds, { ...base, labelPosition: "below" })).toEqual({
      x: 120,
      y: 82,
      anchor: "middle",
    });
    expect(placedLabelAnchor(bounds, { ...base, labelPosition: "left" })).toEqual({
      x: 96,
      y: 63.5,
      anchor: "end",
    });
    expect(placedLabelAnchor(bounds, { ...base, labelPosition: "right" })).toEqual({
      x: 144,
      y: 63.5,
      anchor: "start",
    });
  });

  it("measures a detached label from the centre of the bounds and ignores labelPosition", () => {
    const detached = placedLabelAnchor(bounds, {
      ...base,
      labelPosition: "below",
      labelOffset: { x: -30, y: -25 },
    });
    // centre is (120, 60)
    expect(detached).toEqual({ x: 90, y: 35, anchor: "middle" });
  });

  it("keeps a detached label with its shape when the shape moves", () => {
    const offset = { x: -30, y: -25 };
    const moved = placedLabelAnchor(
      { ...bounds, x: bounds.x + 200 },
      { ...base, labelPosition: "below", labelOffset: offset },
    );
    expect(moved.x).toBe(90 + 200);
    expect(moved.y).toBe(35);
  });
});

describe("viaductWidth", () => {
  it("uses the author's width when set", () => {
    expect(viaductWidth({ width: 24 })).toBe(24);
  });

  it("falls back to the track-derived default for a viaduct authored before width existed", () => {
    // CLAUDE.md rule 11: published versions are immutable, so an old document must keep
    // rendering exactly as it did rather than collapsing to a zero-width deck.
    expect(viaductWidth({})).toBe(MAP_STYLE.track.strokeWidth + MAP_STYLE.viaduct.extraWidth);
    expect(viaductWidth({ width: undefined })).toBe(
      MAP_STYLE.track.strokeWidth + MAP_STYLE.viaduct.extraWidth,
    );
  });
});

describe("scaleShapeWidth", () => {
  // A tunnel starts as a rectangle traced along the track; "width" is its extent across the bore.
  const rect = [
    { x: 100, y: 40 },
    { x: 200, y: 40 },
    { x: 200, y: 60 },
    { x: 100, y: 60 },
  ];

  it("sets the across-track extent and leaves length and centre untouched", () => {
    const wider = scaleShapeWidth(rect, 40);
    const bounds = pointsBounds(wider);
    expect(bounds.height).toBe(40);
    // Length unchanged, and it grew about its own centre rather than one edge.
    expect(bounds.width).toBe(100);
    expect(bounds.x).toBe(100);
    expect(bounds.y + bounds.height / 2).toBe(50);
  });

  it("narrows as well as widens", () => {
    expect(pointsBounds(scaleShapeWidth(rect, 5)).height).toBe(5);
  });

  it("can scale the other axis for a tunnel traced down a vertical track", () => {
    const bounds = pointsBounds(scaleShapeWidth(rect, 50, "x"));
    expect(bounds.width).toBe(50);
    expect(bounds.height).toBe(20);
    expect(bounds.x + bounds.width / 2).toBe(150);
  });

  it("returns a flat outline unchanged instead of dividing by zero", () => {
    const flat = [
      { x: 0, y: 10 },
      { x: 50, y: 10 },
    ];
    expect(scaleShapeWidth(flat, 20)).toEqual(flat);
  });
});

describe("levelCrossingGeometry barriers (owner design 2026-09-20)", () => {
  const crossing = {
    x: 100,
    y: 50,
    orientation: 0,
    roadLength: 34,
    roadWidth: 16,
    labelPosition: "below" as const,
    fontSize: 10,
  };

  function lengthOf(segment: { x1: number; y1: number; x2: number; y2: number }): number {
    return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
  }

  it("posts the two half-barriers diagonally opposite, at the road edges", () => {
    const { barriers } = levelCrossingGeometry(crossing, "down");
    // Road edges are at x = 100 +/- roadWidth/2; the posts sit on opposite edges and opposite
    // sides of the railway, as a real half-barrier pair is arranged.
    expect([barriers[0].x1, barriers[1].x1]).toEqual([108, 92]);
    expect(barriers[0].y1).toBeGreaterThan(50);
    expect(barriers[1].y1).toBeLessThan(50);
  });

  it("lies the arms across the road, parallel to the track, when down", () => {
    const { barriers } = levelCrossingGeometry(crossing, "down");
    for (const barrier of barriers) expect(barrier.y1).toBe(barrier.y2);
  });

  it("parks the arms along the road edge, perpendicular to the track, when up", () => {
    const { barriers } = levelCrossingGeometry(crossing, "up");
    for (const barrier of barriers) {
      expect(barrier.x1).toBe(barrier.x2);
      // Pointing away from the railway, not across it.
      expect(Math.abs(barrier.y2 - 50)).toBeGreaterThan(Math.abs(barrier.y1 - 50));
    }
    // Parked at the road edges rather than the middle of the crossing.
    expect([barriers[0].x1, barriers[1].x1]).toEqual([108, 92]);
  });

  it("is a true rotation about the post: same length, same pivot, both states", () => {
    const up = levelCrossingGeometry(crossing, "up").barriers;
    const down = levelCrossingGeometry(crossing, "down").barriers;
    for (let i = 0; i < 2; i += 1) {
      expect(lengthOf(up[i]!)).toBeCloseTo(lengthOf(down[i]!), 6);
      expect([up[i]!.x1, up[i]!.y1]).toEqual([down[i]!.x1, down[i]!.y1]);
    }
  });

  it("draws an unmapped crossing in the lowered, track-parallel geometry", () => {
    // Owner preference: a crossing with no S-Class binding reads parallel to the track. It is
    // grey, not green — blank means no information, never "up" (ADR 0014 decision 1).
    const blank = levelCrossingGeometry(crossing, "blank").barriers;
    const down = levelCrossingGeometry(crossing, "down").barriers;
    expect(blank).toEqual(down);
  });

  it("rotates the whole crossing with orientation", () => {
    const turned = levelCrossingGeometry({ ...crossing, orientation: 90 }, "down");
    // Track now vertical, so a lowered arm lies vertically instead.
    for (const barrier of turned.barriers) expect(barrier.x1).toBeCloseTo(barrier.x2, 6);
  });
});

describe("realisticLevelCrossingGeometry (Milestone 58, owner request 2026-09-21)", () => {
  const crossing = { x: 100, y: 50, orientation: 0, roadLength: 34, roadWidth: 16 };
  const look = MAP_STYLE.levelCrossing.realistic;
  const pivot = crossing.roadLength * MAP_STYLE.levelCrossing.barrierDistance;

  function lengthOf(segment: { x1: number; y1: number; x2: number; y2: number }): number {
    return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
  }

  it("lowers each arm exactly where the schematic drawing puts a down barrier", () => {
    // Ticking the box restyles the barrier the author already placed; it never moves it.
    const schematic = levelCrossingGeometry(
      { ...crossing, labelPosition: "below", fontSize: 10 },
      "down",
    );
    const { barriers } = realisticLevelCrossingGeometry(crossing);
    expect(barriers.map((b) => b.arm)).toEqual(schematic.barriers);
  });

  it("draws the lowered pose by default", () => {
    // The editor canvas and every unknown or unbound crossing use this pose.
    expect(realisticLevelCrossingGeometry(crossing)).toEqual(
      realisticLevelCrossingGeometry(crossing, "down"),
    );
    for (const { arm } of realisticLevelCrossingGeometry(crossing).barriers) {
      expect(arm.y1).toBe(arm.y2);
    }
  });

  describe("raised pose (Milestone 59, owner 2026-09-21)", () => {
    const raised = realisticLevelCrossingGeometry(crossing, "up");

    it("swings each arm about the same post the lowered arm uses", () => {
      const lowered = realisticLevelCrossingGeometry(crossing, "down");
      for (let i = 0; i < 2; i += 1) {
        expect(raised.barriers[i]!.post).toEqual(lowered.barriers[i]!.post);
        expect(lengthOf(raised.barriers[i]!.arm)).toBeCloseTo(
          lengthOf(lowered.barriers[i]!.arm),
          6,
        );
      }
    });

    it("stands BOTH arms upright on screen, the lower one crossing the track", () => {
      // Owner: "the lower barrier ... needs to be +90 deg instead - it will cover the track but
      // that's okay".
      for (const { arm } of raised.barriers) {
        expect(arm.x1).toBeCloseTo(arm.x2, 6);
        expect(arm.y2).toBeLessThan(arm.y1);
      }
      const lower = raised.barriers.find((b) => b.post.y > crossing.y)!;
      expect(lower.arm.y2).toBeLessThan(crossing.y);
    });

    it("folds each skirt toward the carriageway, on both barriers", () => {
      // Owner: the lower barrier's folded skirt was on the wrong side.
      for (const { post, pickets } of raised.barriers) {
        for (const picket of pickets) {
          expect(Math.abs(picket.x2 - crossing.x)).toBeLessThan(Math.abs(post.x - crossing.x));
        }
      }
    });

    it("folds the skirt shallow against a raised arm", () => {
      for (const { pickets } of raised.barriers) {
        for (const picket of pickets) {
          expect(lengthOf(picket)).toBeCloseTo(look.foldedSkirtDepth, 6);
        }
      }
    });

    it("runs each centreline right up to the barrier line — the road is open", () => {
      for (const line of raised.centreline) {
        expect(Math.abs(line.y1 - crossing.y)).toBeCloseTo(pivot, 6);
      }
    });

    it("falls back to away-from-the-railway on a road with no screen 'up' (orientation 90)", () => {
      const turned = realisticLevelCrossingGeometry({ ...crossing, orientation: 90 }, "up");
      const tips = turned.barriers.map((b) => Math.sign(b.arm.x2 - b.post.x));
      expect(new Set(tips).size).toBe(2);
    });
  });

  it("divides each arm into an odd number of bands, so both ends are red as on a real barrier", () => {
    for (const roadWidth of [8, 16, 23, 40]) {
      for (const { arm, bandLength } of realisticLevelCrossingGeometry({ ...crossing, roadWidth })
        .barriers) {
        const bands = lengthOf(arm) / bandLength;
        expect(bands).toBeCloseTo(Math.round(bands), 6);
        expect(Math.round(bands) % 2).toBe(1);
        expect(Math.round(bands)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("hangs both skirts straight down at the usual orientation, like the reference photos", () => {
    for (const { arm, pickets, skirtRail } of realisticLevelCrossingGeometry(crossing).barriers) {
      for (const picket of pickets) {
        expect(picket.x1).toBeCloseTo(picket.x2, 6);
        // Starts at the arm's underside, not its centre line, and hangs below it.
        expect(picket.y1).toBeCloseTo(arm.y1 + look.armWidth / 2, 6);
        expect(picket.y2).toBeCloseTo(arm.y1 + look.armWidth / 2 + look.skirtDepth, 6);
      }
      expect(skirtRail.y1).toBeCloseTo(arm.y1 + look.armWidth / 2 + look.skirtDepth, 6);
      expect(pickets.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("still gives a vertical arm a real skirt instead of one collapsed onto the arm", () => {
    // Orientation 90: the track runs vertically and so do the lowered arms. "Down" is then
    // ambiguous; the skirt must still stand off the arm, not lie along it.
    for (const { pickets } of realisticLevelCrossingGeometry({ ...crossing, orientation: 90 })
      .barriers) {
      for (const picket of pickets) {
        expect(Math.abs(picket.x2 - picket.x1)).toBeCloseTo(look.skirtDepth, 6);
        expect(picket.y1).toBeCloseTo(picket.y2, 6);
      }
    }
  });

  it("leaves the railway between the barriers unsurfaced, so the track stays visible", () => {
    // A crossing paints above the rails; a solid road there would hide the running line.
    const [a, b] = realisticLevelCrossingGeometry(crossing).surfaces;
    const nearestToTrack = (poly: Array<{ x: number; y: number }>) =>
      Math.min(...poly.map((p) => Math.abs(p.y - crossing.y)));
    expect(nearestToTrack(a)).toBeCloseTo(pivot, 6);
    expect(nearestToTrack(b)).toBeCloseTo(pivot, 6);
  });

  it("starts a centreline beyond a skirt that hangs out over its approach", () => {
    // Otherwise the white line shows between the pickets and reads as a stray picket.
    const [below, above] = realisticLevelCrossingGeometry(crossing).centreline;
    const skirtBottom = pivot + look.armWidth / 2 + look.skirtDepth;
    // Side +1 (below the track at orientation 0): its skirt hangs outward, over the approach.
    expect(below.y1 - crossing.y).toBeCloseTo(skirtBottom + look.centrelineGap, 6);
    // Side -1: its skirt hangs back toward the railway, so the line can start at the arm.
    expect(crossing.y - above.y1).toBeCloseTo(pivot, 6);
    for (const line of [below, above]) {
      expect(line.x1).toBe(crossing.x);
      expect(Math.abs(line.y2 - crossing.y)).toBeCloseTo(crossing.roadLength / 2, 6);
    }
  });

  it("rotates with the crossing", () => {
    const turned = realisticLevelCrossingGeometry({ ...crossing, orientation: 90 });
    for (const { arm } of turned.barriers) expect(arm.x1).toBeCloseTo(arm.x2, 6);
    for (const line of turned.centreline) expect(line.y1).toBeCloseTo(line.y2, 6);
  });
});

describe("switchedDiamondGeometry (Milestone 63, revised)", () => {
  // A horizontal line crossed by a 45° diagonal rising to the right, at (100, 50) — the owner's
  // Carlisle crossing shape.
  const horizontal = {
    points: [
      { x: 0, y: 50 },
      { x: 200, y: 50 },
    ],
  };
  const diagonal = {
    points: [
      { x: 50, y: 100 },
      { x: 150, y: 0 },
    ],
  };
  const tracks = [horizontal, diagonal];
  const L = MAP_STYLE.switchedDiamond.knuckleLength;
  const s = Math.SQRT1_2;

  it("finds the crossing from the drawn tracks, even from a marker placed a few units off", () => {
    const g = switchedDiamondGeometry({ x: 103, y: 47 }, tracks)!;
    expect(g.crossing.x).toBeCloseTo(100, 6);
    expect(g.crossing.y).toBeCloseTo(50, 6);
  });

  it("names the upward-opening obtuse corner a and the opposite one b", () => {
    const g = switchedDiamondGeometry({ x: 100, y: 50 }, tracks)!;
    // Upper-left: between the rail running left and the diagonal running up-right (135°).
    const [a1, a2] = g.corners.a;
    expect(a1.x * a2.x + a1.y * a2.y).toBeLessThan(0);
    expect(a1.y + a2.y).toBeLessThan(0);
    const [b1, b2] = g.corners.b;
    expect(b1.y + b2.y).toBeGreaterThan(0);
  });

  it("draws a filled knuckle in each switched corner by default", () => {
    const both = switchedDiamondGeometry({ x: 100, y: 50 }, tracks)!;
    expect(both.knuckles).toHaveLength(2);
    expect(both.ticks).toEqual([]);
    const oneSide = switchedDiamondGeometry({ x: 100, y: 50, corners: ["a"] }, tracks)!;
    expect(oneSide.knuckles).toHaveLength(1);
    const [c, p, q] = oneSide.knuckles[0]!;
    expect(c).toEqual({ x: 100, y: 50 });
    const tips = [p!, q!].map((t) => [Math.round(t.x * 100) / 100, Math.round(t.y * 100) / 100]);
    expect(tips).toContainEqual([100 - L, 50]);
    expect(tips).toContainEqual([
      Math.round((100 + L * s) * 100) / 100,
      Math.round((50 - L * s) * 100) / 100,
    ]);
  });

  it("draws two blade ticks per switched corner, beside each rail and inside the corner", () => {
    const g = switchedDiamondGeometry({ x: 100, y: 50, corners: ["b"], style: "ticks" }, tracks)!;
    expect(g.knuckles).toEqual([]);
    expect(g.ticks).toHaveLength(2);
    // Corner b is lower-right; the blade beside the horizontal rail runs along y = 50 + offset.
    const beside = g.ticks.find((t) => Math.abs(t.y1 - t.y2) < 1e-9)!;
    expect(beside.y1).toBeCloseTo(50 + MAP_STYLE.switchedDiamond.tickOffset, 6);
    expect(Math.min(beside.x1, beside.x2)).toBeCloseTo(100 + MAP_STYLE.switchedDiamond.tickFrom, 6);
  });

  it("fits any angle, taken from the tracks rather than set by hand", () => {
    const shallow = {
      points: [
        { x: 0, y: 100 },
        { x: 200, y: 0 },
      ],
    };
    const g = switchedDiamondGeometry({ x: 100, y: 50 }, [horizontal, shallow])!;
    const [u, v] = g.corners.a;
    const angle = (Math.acos(u.x * v.x + u.y * v.y) * 180) / Math.PI;
    expect(angle).toBeCloseTo(180 - (Math.atan(MAP_STYLE.diagonalSlope) * 180) / Math.PI, 6);
  });

  it("draws nothing when not on a crossing, and never treats a bend in one track as one", () => {
    expect(switchedDiamondGeometry({ x: 20, y: 50 }, tracks)).toBeNull();
    const bend = {
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 160, y: 30 },
      ],
    };
    expect(switchedDiamondGeometry({ x: 100, y: 0 }, [bend])).toBeNull();
  });

  it("parses a first-version rhombus as a knuckle on both corners", () => {
    const doc = MapDocumentSchema.parse({
      schemaVersion: 1,
      map: {
        id: "m",
        name: "M",
        canvas: { width: 500, height: 200, gridSize: 10 },
        timezone: "Europe/London",
      },
      layers: [{ id: "l", name: "Track", order: 0 }],
      elements: [
        {
          id: "d",
          layerId: "l",
          type: "switchedDiamond",
          x: 1,
          y: 2,
          orientation: 45,
          length: 20,
          width: 10,
        },
      ],
      topology: { nodes: [], edges: [] },
      bindings: [],
      editorMetadata: {},
    });
    expect(doc.elements[0]).toMatchObject({ corners: ["a", "b"], style: "knuckle" });
  });
});
