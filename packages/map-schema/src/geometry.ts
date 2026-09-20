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

export interface NeutralSectionGeometry {
  /** The white board itself. `rx` is the AJ02 corner radius scaled to this board. */
  board: Rect & { rx: number };
  /** The four black rectangles making up the symbol, in paint order: left vertical bar, right
   * vertical bar, left (outward) arm, right (outward) arm. They are drawn as separate rects
   * rather than one path because both renderers can express a rect natively. */
  bars: Rect[];
  /** Where the optional label goes, given `labelPosition`. `anchor` is SVG `text-anchor`
   * vocabulary; `y` is an alphabetic baseline, matching every other text in both renderers. */
  label: { x: number; y: number; anchor: "start" | "middle" | "end" };
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

  const gap = s.labelGap;
  const label =
    element.labelPosition === "above"
      ? { x: element.x, y: top - gap, anchor: "middle" as const }
      : element.labelPosition === "left"
        ? { x: left - gap, y: element.y + element.fontSize * 0.35, anchor: "end" as const }
        : element.labelPosition === "right"
          ? {
              x: left + size + gap,
              y: element.y + element.fontSize * 0.35,
              anchor: "start" as const,
            }
          : {
              x: element.x,
              y: top + size + gap + element.fontSize * 0.8,
              anchor: "middle" as const,
            };

  return {
    board: { x: left, y: top, width: size, height: size, rx: size * s.cornerRadius },
    bars: [
      { x: leftBarX, y: barTop, width: barWidth, height: barHeight },
      { x: rightBarX, y: barTop, width: barWidth, height: barHeight },
      { x: leftArmX, y: armTop, width: leftBarX + barWidth - leftArmX, height: armHeight },
      { x: rightBarX, y: armTop, width: rightArmEnd - rightBarX, height: armHeight },
    ],
    label,
  };
}
