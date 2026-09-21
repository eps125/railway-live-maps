import type { BerthElement, MapElement, TrackPathElement } from "./document.js";
import { MAP_STYLE } from "./style.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ElementLookup = Record<string, MapElement> | ReadonlyMap<string, MapElement>;

function lookup(source: ElementLookup, id: string): MapElement | undefined {
  return source instanceof Map ? source.get(id) : (source as Record<string, MapElement>)[id];
}

function values(source: ElementLookup): MapElement[] {
  return source instanceof Map
    ? [...source.values()]
    : Object.values(source as Record<string, MapElement>);
}

/**
 * `y` of a polyline at a given `x`, by linear interpolation between the two bracketing
 * vertices. Returns `null` only for an empty path. When `x` is beyond both ends the value is
 * clamped to the nearer endpoint's `y` (a berth just off the end of its track segment still
 * lands on the line's level rather than snapping away). Segment order is assumed left-to-right
 * for the common near-horizontal running line; a vertical sub-segment returns its midpoint `y`.
 */
export function pointOnPathAtX(
  points: ReadonlyArray<{ x: number; y: number }>,
  x: number,
): number | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0]!.y;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    if (x >= lo && x <= hi) {
      if (b.x === a.x) return (a.y + b.y) / 2;
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  return Math.abs(x - first.x) <= Math.abs(x - last.x) ? first.y : last.y;
}

/** A track segment counts as "horizontal enough" to host a berth if its whole vertical extent
 * fits inside one row pitch — i.e. it is a running line, not a diagonal transition. */
function isHorizontalish(points: ReadonlyArray<{ x: number; y: number }>): boolean {
  const ys = points.map((p) => p.y);
  return Math.max(...ys) - Math.min(...ys) <= MAP_STYLE.rowPitch;
}

/**
 * D1 (ADR 0004): the on-screen rectangle for a berth.
 *
 * A berth's authored `y` is a grid-snapped top-left coordinate with no enforced relationship
 * to any track, which is why berths currently sit off-centre on the rail. When the berth is
 * bound to a track — explicitly via `trackElementId`, or failing that the nearest horizontal
 * `trackPath` whose line passes close to the berth centre — its box is re-centred vertically on
 * that line at the berth's horizontal midpoint. An unbound berth (or one with no track in
 * range) keeps its authored geometry exactly.
 *
 * Pure and derived at render time: no document mutation, no migration, and an already-published
 * map self-corrects because `trackElementId` is already in the compiled bundle. Shared by the
 * public SVG renderer and the editor canvas so both agree (CLAUDE.md rule 13).
 */
export function berthRenderRect(berth: BerthElement, elements: ElementLookup): Rect {
  const authored: Rect = { x: berth.x, y: berth.y, width: berth.width, height: berth.height };
  const cx = berth.x + berth.width / 2;

  let track: TrackPathElement | undefined;

  if (berth.trackElementId) {
    const el = lookup(elements, berth.trackElementId);
    if (el?.type === "trackPath") track = el;
  }

  if (!track) {
    const cy = berth.y + berth.height / 2;
    let best: { el: TrackPathElement; dist: number } | undefined;
    for (const el of values(elements)) {
      if (el.type !== "trackPath" || !isHorizontalish(el.points)) continue;
      const ty = pointOnPathAtX(el.points, cx);
      if (ty === null) continue;
      const dist = Math.abs(ty - cy);
      if (dist <= MAP_STYLE.weldTolerance * 3 && (!best || dist < best.dist)) {
        best = { el, dist };
      }
    }
    track = best?.el;
  }

  if (!track) return authored;

  const trackY = pointOnPathAtX(track.points, cx);
  if (trackY === null) return authored;

  return { x: berth.x, y: trackY - berth.height / 2, width: berth.width, height: berth.height };
}

/** Where a placed label sits. `anchor` is SVG `text-anchor` vocabulary (Konva's equivalent is
 * `align`); `y` is an alphabetic baseline, matching every other text in both renderers. */
