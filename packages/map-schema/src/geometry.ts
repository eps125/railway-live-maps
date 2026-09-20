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
  /** One barrier each side of the track. Lying across the road when `down`, swung back parallel
   * to the railway when `up`; both are drawn in `blank` too, in grey, so an unbound crossing
   * still reads as a crossing rather than disappearing. */
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
 * `barrierState` only chooses which way the two barrier arms point; it never changes the road.
 * The state itself comes from the bound S-Class bit and nowhere else (rule 10).
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

  // A barrier pivots at the roadside, clear of the track on each side.
  const pivotDistance = element.roadLength * style.barrierDistance;
  const arm = (side: 1 | -1): Segment => {
    const px = element.x + road.x * pivotDistance * side;
    const py = element.y + road.y * pivotDistance * side;
    // Down: lying across the road (so, along the railway), blocking it. Up: swung back to lie
    // alongside the railway, pointing away from the track.
    const direction = barrierState === "down" ? along : road;
    const length = barrierState === "down" ? element.roadWidth : pivotDistance * 0.9;
    const reach = barrierState === "down" ? 1 : side;
    return {
      x1: px - (barrierState === "down" ? direction.x * length * 0.5 : 0),
      y1: py - (barrierState === "down" ? direction.y * length * 0.5 : 0),
      x2: px + direction.x * length * (barrierState === "down" ? 0.5 : reach),
      y2: py + direction.y * length * (barrierState === "down" ? 0.5 : reach),
    };
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