export interface PlacedLabel {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

/** The label half of any piece of map furniture (see `placedLabelFields` in document.ts). */
export interface PlacedLabelFields {
  labelPosition: "above" | "below" | "left" | "right";
  labelOffset?: { x: number; y: number } | undefined;
  fontSize: number;
}

/** Axis-aligned bounding box of a point list — the shape a polygon/polyline label anchors to. */
export function pointsBounds(points: ReadonlyArray<{ x: number; y: number }>): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * Milestone 55: where a piece of map furniture's caption goes, for **any** shape — generalised
 * from the neutral-section-only version added 2026-09-20 so `tunnel`, `viaduct`, `water` and
 * `levelCrossing` all place their labels by the same rule.
 *
 * Attached: just outside `bounds` on the chosen side. Detached (`labelOffset` set): centred on
 * that offset **from the centre of `bounds`**, so the label travels with its shape and
 * `labelPosition` no longer applies — the author placed it by hand.
 *
 * Pure and shared by the public SVG renderer and the editor canvas, so a label sits in the same
 * spot in both (CLAUDE.md rule 13).
 */
export function placedLabelAnchor(bounds: Rect, label: PlacedLabelFields): PlacedLabel {
  const gap = MAP_STYLE.placedLabel.gap;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  if (label.labelOffset) {
    return {
      x: centerX + label.labelOffset.x,
      y: centerY + label.labelOffset.y,
      anchor: "middle",
    };
  }

  switch (label.labelPosition) {
    case "above":
      return { x: centerX, y: bounds.y - gap, anchor: "middle" };
    case "left":
      return { x: bounds.x - gap, y: centerY + label.fontSize * 0.35, anchor: "end" };
    case "right":
      return {
        x: bounds.x + bounds.width + gap,
        y: centerY + label.fontSize * 0.35,
        anchor: "start",
      };
    default:
      return {
        x: centerX,
        y: bounds.y + bounds.height + gap + label.fontSize * 0.8,
        anchor: "middle",
      };
  }
}

export interface NeutralSectionGeometry {
  /** The white board itself. `rx` is the AJ02 corner radius scaled to this board. */
  board: Rect & { rx: number };
  /** The four black rectangles making up the symbol, in paint order: left vertical bar, right
   * vertical bar, left (outward) arm, right (outward) arm. They are drawn as separate rects
   * rather than one path because both renderers can express a rect natively. */
  bars: Rect[];
  /** Where the optional label goes — `placedLabelAnchor` over the board's own rect, so a sign's
   * caption follows the same rule as every other piece of map furniture's. */
  label: PlacedLabel;
}

/**
 * Milestone 53: the on-screen geometry of a `neutralSection` sign, built from Sign AJ02 Issue
 * 1's own dimensions (see `MAP_STYLE.neutralSection`). The element's `x`/`y` is the **centre**
 * of the board — unlike a berth's top-left — so changing `size` grows the sign evenly about the
 * point the author placed.
 *
 * Pure, derived at render time, and shared by the public SVG renderer and the editor canvas so
 * a sign sits and scales identically in both (CLAUDE.md rule 13). Nothing here is bound to live
 * data: a neutral section is authored map furniture with no operational state at all.
 */
export function neutralSectionGeometry(element: {
  x: number;
  y: number;
  size: number;
  fontSize: number;
  labelPosition: "above" | "below" | "left" | "right";
  labelOffset?: { x: number; y: number } | undefined;
}): NeutralSectionGeometry {
  const s = MAP_STYLE.neutralSection;
  const size = element.size;
  const left = element.x - size / 2;
  const top = element.y - size / 2;

  const barWidth = size * s.barWidth;
  const barGap = size * s.barGap;
  const barTop = top + size * s.barInsetY;
  const barHeight = size - 2 * (size * s.barInsetY);
  const leftBarX = element.x - (2 * barWidth + barGap) / 2;
  const rightBarX = leftBarX + barWidth + barGap;

  const armHeight = size * s.armHeight;
  const armTop = element.y - armHeight / 2;
  const armInset = size * s.armInsetX;
  const leftArmX = left + armInset;
  const rightArmEnd = left + size - armInset;

  const board: Rect = { x: left, y: top, width: size, height: size };

  return {
    board: { ...board, rx: size * s.cornerRadius },
    bars: [
      { x: leftBarX, y: barTop, width: barWidth, height: barHeight },
      { x: rightBarX, y: barTop, width: barWidth, height: barHeight },
      { x: leftArmX, y: armTop, width: leftBarX + barWidth - leftArmX, height: armHeight },
      { x: rightBarX, y: armTop, width: rightArmEnd - rightBarX, height: armHeight },
    ],
    label: placedLabelAnchor(board, element),
  };
}

/** A viaduct's deck width: the author's value, or the default derived from the track stroke for
 * one authored before `width` existed (CLAUDE.md rule 11 — published versions are immutable, so
 * old documents must keep rendering unchanged). */
export function viaductWidth(element: { width?: number | undefined }): number {
  return element.width ?? MAP_STYLE.track.strokeWidth + MAP_STYLE.viaduct.extraWidth;
}

/**
 * Owner request 2026-09-20: set a tunnel's width — the extent across the bore — numerically
 * instead of dragging corners. Scales the outline about its own centre, so its length and
 * position are untouched; for the rectangle a tunnel starts as, that is exactly "make the bore
 * this many units wide".
 *
 * `axis` says which extent the width refers to: a tunnel traced along a horizontal track is
 * `"y"` (the common case on a schematic), one down a vertical track is `"x"`. A degenerate
 * extent (a perfectly flat outline) is returned unchanged rather than divided by zero.
 */
export function scaleShapeWidth(
  points: ReadonlyArray<{ x: number; y: number }>,
  width: number,
  axis: "x" | "y" = "y",
): Array<{ x: number; y: number }> {
  const bounds = pointsBounds(points);
  const current = axis === "y" ? bounds.height : bounds.width;
  if (current <= 0) return points.map((point) => ({ ...point }));
  const centre = axis === "y" ? bounds.y + bounds.height / 2 : bounds.x + bounds.width / 2;
  const factor = width / current;
  return points.map((point) =>
    axis === "y"
      ? { x: point.x, y: centre + (point.y - centre) * factor }
      : { x: centre + (point.x - centre) * factor, y: point.y },
  );
}

/** A level crossing's barrier position. `blank` = unbound, or the bound bit isn't currently
 * trustworthy — never a guess (ADR 0014).
 *
 * Deliberately mirrors `@railway/domain`'s identically-named type rather than importing it:
 * map-schema describes the *document* and must not depend on the state layer (the same reason
 * `apps/web`'s `SignalState` restates domain's). They are the same literal union, so the two
 * stay assignable and a drift would fail to compile at the API boundary that joins them. */
export type BarrierDisplayState = "blank" | "up" | "down";

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LevelCrossingGeometry {
  /** The two road edges, drawn across the track. */
  road: [Segment, Segment];
  /** One barrier each side of the track, always drawn **parallel to the railway** (owner
   * preference 2026-09-20 — the earlier perpendicular arm read wrong on a schematic). State
   * changes their colour, not their geometry, and `blank` still draws them grey so an unbound
   * crossing reads as a crossing rather than disappearing. */
  barriers: [Segment, Segment];
  /** Bounds the label anchors against (the road's full extent). */
  bounds: Rect;
  label: PlacedLabel;
}

/**
 * Milestone 55: the on-screen geometry of a level crossing at `orientation` degrees, where 0 is
 * "road square across a horizontal track". Pure, and shared by the public SVG renderer and the
 * editor canvas so a crossing looks the same in both (CLAUDE.md rule 13).
 *
 * `barrierState` moves the two arms about their posts; it never changes the road. The state
 * itself comes from the bound S-Class bit and nowhere else (rule 10).
 */
export function levelCrossingGeometry(
  element: {
    x: number;
    y: number;
    orientation: number;
    roadLength: number;
    roadWidth: number;
  } & PlacedLabelFields,
  barrierState: BarrierDisplayState = "blank",
): LevelCrossingGeometry {
  const style = MAP_STYLE.levelCrossing;
  const theta = (element.orientation * Math.PI) / 180;
  // `road` runs across the track; `along` runs with it. At orientation 0 that is (0,1) and (1,0).
  const road = { x: Math.sin(theta), y: Math.cos(theta) };
  const along = { x: Math.cos(theta), y: -Math.sin(theta) };

  const halfLength = element.roadLength / 2;
  const halfWidth = element.roadWidth / 2;
  const edge = (side: 1 | -1): Segment => ({
    x1: element.x + along.x * halfWidth * side - road.x * halfLength,
    y1: element.y + along.y * halfWidth * side - road.y * halfLength,
    x2: element.x + along.x * halfWidth * side + road.x * halfLength,
    y2: element.y + along.y * halfWidth * side + road.y * halfLength,
  });

  // Two half-barriers on diagonally opposite posts, as a real pair is arranged: each post sits
  // on one side of the railway, at one edge of the road. Owner design 2026-09-20:
  //
  //   up    - parked along the road edge, pointing away from the railway (perpendicular to the
  //           track), so a raised pair frames the crossing rather than sitting in the middle of
  //           it. Only ever shown for a crossing bound to an S-Class bit.
  //   down  - swung 90 degrees about the same post, lying across the road (parallel to the
  //           track) to block it. The two halves meet in the middle.
  //   blank - an unbound crossing, or a bit not currently trustworthy. Drawn in the lowered
  //           geometry but grey: parallel to the track, which is what the owner asked an
  //           unmapped crossing to look like. Grey means "no information", never "up".
  const pivotDistance = element.roadLength * style.barrierDistance;
  const arm = (side: 1 | -1): Segment => {
    const px = element.x + road.x * pivotDistance * side + along.x * halfWidth * side;
    const py = element.y + road.y * pivotDistance * side + along.y * halfWidth * side;
    const reach =
      barrierState === "up"
        ? { x: road.x * element.roadWidth * side, y: road.y * element.roadWidth * side }
        : { x: -along.x * element.roadWidth * side, y: -along.y * element.roadWidth * side };
    return { x1: px, y1: py, x2: px + reach.x, y2: py + reach.y };
  };

  const corners = [edge(1), edge(-1)].flatMap((segment) => [
    { x: segment.x1, y: segment.y1 },
    { x: segment.x2, y: segment.y2 },
  ]);
  const bounds = pointsBounds(corners);

  return {
    road: [edge(1), edge(-1)],
    barriers: [arm(1), arm(-1)],
    bounds,
    label: placedLabelAnchor(bounds, element),
  };
}

export interface RealisticBarrierGeometry {
  /** The lowered arm, post to tip — the same line `levelCrossingGeometry` gives a `down` arm. */
  arm: Segment;
  /** Length of each red or white band. Divides the arm into an odd number of bands, so a renderer
   * drawing a white arm with red dashes of this length over it gets red at both ends. */
  bandLength: number;
  /** The skirt's bottom rail, parallel to the arm. */
  skirtRail: Segment;
  /** Vertical pickets from the underside of the arm down to the rail. */
  pickets: Segment[];
  /** The barrier's post, at the road edge. */
  post: { x: number; y: number };
}

export interface RealisticLevelCrossingGeometry {
  /** Asphalt on each approach, from the barrier outwards to the road's end. Deliberately **not**
   * filled between the barriers: that span is the railway, and a crossing paints above the rails
   * (it sits on the Track layer at zIndex 0), so a solid road there would hide the running line.
   * Leaving it open keeps every track through the crossing visible, double track included,
   * without splitting one element across two paint layers. */
  surfaces: [Array<{ x: number; y: number }>, Array<{ x: number; y: number }>];
  /** The white centreline on each approach, stopping at the barrier for the same reason. */
  centreline: [Segment, Segment];
  barriers: [RealisticBarrierGeometry, RealisticBarrierGeometry];
}

/**
 * The realistic drawing of a level crossing — asphalt approaches with a white centreline, and a
 * red/white banded arm on each side of the railway with a white picket skirt. Pure, and shared by
 * the public SVG renderer and the editor canvas (CLAUDE.md rule 13).
 *
 * Milestone 58 introduced it as a lowered-only drawing for unbound crossings; Milestone 59 (owner
 * decision 2026-09-21) made it the default for every crossing and added the raised pose, so it now
 * shows a bound crossing's live position too. `pose` is the *drawn* pose, not the state: the
 * renderer maps `up` to raised and both `down` and `blank` (unknown, or an unbound crossing) to
 * lowered — the owner chose to draw an unknown crossing lowered, in full colour.
 *
 * - **Lowered:** exactly where `levelCrossingGeometry` puts a `down` arm, across the road.
 * - **Raised:** swung 90 degrees about the same post to stand upright on screen, both barriers
 *   pointing up — even where that crosses the track (owner, 2026-09-21) — with the skirt folded
 *   tight against the arm, as a real hinged skirt folds when the boom rises.
 *
 * Viewed from a slight angle rather than strictly top down (owner: "happy for crossings to look
 * like they're viewed from an angle"), which is what lets the skirt read as a fence hanging
 * *below* the arm. "Below" is the arm's perpendicular on the screen-downward side, so a lowered
 * crossing at the usual orientation 0 — arms horizontal — shows its skirts hanging straight down,
 * like the reference photos, and any other orientation still gets a sensible skirt rather than one
 * that collapses onto its own arm.
 */
export function realisticLevelCrossingGeometry(
  element: {
    x: number;
    y: number;
    orientation: number;
    roadLength: number;
    roadWidth: number;
  },
  pose: "down" | "up" = "down",
): RealisticLevelCrossingGeometry {
  const style = MAP_STYLE.levelCrossing;
  const look = style.realistic;
  const theta = (element.orientation * Math.PI) / 180;
  const road = { x: Math.sin(theta), y: Math.cos(theta) };
  const along = { x: Math.cos(theta), y: -Math.sin(theta) };
  const halfLength = element.roadLength / 2;
  const halfWidth = element.roadWidth / 2;
  const pivotDistance = element.roadLength * style.barrierDistance;
  const skirtDepth = pose === "up" ? look.foldedSkirtDepth : look.skirtDepth;

  // A point `r` out from the crossing's centre across the track, and `a` along it.
  const at = (r: number, a: number): { x: number; y: number } => ({
    x: element.x + road.x * r + along.x * a,
    y: element.y + road.y * r + along.y * a,
  });

  const surface = (side: 1 | -1): Array<{ x: number; y: number }> => [
    at(pivotDistance * side, halfWidth),
    at(halfLength * side, halfWidth),
    at(halfLength * side, -halfWidth),
    at(pivotDistance * side, -halfWidth),
  ];

  // Unit vector from a side's post to its arm's tip, for the drawn pose. Lowered is exactly
  // `levelCrossingGeometry`'s `down` arm. Raised stands **upright on screen** for both barriers
  // (owner, 2026-09-21: "the lower barrier ... needs to be +90 deg instead - it will cover the
  // track but that's okay") — the natural reading of a raised boom seen from an angle, unlike the
  // schematic `up`, which points each arm away from the railway. Only a road running exactly
  // horizontally on screen (orientation ±90) has no "up" along it; that falls back to the
  // schematic away-from-the-railway direction.
  const armDirection = (side: 1 | -1): { x: number; y: number } => {
    if (pose === "down") return { x: -along.x * side, y: -along.y * side };
    if (Math.abs(road.y) > 1e-9) return road.y < 0 ? road : { x: -road.x, y: -road.y };
    return { x: road.x * side, y: road.y * side };
  };

  // The way a side's skirt hangs: the arm's perpendicular on the screen-downward side, with a tie
  // (a vertical arm) broken toward +x.
  const skirtDirection = (side: 1 | -1): { x: number; y: number } => {
    // A raised boom's folded skirt faces the carriageway — the side the arm lay across before it
    // rose — for both barriers (owner, 2026-09-21: the lower one had it on the wrong side).
    if (pose === "up") return { x: -along.x * side, y: -along.y * side };
    const dir = armDirection(side);
    const down = { x: -dir.y, y: dir.x };
    return down.y < -1e-9 || (Math.abs(down.y) <= 1e-9 && down.x < 0)
      ? { x: -down.x, y: -down.y }
      : down;
  };

  const centreline = (side: 1 | -1): Segment => {
    // A lowered arm lies across the road, so where its skirt hangs out over this side's approach
    // (rather than back toward the railway) start the line beyond it: otherwise the white line
    // shows between the pickets and reads as a stray, thicker picket. A raised arm lies along the
    // road edge, off the carriageway, so the line runs right up to the barrier line.
    let start = pivotDistance;
    if (pose === "down") {
      const down = skirtDirection(side);
      const outward = (down.x * road.x + down.y * road.y) * side * (look.armWidth / 2 + skirtDepth);
      if (outward > 0) start = pivotDistance + outward + look.centrelineGap;
    }
    const from = at(Math.min(halfLength, start) * side, 0);
    const to = at(halfLength * side, 0);
    return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  };

  const barrier = (side: 1 | -1): RealisticBarrierGeometry => {
    // The post is where `levelCrossingGeometry` pivots both poses, so switching between the
    // schematic and realistic styles, or between up and down, never moves the barrier.
    const post = at(pivotDistance * side, halfWidth * side);
    const length = element.roadWidth;
    const dir = armDirection(side);
    const tip = { x: post.x + dir.x * length, y: post.y + dir.y * length };
    const down = skirtDirection(side);

    const bands = Math.max(3, 2 * Math.round((length / look.bandLength - 1) / 2) + 1);
    const pointAt = (t: number): { x: number; y: number } => ({
      x: post.x + dir.x * length * t,
      y: post.y + dir.y * length * t,
    });
    const start = pointAt(look.skirtStart);
    const end = pointAt(look.skirtEnd);
    const top = look.armWidth / 2;
    const bottom = top + skirtDepth;
    const skirtLength = length * (look.skirtEnd - look.skirtStart);
    const count = Math.max(2, Math.floor(skirtLength / look.picketSpacing) + 1);
    const pickets: Segment[] = [];
    for (let i = 0; i < count; i += 1) {
      const p = pointAt(look.skirtStart + ((look.skirtEnd - look.skirtStart) * i) / (count - 1));
      pickets.push({
        x1: p.x + down.x * top,
        y1: p.y + down.y * top,
        x2: p.x + down.x * bottom,
        y2: p.y + down.y * bottom,
      });
    }

    return {
      arm: { x1: post.x, y1: post.y, x2: tip.x, y2: tip.y },
      bandLength: length / bands,
      skirtRail: {
        x1: start.x + down.x * bottom,
        y1: start.y + down.y * bottom,
        x2: end.x + down.x * bottom,
        y2: end.y + down.y * bottom,
      },
      pickets,
      post,
    };
  };

  return {
    surfaces: [surface(1), surface(-1)],
    centreline: [centreline(1), centreline(-1)],
    barriers: [barrier(1), barrier(-1)],
  };
}
